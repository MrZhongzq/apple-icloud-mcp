import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { AppError } from '../core/errors.js';
import { encodeRef, encodeUrl, type ResourceRef } from '../core/ids.js';

/** 一个带类型/标签的值，对应 EMAIL / TEL / URL / IMPP 这类可重复属性。 */
export interface TypedValue {
  value: string;
  /** 归一化成小写的 TYPE 参数，例如 ['work','pref'] → ['work']；pref 单独提到 primary。 */
  type?: string[];
  /** Apple 的自定义标签，来自同 group 的 X-ABLabel，已剥掉包装。 */
  label?: string;
  primary?: boolean;
}

export interface ContactAddress {
  type?: string[];
  label?: string;
  primary?: boolean;
  po_box?: string;
  extended?: string;
  street?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

export interface ContactName {
  /** FN。vCard 必填项，解析时若缺失则由 N 拼出，仍缺则为空串。 */
  full: string;
  family?: string;
  given?: string;
  middle?: string;
  prefix?: string;
  suffix?: string;
}

export interface Contact {
  contact_id: string;
  address_book_id: string;
  name: ContactName;
  nickname?: string;
  organization?: string;
  department?: string;
  title?: string;
  emails?: TypedValue[];
  phones?: TypedValue[];
  addresses?: ContactAddress[];
  urls?: TypedValue[];
  impp?: TypedValue[];
  /** YYYY-MM-DD；无年份的生日为 --MM-DD。 */
  birthday?: string;
  note?: string;
  /** 是否存在头像。**永远不返回 base64 内容。** */
  has_photo: boolean;
  /** REV，ISO 8601。 */
  updated_at?: string;
}

export interface ContactInput {
  name: {
    full?: string;
    family?: string;
    given?: string;
    middle?: string;
    prefix?: string;
    suffix?: string;
  };
  nickname?: string | null;
  organization?: string | null;
  department?: string | null;
  title?: string | null;
  emails?: TypedValue[];
  phones?: TypedValue[];
  addresses?: ContactAddress[];
  urls?: TypedValue[];
  impp?: TypedValue[];
  birthday?: string | null;
  note?: string | null;
}

function parseRoot(text: string): ICAL.Component {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(text);
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', '联系人数据解析失败', { cause });
  }
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(jcal as unknown[]);
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', '联系人数据解析失败', { cause });
  }
  if (root.name !== 'vcard') {
    throw new AppError('UPSTREAM_ERROR', '联系人数据不是有效的 vCard');
  }
  return root;
}

/**
 * 结构化值扁平化的单一入口。ical.js 把结构化属性（N/ORG/ADR）的值解析成数组，
 * 而其中某一段自身还可能因为逗号被当成子分隔符而被拆成子数组——precisely 当
 * 该逗号没有反斜杠转义时（`ical.js` 的 `unescapedIndexOf` 只在分隔符前没有
 * `\` 时才切分）。例如未转义的 `ADR:...;某路 1 号, 5 楼;...` 的 street 段会
 * 是 `["某路 1 号"," 5 楼"]`；反之若逗号已被转义为 `\,`，ical.js 会正确地把
 * 它当作字面逗号、不切分。这两种输入这一层都要正确处理，每一个结构化字段都
 * 必须先经过这里再使用，否则未转义逗号的情形会把 `[object Object]` 这类脏
 * 数据渗到对外响应里。数组递归 join(', ')，每一段先各自 trim 再拼接。
 */
