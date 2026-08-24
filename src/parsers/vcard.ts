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
    throw new AppError('INVALID_INPUT', '联系人数据解析失败', { cause });
  }
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(jcal as unknown[]);
  } catch (cause) {
    throw new AppError('INVALID_INPUT', '联系人数据解析失败', { cause });
  }
  if (root.name !== 'vcard') {
    throw new AppError('INVALID_INPUT', '联系人数据不是有效的 vCard');
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

/**
 * BDAY 经 getFirstPropertyValue 返回的是 ICAL.Time 形状的对象
 * （`{year, month, day, ...}`），不是字符串（实测事实 5）。年份缺失或为 0
 * 时按无年份生日输出 `--MM-DD`。
 */
function formatBirthday(root: ICAL.Component): string | undefined {
  const value = root.getFirstPropertyValue('bday');
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value || undefined;
  const time = value as ICAL.Time;
  const month = pad2(Number(time.month));
  const day = pad2(Number(time.day));
  const year = Number(time.year);
  if (!year) return `--${month}-${day}`;
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
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