function flattenSegment(v: unknown): string {
  if (Array.isArray(v)) return v.map(flattenSegment).join(', ');
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 把结构化属性的原始值统一成数组视图，即便 ical.js 只返回了单个标量。 */
function structuredParts(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Apple 的分组前缀（如 `item1.TEL:...`）以 jCal 参数 `group` 暴露，取值用
 * `prop.getParameter('group')`——`prop.group` 恒为 undefined，不要用它
 * （实测事实 4）。自定义标签就是同一个 group 下那条 X-ABLabel 的值。
 */
function labelsByGroup(root: ICAL.Component): Map<string, string> {
  const map = new Map<string, string>();
  for (const prop of root.getAllProperties('x-ablabel')) {
    const group = prop.getParameter('group');
    if (typeof group !== 'string') continue;
    const raw = prop.getFirstValue();
    if (typeof raw !== 'string' || !raw) continue;
    map.set(group, unwrapLabel(raw));
  }
  return map;
}

const LABEL_WRAPPER_RE = /^_\$!<(.*)>!\$_$/;

/** Apple 内置标签常被包成 `_$!<Name>!$_` 的形式；自定义标签则是用户输入的原始字符串。 */
function unwrapLabel(raw: string): string {
  const match = LABEL_WRAPPER_RE.exec(raw);
  return match?.[1] ?? raw;
}

/** TYPE 参数可能是字符串也可能是数组；统一成小写数组，并把 pref 摘出来变成 primary。 */
function normalizeType(prop: ICAL.Property): { type?: string[]; primary?: boolean } {
  const raw = prop.getParameter('type');
  if (raw === undefined || raw === null) return {};
  const values = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).toLowerCase());
  const primary = values.includes('pref');
  const type = values.filter((v) => v !== 'pref');
  const result: { type?: string[]; primary?: boolean } = {};
  if (type.length > 0) result.type = type;
  if (primary) result.primary = true;
  return result;
}

function labelOf(prop: ICAL.Property, labels: Map<string, string>): string | undefined {
  const group = prop.getParameter('group');
  if (typeof group !== 'string') return undefined;
  return labels.get(group);
}

/** EMAIL / TEL / URL / IMPP 共用：可重复的标量属性，读成 TypedValue[]。 */
function typedValuesFrom(root: ICAL.Component, propName: string, labels: Map<string, string>): TypedValue[] {
  const out: TypedValue[] = [];
  for (const prop of root.getAllProperties(propName)) {
    const value = flattenSegment(prop.getFirstValue());
    if (!value) continue;
    const entry: TypedValue = { value };
    const { type, primary } = normalizeType(prop);
    if (type) entry.type = type;
    if (primary) entry.primary = true;
    const label = labelOf(prop, labels);
    if (label) entry.label = label;
    out.push(entry);
  }
  return out;
}

function addressesFrom(root: ICAL.Component, labels: Map<string, string>): ContactAddress[] {
  const out: ContactAddress[] = [];
  for (const prop of root.getAllProperties('adr')) {
    const parts = structuredParts(prop.getFirstValue());
    const addr: ContactAddress = {};
    const poBox = flattenSegment(parts[0]);
    if (poBox) addr.po_box = poBox;
    const extended = flattenSegment(parts[1]);
    if (extended) addr.extended = extended;
    const street = flattenSegment(parts[2]);
    if (street) addr.street = street;
    const city = flattenSegment(parts[3]);
    if (city) addr.city = city;
    const region = flattenSegment(parts[4]);
    if (region) addr.region = region;
    const postalCode = flattenSegment(parts[5]);
    if (postalCode) addr.postal_code = postalCode;
    const country = flattenSegment(parts[6]);
    if (country) addr.country = country;

    const { type, primary } = normalizeType(prop);
    if (type) addr.type = type;
    if (primary) addr.primary = true;
    const label = labelOf(prop, labels);
    if (label) addr.label = label;

    out.push(addr);
  }
  return out;
}

function nameFrom(root: ICAL.Component): ContactName {
  const parts = structuredParts(root.getFirstPropertyValue('n'));
  const family = flattenSegment(parts[0]);
  const given = flattenSegment(parts[1]);
  const middle = flattenSegment(parts[2]);
  const prefix = flattenSegment(parts[3]);
  const suffix = flattenSegment(parts[4]);

  const fnRaw = root.getFirstPropertyValue('fn');
  const fn = typeof fnRaw === 'string' ? fnRaw.trim() : '';

  const name: ContactName = {
    full: fn || [family, given, middle, prefix, suffix].filter(Boolean).join(' '),
  };
  if (family) name.family = family;
  if (given) name.given = given;
  if (middle) name.middle = middle;
  if (prefix) name.prefix = prefix;
  if (suffix) name.suffix = suffix;
  return name;
}

function orgFrom(root: ICAL.Component): { organization?: string; department?: string } {
  const raw = root.getFirstPropertyValue('org');
  if (raw === null || raw === undefined) return {};
  const parts = structuredParts(raw);
  const organization = flattenSegment(parts[0]);
  const department = parts.length > 1 ? flattenSegment(parts.slice(1)) : '';
  const result: { organization?: string; department?: string } = {};
  if (organization) result.organization = organization;
  if (department) result.department = department;
  return result;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** year 为 undefined（无年份生日）时按闰年计算，好让 2 月 29 日这种生日合法。 */
function daysInMonth(year: number | undefined, month: number): number {
  const base = MONTH_LENGTHS[month - 1];
  if (base === undefined) return 0;
  if (month === 2 && (year === undefined || isLeapYear(year))) return 29;
  return base;
}

/** 真正的日历范围校验，不只是"两位数字"：13 月、2 月 30 日都要被判为非法。 */
function isValidMonthDay(year: number | undefined, month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

const BIRTHDAY_FULL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BIRTHDAY_NO_YEAR_RE = /^--(\d{2})-(\d{2})$/;

const BIRTHDAY_HINT = '只接受 YYYY-MM-DD（例如 1990-05-20）与无年份的 --MM-DD（例如 --05-20）两种写法';

/**
 * 生日必须在写进卡片之前校验，理由和 parsers/ical.ts::toIcalTime 一样，但后果更重：
 * 一个像 `BDAY:next tuesday` 这样的值 ical.js 写得进去、却读不回来（getFirstValue
 * 直接抛错），而服务层是"先在服务器上建卡、再解析回显"的顺序——卡片已经落到用户真实
 * 通讯录里了，搜索缓存又会在每次同步时跳过这张解析失败的卡，于是这张卡再也拿不到
 * contact_id，读不了、改不了、删不了。所以这里必须在写入前就拒绝，而不是写完再说。
 */
function validateBirthday(raw: string): string {
  const value = raw.trim();

  const full = BIRTHDAY_FULL_RE.exec(value);
  if (full) {
    const year = Number(full[1]);
    if (year >= 1 && isValidMonthDay(year, Number(full[2]), Number(full[3]))) return value;
  }

  const noYear = BIRTHDAY_NO_YEAR_RE.exec(value);
  if (noYear && isValidMonthDay(undefined, Number(noYear[1]), Number(noYear[2]))) return value;

  throw new AppError('INVALID_INPUT', `生日格式无法识别：${raw}`, { hint: BIRTHDAY_HINT });
}

/** 字符串形态的 BDAY（少见，取决于 ical.js 的取值分支）也要按同样两种形状收敛。 */
function formatBirthdayString(value: string, omitYear: boolean): string | undefined {
  const trimmed = value.trim();

  const full = BIRTHDAY_FULL_RE.exec(trimmed);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (!isValidMonthDay(year, month, day)) return undefined;
    return omitYear || year < 1 ? `--${pad2(month)}-${pad2(day)}` : trimmed;
  }

  const noYear = BIRTHDAY_NO_YEAR_RE.exec(trimmed);
  if (noYear && isValidMonthDay(undefined, Number(noYear[1]), Number(noYear[2]))) return trimmed;

  return undefined;
}

/**
 * BDAY 经 getFirstValue 返回的是 ICAL.Time 形状的对象（`{year, month, day, ...}`），
 * 不是字符串（实测事实 5）。
 *
 * **读方向永远不抛错。** 卡片可能是任何客户端写的：`BDAY:next tuesday` 会让
 * getFirstValue 直接抛一个原始 Error（不是 AppError），而这个异常会一路穿过
 * parseRoot 的 try/catch 变成 INTERNAL，还会让 modules/contacts/cache.ts 在每次
 * 同步时跳过整张卡片——一个字段格式不对，整个联系人就从搜索里消失了。所以任何
 * 无法格式化的值一律返回 undefined，只是 birthday 字段不出现而已。
 *
 * 无年份生日有两种写法要归一到文档承诺的 `--MM-DD`：ical.js 解析出 year 为
 * 空的 `BDAY:--05-20`，以及 Apple 的 `BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-20`
 * ——后者若原样输出会让模型报出一个 1604 年的出生年份。只有年份的 `BDAY:1990`
 * 解析出 month/day 为空，格式化不出合法日期，返回 undefined。
 */
function formatBirthday(root: ICAL.Component): string | undefined {
  const prop = root.getFirstProperty('bday');
  if (!prop) return undefined;

  const omitYear = prop.getParameter('x-apple-omit-year') !== undefined;

  let value: unknown;
  try {
    value = prop.getFirstValue();
  } catch {
    return undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return formatBirthdayString(value, omitYear);

  const time = value as ICAL.Time;
  const month = Number(time.month);
  const day = Number(time.day);
  const year = Number(time.year);
  const hasYear = !omitYear && Number.isInteger(year) && year >= 1;
  if (!isValidMonthDay(hasYear ? year : undefined, month, day)) return undefined;
  if (!hasYear) return `--${pad2(month)}-${pad2(day)}`;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** REV 同样是 ICAL.Time 形状的对象；格式化成不带毫秒的 ISO 8601（UTC）字符串。 */
function formatTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value || undefined;
  const time = value as ICAL.Time;
  const year = String(time.year).padStart(4, '0');
  const month = pad2(Number(time.month));
  const day = pad2(Number(time.day));
  const hour = pad2(Number(time.hour));
  const minute = pad2(Number(time.minute));
  const second = pad2(Number(time.second));
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

export function parseVCard(text: string, ref: ResourceRef): Contact {
  const root = parseRoot(text);
  const labels = labelsByGroup(root);

  const contact: Contact = {
    contact_id: encodeRef(ref),
    address_book_id: encodeUrl(ref.collectionUrl),
    name: nameFrom(root),
    // 只判断 photo 属性是否存在，绝不读取它的值——base64 绝不能出现在对外响应里。
    has_photo: root.hasProperty('photo'),
  };

  const nickname = root.getFirstPropertyValue('nickname');
  if (typeof nickname === 'string' && nickname) contact.nickname = nickname;

  const { organization, department } = orgFrom(root);
  if (organization) contact.organization = organization;
  if (department) contact.department = department;

  const title = root.getFirstPropertyValue('title');
  if (typeof title === 'string' && title) contact.title = title;

  const emails = typedValuesFrom(root, 'email', labels);
  if (emails.length > 0) contact.emails = emails;

  const phones = typedValuesFrom(root, 'tel', labels);
  if (phones.length > 0) contact.phones = phones;

  const addresses = addressesFrom(root, labels);
  if (addresses.length > 0) contact.addresses = addresses;

  const urls = typedValuesFrom(root, 'url', labels);
  if (urls.length > 0) contact.urls = urls;

  const impp = typedValuesFrom(root, 'impp', labels);
  if (impp.length > 0) contact.impp = impp;

  const birthday = formatBirthday(root);
  if (birthday) contact.birthday = birthday;

  const note = root.getFirstPropertyValue('note');
  if (typeof note === 'string' && note) contact.note = note;

  const updatedAt = formatTimestamp(root.getFirstPropertyValue('rev'));
  if (updatedAt) contact.updated_at = updatedAt;

  return contact;
}

/**
 * 这张卡片是不是一个「分组」而不是一个人。iCloud 把通讯录分组（Coworkers、Family、ICE……）也存成
 * vCard 3.0，用 `X-ADDRESSBOOKSERVER-KIND:group` 标记、成员写在 `X-ADDRESSBOOKSERVER-MEMBER` 里，
 * 和真联系人混在同一本通讯簿返回；vCard 4.0 的等价写法是 `KIND:group`。按属性读而不是对原文做正则，
 * 是为了不把 NOTE 里恰好写着 "KIND:group" 的普通联系人误判成分组。
 */
export function isGroupVCard(text: string): boolean {
  const root = parseRoot(text);
  for (const name of ['x-addressbookserver-kind', 'kind']) {
    const value = root.getFirstPropertyValue(name);
    if (typeof value === 'string' && value.trim().toLowerCase() === 'group') return true;
  }
  return false;
}

/** 只读 UID 和 REV，不构建完整的 Contact 模型——供同步/条件写入等只关心元数据的调用方使用。 */
export function readContactMeta(text: string): { uid?: string; rev?: string } {
  const root = parseRoot(text);
  const meta: { uid?: string; rev?: string } = {};

  const uid = root.getFirstPropertyValue('uid');
  if (typeof uid === 'string' && uid) meta.uid = uid;

  const rev = formatTimestamp(root.getFirstPropertyValue('rev'));
  if (rev) meta.rev = rev;

  return meta;
}

// ---------------------------------------------------------------------------
// 写方向：buildVCard（新建）与 applyContactPatch（原地补丁）。
//
// applyContactPatch 必须原地修改已解析的 ICAL.Component，绝不能"解析成模型
// 再用 buildVCard 重建"——这条规则的血的教训见 parsers/ical.ts 的
// applyPatchToVevent 与 CLAUDE.md。通讯录风险更大：真实 Apple 卡片带着
// PHOTO（头像 base64）、X-ABRELATEDNAMES（亲属关系）、X-SOCIALPROFILE、
// X-APPLE-* 等我们的领域模型根本不表示的属性，尤其 PHOTO——Contact 只暴露
// has_photo 布尔值，模型里压根没有头像数据，重建必然把它删掉。
// ---------------------------------------------------------------------------

/** FN 的拼接规则：显式 full 优先，否则按 [family, given] 过滤空值后拼接。 */
function composeFullName(name: ContactInput['name']): string {
  const full = name.full?.trim();
  if (full) return full;
  return [name.family, name.given].filter((v): v is string => Boolean(v && v.trim())).join(' ');
}

/** REV 的写入格式，需与 iCloud 一致：不带毫秒的 ISO 8601（UTC）。 */
function formatRevNow(): string {
  const now = new Date();
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = pad2(now.getUTCMonth() + 1);
  const day = pad2(now.getUTCDate());
  const hour = pad2(now.getUTCHours());
  const minute = pad2(now.getUTCMinutes());
  const second = pad2(now.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * 扫描卡片上已经使用的 `itemN` 分组编号，返回比现有最大值大 1 的下一个可用
 * 编号。扫描必须看到卡片上所有保留下来的属性，否则新分配的编号会跟它们撞号；
 * 同一次补丁里的多次分配则由 makeGroupAllocator 递增计数来错开，不需要重扫。
 */
function nextGroupNumber(root: ICAL.Component): number {
  let max = 0;
  for (const prop of root.getAllProperties()) {
    const group = prop.getParameter('group');
    if (typeof group !== 'string') continue;
    const match = /^item(\d+)$/i.exec(group);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** 基于当前卡片状态创建一个分组编号分配器；每次调用递增，不重新扫描。 */
function makeGroupAllocator(root: ICAL.Component): () => string {
  let next = nextGroupNumber(root);
  return () => `item${next++}`;
}

/** TYPE 参数的写入：把 type 数组和 primary 合并成一个 TYPE 参数（primary 映射成 pref）。 */
function assignTypeParams(prop: ICAL.Property, entry: { type?: string[]; primary?: boolean }): void {
  const types = [...(entry.type ?? [])];
  if (entry.primary) types.push('pref');
  if (types.length > 0) prop.setParameter('type', types);
}

/**
 * 写入一个可能带自定义标签的可重复属性：先写值和 TYPE，再在需要时分配新的
 * item 分组并配一条 X-ABLabel。EMAIL/TEL/URL/IMPP/ADR 共用这一实现。
 */
function addLabelledProperty(
  root: ICAL.Component,
  propName: string,
  rawValue: string | string[],
  entry: { type?: string[]; label?: string; primary?: boolean },
  nextGroup: () => string,
): void {
  const prop = root.addPropertyWithValue(propName, rawValue);
  assignTypeParams(prop, entry);
  if (entry.label) {
    const group = nextGroup();
    prop.setParameter('group', group);
    const labelProp = root.addPropertyWithValue('x-ablabel', entry.label);
    labelProp.setParameter('group', group);
  }
}

/** ADR 结构化值的 7 段顺序：po_box;extended;street;city;region;postal_code;country。 */
function addressRawParts(addr: ContactAddress): string[] {
  return [
    addr.po_box ?? '',
    addr.extended ?? '',
    addr.street ?? '',
    addr.city ?? '',
    addr.region ?? '',
    addr.postal_code ?? '',
    addr.country ?? '',
  ];
}

function writeTypedValues(
  root: ICAL.Component,
  propName: string,
  values: TypedValue[] | undefined,
  nextGroup: () => string,
): void {
  if (!values) return;
  for (const entry of values) {
    addLabelledProperty(root, propName, entry.value, entry, nextGroup);
  }
}

function writeAddresses(root: ICAL.Component, values: ContactAddress[] | undefined, nextGroup: () => string): void {
  if (!values) return;
  for (const addr of values) {
    addLabelledProperty(root, 'adr', addressRawParts(addr), addr, nextGroup);
  }
}

function writeOrg(root: ICAL.Component, organization: string | undefined, department: string | undefined): void {
  if (!organization && !department) return;
  if (department) {
    root.addPropertyWithValue('org', [organization ?? '', department]);
  } else {
    root.addPropertyWithValue('org', organization ?? '');
  }
}

/**
 * 从头新建一张 vCard 3.0 卡片。VERSION 必须是卡片的第一个属性——ical.js 的
 * design-set 探测（`Component#_designSet`）只看 jCal 数组里的第一条属性是
 * 否是 `version=3.0`，晚写会导致后续属性按错误的 design set（默认的
 * icalendar，而非 vcard3）解释。
 */
export function buildVCard(input: ContactInput): { vcard: string; uid: string } {
  const fullName = composeFullName(input.name);
  if (!fullName) {
    throw new AppError('INVALID_INPUT', '联系人缺少姓名，无法生成 FN');
  }

  const uid = randomUUID();
  const root = new ICAL.Component('vcard');
  root.addPropertyWithValue('version', '3.0');
  root.addPropertyWithValue('uid', uid);
  root.addPropertyWithValue('fn', fullName);
  root.addPropertyWithValue('n', [
    input.name.family ?? '',
    input.name.given ?? '',
    input.name.middle ?? '',
    input.name.prefix ?? '',
    input.name.suffix ?? '',
  ]);

  if (input.nickname) root.addPropertyWithValue('nickname', input.nickname);
  writeOrg(root, input.organization ?? undefined, input.department ?? undefined);
  if (input.title) root.addPropertyWithValue('title', input.title);

  const nextGroup = makeGroupAllocator(root);
  writeTypedValues(root, 'email', input.emails, nextGroup);
  writeTypedValues(root, 'tel', input.phones, nextGroup);
  writeAddresses(root, input.addresses, nextGroup);
  writeTypedValues(root, 'url', input.urls, nextGroup);
  writeTypedValues(root, 'impp', input.impp, nextGroup);

  if (input.birthday) root.addPropertyWithValue('bday', validateBirthday(input.birthday));
  if (input.note) root.addPropertyWithValue('note', input.note);
  root.addPropertyWithValue('rev', formatRevNow());

  return { vcard: root.toString(), uid };
}

/** 标量字段的"先删后加"写入：patch 里缺省该字段（undefined）则完全不碰；`null` 只删不加。 */
function setScalar(root: ICAL.Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  root.removeAllProperties(name);
  if (value === null) return;
  root.addPropertyWithValue(name, value);
}

/** name 是结构化字段，补丁给出即整体替换 N/FN；省略则完全不碰。 */
function patchName(root: ICAL.Component, name: ContactInput['name'] | undefined): void {
  if (name === undefined) return;
  const fullName = composeFullName(name);
  if (!fullName) {
    throw new AppError('INVALID_INPUT', '联系人缺少姓名，无法生成 FN');
  }
  root.removeAllProperties('fn');
  root.addPropertyWithValue('fn', fullName);
  root.removeAllProperties('n');
  root.addPropertyWithValue('n', [
    name.family ?? '',
    name.given ?? '',
    name.middle ?? '',
    name.prefix ?? '',
    name.suffix ?? '',
  ]);
}

/**
 * ORG 是单条属性里塞了 organization;department 两段，而补丁把它们拆成两个
 * 独立标量字段——只碰 patch 里出现的那一半，另一半沿用卡片上已有的值，最后
 * 一起重写整条 ORG（`null` 视作清空那一半）。
 */
function patchOrg(root: ICAL.Component, patch: Partial<ContactInput>): void {
  if (patch.organization === undefined && patch.department === undefined) return;
  const current = orgFrom(root);
  const organization = patch.organization === undefined ? current.organization : (patch.organization ?? undefined);
  const department = patch.department === undefined ? current.department : (patch.department ?? undefined);
  root.removeAllProperties('org');
  writeOrg(root, organization, department);
}

/** 删除即将被替换掉的属性所属分组的 X-ABLabel，避免留下指向不存在属性的孤儿标签。 */
function removeGroupedLabels(root: ICAL.Component, groups: Set<string>): void {
  if (groups.size === 0) return;
  for (const label of root.getAllProperties('x-ablabel')) {
    const group = label.getParameter('group');
    if (typeof group === 'string' && groups.has(group)) root.removeProperty(label);
  }
}

/**
 * 可重复字段的整体替换语义：给出数组就把该属性的现有条目全删再按新数组写
 * 入，省略（undefined）则完全不碰。**顺序不能反**——必须先把待删属性的
 * group 参数收集进 `groups`，再删除属性本身；删除之后 group 就再也读不到
 * 了，也就找不到该删哪些 X-ABLabel。
 */
function replaceTypedValues(root: ICAL.Component, propName: string, values: TypedValue[] | undefined): void {
  if (values === undefined) return;
  const groups = new Set<string>();
  for (const prop of root.getAllProperties(propName)) {
    const group = prop.getParameter('group');
    if (typeof group === 'string') groups.add(group);
    root.removeProperty(prop);
  }
  removeGroupedLabels(root, groups);

  const nextGroup = makeGroupAllocator(root);
  for (const entry of values) {
    addLabelledProperty(root, propName, entry.value, entry, nextGroup);
  }
}

/** 同 replaceTypedValues，但用于 ADR（结构化的 7 段地址值）。 */
function replaceAddresses(root: ICAL.Component, values: ContactAddress[] | undefined): void {
  if (values === undefined) return;
  const groups = new Set<string>();
  for (const prop of root.getAllProperties('adr')) {
    const group = prop.getParameter('group');
    if (typeof group === 'string') groups.add(group);
    root.removeProperty(prop);
  }
  removeGroupedLabels(root, groups);

  const nextGroup = makeGroupAllocator(root);
  for (const addr of values) {
    addLabelledProperty(root, 'adr', addressRawParts(addr), addr, nextGroup);
  }
}

/**
 * 在既有 vCard 上原地施加补丁，只改动 patch 指定的字段——PHOTO、PRODID、
 * UID 以及任何我们的领域模型没有覆盖的属性（X-ABRELATEDNAMES、
 * X-SOCIALPROFILE、X-APPLE-* 等）必须原样保留。REV 每次写入都刷新。
 */
export function applyContactPatch(text: string, patch: Partial<ContactInput>): string {
  const root = parseRoot(text);

  // 校验放在任何改动之前：一张写坏的卡片会让该联系人在本服务里永久失联（见 validateBirthday）。
  const birthday =
    patch.birthday === undefined || patch.birthday === null ? patch.birthday : validateBirthday(patch.birthday);

  patchName(root, patch.name);
  setScalar(root, 'nickname', patch.nickname);
  patchOrg(root, patch);
  setScalar(root, 'title', patch.title);
  setScalar(root, 'bday', birthday);
  setScalar(root, 'note', patch.note);

  replaceTypedValues(root, 'email', patch.emails);
  replaceTypedValues(root, 'tel', patch.phones);
  replaceAddresses(root, patch.addresses);
  replaceTypedValues(root, 'url', patch.urls);
  replaceTypedValues(root, 'impp', patch.impp);

  root.removeAllProperties('rev');
  root.addPropertyWithValue('rev', formatRevNow());

  return root.toString();
}
