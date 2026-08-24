# 阶段 2b：通讯录（CardDAV + vCard）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 iCloud 通讯录作为五个 MCP 工具暴露出来，搜索走会话内缓存 + `sync-collection` 增量同步，写操作原地补丁保留未建模属性。

**Architecture:** 沿用既有分层 `bin → server → modules → providers`，`parsers` 作纯函数层。新增 `providers/icloud/carddav.ts`（tsdav CardDAV）、`parsers/vcard.ts`（纯函数，基于已有的 `ical.js`）、`modules/contacts/{service,tools,types}.ts`。因为 iCloud 不支持服务端过滤，搜索在服务层对会话缓存做匹配，缓存由 `sync-collection` 的变更集保鲜。

**Tech Stack:** TypeScript ESM（NodeNext）、`tsdav` 2.3.1（CardDAV）、`ical.js` 2.2.1（vCard 3.0/4.0 解析）、`zod` 4.4.3、`vitest` 4.1.11。**不新增任何依赖。**

**Spec:** `docs/superpowers/specs/2026-08-22-apple-icloud-mcp-refactor-design.md` §5.5

---

## 计划前裁定（三条，均基于实测证据，写计划时已确认）

### 裁定一：vCard 用 `ical.js`，不用 spec 点名的 `vcard4`

spec §6 写的是「vCard（`vcard4`）：兼容 iCloud 实际下发的 vCard 3.0 与 4.0」。**这条选型是错的**，`npm view vcard4` 的自述是 "An RFC 6350 compliant JavaScript library for generating and parsing **version 4.0** vCards"——只做 4.0，而 spec 自己在 §5.5 的实测结论里写明 iCloud 下发的是 **3.0**。

改用已经在依赖里的 `ical.js` 2.2.1，它的自述是 "parser for ics (rfc5545) **and vcard** (rfc6350) data"。实测（写计划时用真实形态的 Apple vCard 3.0 验证过）：

```
name        : vcard
VERSION     : 3.0
FN          : 张三
N (struct)  : ["张","三","","",""]
ORG         : ["某某科技有限公司","研发部"]
ADR         : ["","",["某路 1 号"," 5 楼"],"上海","","200000","中国"]
EMAIL value : zhang@example.com | type param: ["INTERNET","WORK","pref"]
X-APPLE-SUBADMINISTRATIVEAREA : 浦东新区
```

原地改一个字段后再序列化，`ITEM1.URL` / `ITEM1.X-ABLABEL` / `X-APPLE-*` 全部保留。

三个理由：
1. **零新依赖。** 本仓库把 10 个漏洞（6 高危）清到 0，并立下「15 个锁定版本不得变动」的护栏。新增一个解析库是这条护栏最贵的一种破法。
2. **原地补丁的写法可以直接迁移。** `parsers/ical.ts` 里 `setValue`（先删后加）、`removeAllProperties`、直接改 jCal AST 的那套惯用法，在 vCard 上是同一套 `ICAL.Component` API。「未建模属性原地保留」这条要求因此不需要重新发明。
3. **团队已经熟悉这套 API。** 阶段一在 `ical.js` 上踩过的坑（`toJSDate()` 依赖宿主时区、`iterator(seedTime)` 覆盖 DTSTART）都已经记在 CLAUDE.md 里。

**必须在集成测试中验证的一处**：`ical.js` 序列化时把分组前缀统一成大写（`item1.` → `ITEM1.`）。RFC 6350 规定 group 名大小写不敏感，但 Apple 的实际行为要在真实账号上验证——往返一张带自定义标签的卡片后，iOS 通讯录里那个标签是否还在。这一条写进 Task 7 的集成测试，不允许靠推断。

### 裁定二：缓存挂在会话上，不是模块级 Map

搜索需要一份全量快照（实测 1429 张卡 6.9 秒 / 305 KB）。这份缓存**必须**挂在 `Session` 上：

- 会话销毁时缓存跟着消失，不会把一个用户的通讯录留在进程里给下一个会话看见。
- 阶段三是远程 HTTP + 并发会话。模块级 `Map` 在那时是跨租户数据泄漏，不是性能优化。整分支审查已经在 `ICAL.TimezoneService` 上记过同一类问题（进程级全局注册表），不要再添一个。

### 裁定三：`ALLOW_CONTACTS_READ_n` 保持默认 **true**

`core/config.ts:161-162` 现在就是这个默认值。写计划时我一度打算改成默认关，理由是通讯录敏感；但 `mailRead` / `calendarRead` / `remindersRead` 三个都是默认开，而邮件的敏感度不低于通讯录。**一致性是更强的理由**，特立独行的那个反而会让人以为是笔误。

真正的问题——「能力被宣告但没有工具兑现」——已经在阶段 2a 收尾时修掉了（`session/tools.ts` 把 contacts 两个键投影出去）。Task 7 要把那层投影撤掉，因为届时工具真的存在了。

`ALLOW_CONTACTS_WRITE_n` 保持默认 **false**，与另外两个写权限一致。

---

## Global Constraints

以下每条都适用于每一个任务，不再逐任务重复：

- **ESM 相对导入必须带 `.js` 后缀**（NodeNext 解析），即使源文件是 `.ts`。
- `strict` 与 `noUncheckedIndexedAccess` 均为开启状态。
- **stdout 完全属于 MCP 协议**。`src/` 下禁止 `console.log`；所有日志走 `core/logger.ts` 到 stderr。测试文件不受此限（vitest 会捕获）。
- **验证用 `npm run typecheck`，不要用裸 `npx tsc --noEmit`**。后者只覆盖 `src/**/*`（见 `tsconfig.json`）；`npm run typecheck` 会再跑一遍 `tsconfig.test.json`，其 include 是 `['src/**/*', 'tests/**/*']`。vitest 用 esbuild 转译，**从不做类型检查**。
- **`TZ=X npm test` 在 Windows 上是空转的**（Node 24 从操作系统取时区，忽略继承来的 `TZ`）。需要验证时区无关性时，用 vitest 的 `setupFiles` 在运行时赋值 `process.env.TZ`。本机默认时区是 Pacific/Auckland（UTC+12），普通测试运行本身已经在一个极端时区里。
- **不新增依赖**。15 个锁定版本不得变动，`npm audit` 必须保持 0 漏洞。
- 时间在工具边界一律是带偏移量的 ISO 8601。
- 提交信息末尾附 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- 单元测试**不得触网**：所有 provider 通过注入的假客户端构造。
- 每个任务结束前 `npm run typecheck` 与 `npx vitest run` 必须全绿。**不要运行集成测试套件**——它会写入用户的真实 iCloud 账号，由控制者决定何时运行。

## 从阶段 2a 带过来的硬性检查项

阶段 2a 出现过三次同一类缺陷：面向外部的字符串指向一个不存在的东西（工具 schema 里的幽灵 `priority` 字段、服务层提示里的 `reminders_list_lists`、共享层里只说日历的 `calendar_list_events`）。每一轮定向审查都只看自己那一层，没人横向看。

**因此本阶段每个任务结束前必须做一次横向核对**：本任务新增或修改的每一个面向用户的字符串（工具描述、参数描述、`hint`、错误消息）里出现的**工具名、参数名、环境变量名**，都要对着实际注册的东西核一遍。共享层（`core/ids.ts`、`providers/`）的措辞必须领域中立，或者同时点名各域的工具——那一层无从知道当前注册了哪些工具。

**变异实验一律要贴出两次输出**。阶段 2a 有五个「无论代码怎么坏都不会红」的测试是靠这个要求抓出来的；还有两次是实现者反过来纠正了控制者指定的变异（一次是断言取错了字段位置，一次是指定的变异在观测上根本不可达）。指定变异实验时，先确认那个变异**是可观测的**。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/parsers/vcard.ts` | 纯函数。vCard 文本 ↔ `Contact`/`ContactInput` 领域模型；原地补丁；不做任何 I/O。 |
| `src/providers/icloud/carddav.ts` | tsdav CardDAV 封装：列通讯簿、全量/增量同步、单张读取、增删改。把原始错误映射成 `AppError`。不知道 MCP 与工具 schema 的存在。 |
| `src/modules/contacts/types.ts` | 对外响应形状：`SearchContactsParams`、`SearchContactsResult`、`PartialFailure`。 |
| `src/modules/contacts/service.ts` | 权限门、会话缓存的维护与增量刷新、搜索匹配、五个操作的业务逻辑。 |
| `src/modules/contacts/tools.ts` | 五个工具的 zod schema 与 `registerTool` 接线，薄层，直接转发给 service。 |
| `src/core/session.ts` | 增加 `carddav` provider 与 `contactsCache` 槽位。 |
| `src/server/createServer.ts` | `anyContacts` 注册门控。 |

---

## 领域模型（Task 1 定义，后续任务全部依赖）

写在 `src/parsers/vcard.ts`。字段命名沿用既有模块的 snake_case 对外惯例。

```ts
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
```

`ContactInput` 的标量字段用 `string | null`：`null` 表示清除，省略表示不改动——与 reminders 的 `due` 三态一致，理由也一致（否则「清空备注」永远无法表达）。数组字段是整体替换语义：传空数组表示清空，省略表示不动。不做逐项 diff，因为 vCard 的可重复属性没有稳定的项级标识可依。

---

## Task 1: vCard 解析（读方向）

**Files:**
- Create: `src/parsers/vcard.ts`
- Test: `tests/unit/parsers/vcard-parse.test.ts`

**Interfaces:**
- Consumes: `AppError`（`src/core/errors.js`）、`encodeRef`/`encodeUrl`/`ResourceRef`（`src/core/ids.js`）
- Produces:
  - 上面「领域模型」一节的全部类型
  - `export function parseVCard(text: string, ref: ResourceRef): Contact`
  - `export function readContactMeta(text: string): { uid?: string; rev?: string }`

`src/core/ids.ts` 的现有导出（阶段一建立，本阶段直接用，不要改）：

```ts
export interface ResourceRef { collectionUrl: string; resourceUrl: string }
export function encodeRef(ref: ResourceRef): string
export function decodeRef(id: string): ResourceRef
export function encodeUrl(url: string): string
export function decodeUrl(id: string): string
```

### 实测得到的解析事实（不要重新发现，直接照做）

写这份计划时用真实形态的 Apple vCard 3.0 对 `ical.js` 2.2.1 逐条验证过：

1. `new ICAL.Component(ICAL.parse(text))` 的 `.name` 是 `'vcard'`。
2. 结构化值以数组返回：`N` → `[family, given, middle, prefix, suffix]`；`ORG` → `[org, unit...]`；`ADR` → `[po_box, extended, street, city, region, postal, country]`。
3. **结构化值的某一段可能本身是数组。** 触发条件是**未转义的裸逗号**——它在 vCard 里是合法的多值分隔符（RFC 6350 允许 ADR 等结构化组件带多个值）。`ADR;type=WORK:;;某路 1 号, 5 楼;上海;;200000;中国` 解析出的 street 段是 `["某路 1 号"," 5 楼"]`。反过来，**转义逗号（反斜杠加逗号）保持字面量**，ical.js 的 `unescapedIndexOf` 会跳过它，得到字符串 `"某路 1 号, 5 楼"`。**每一段都必须先扁平化再用**，否则多值组件会渗出 `[object Object]` 这类脏数据。

   > 这一条最初写反了（说成「转义逗号触发拆分」）。改正来自 Task 1 的实现者：它读了 `ical.js` 的 `lib/ical/helpers.js`，并用 `String.fromCharCode(92)` 构造反斜杠绕开转义歧义做了对照实验。我最初的探针被自己工具链的反斜杠折叠骗了——以为传进去的是转义逗号，实际到达解析器的是裸逗号。**任何关于转义行为的断言，都必须用 `String.fromCharCode(92)` 而非字面反斜杠来验证。**
4. **Apple 的分组前缀以 jCal 参数 `group` 暴露。** 用 `prop.getParameter('group')` 取，返回如 `'item1'`。`prop.group` 是 `undefined`，不要用它。自定义标签是同 group 下那条 `X-ABLabel` 的值。
5. `BDAY` 经 `getFirstPropertyValue` 返回的是 `ICAL.Time` 形状的对象（`{year, month, day, ...}`），不是字符串。
6. `PHOTO` 的参数形如 `{encoding: 'b', type: 'JPEG'}`，值是 base64。

### Apple 自定义标签的包装

`X-ABLabel` 的值常被包成内置标签形式（前后各有一段 `_$!<` 与 `>!$_` 包裹），也可能直接是用户输入的字符串（如 `老家座机`）。解析时剥掉这层包装，取中间内容。

- [ ] **Step 1: 写失败测试 `tests/unit/parsers/vcard-parse.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseVCard, readContactMeta } from '../../../src/parsers/vcard.js';
import { AppError } from '../../../src/core/errors.js';

const ref = {
  collectionUrl: 'https://contacts.icloud.com/123/card/',
  resourceUrl: 'https://contacts.icloud.com/123/card/abc.vcf',
};

function card(...lines: string[]): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n');
}

/** 内置标签的包装形式，拆开写以免被误读成普通字符串。 */
const wrapped = (name: string) => '_$!<' + name + '>!$_';

describe('parseVCard', () => {
  it('reads the structured name and prefers FN for the full name', () => {
    const c = parseVCard(card('N:张;三;中;博士;Jr.', 'FN:张三'), ref);
    expect(c.name.full).toBe('张三');
    expect(c.name.family).toBe('张');
    expect(c.name.given).toBe('三');
    expect(c.name.middle).toBe('中');
    expect(c.name.prefix).toBe('博士');
    expect(c.name.suffix).toBe('Jr.');
  });

  it('falls back to composing a full name when FN is absent', () => {
    const c = parseVCard(card('N:张;三;;;'), ref);
    expect(c.name.full).toBe('张 三');
  });

  it('flattens a structured segment that itself parsed as an array', () => {
    // 裸逗号是 vCard 合法的多值分隔符，ical.js 会把该段解析成数组。
    // 这是唯一走得到 flattenSegment 的输入形态 —— 转义逗号不会触发它。
    const c = parseVCard(card('FN:x', 'ADR;type=WORK:;;某路 1 号, 5 楼;上海;;200000;中国'), ref);
    const addr = c.addresses![0]!;
    expect(addr.street).toBe('某路 1 号, 5 楼');
    expect(addr.city).toBe('上海');
    expect(addr.postal_code).toBe('200000');
    expect(addr.country).toBe('中国');
    expect(addr.type).toEqual(['work']);
  });

  it('keeps an escaped comma literal instead of splitting on it', () => {
    // 用 String.fromCharCode(92) 构造反斜杠：字面反斜杠会在多层工具链里被折叠，
    // 这正是计划里这条事实最初被写反的原因。
    const bs = String.fromCharCode(92);
    const c = parseVCard(card('FN:x', 'ADR:;;某路 1 号' + bs + ', 5 楼;上海;;200000;中国'), ref);
    expect(c.addresses![0]!.street).toBe('某路 1 号, 5 楼');
  });

  it('splits ORG into organization and department', () => {
    const c = parseVCard(card('FN:x', 'ORG:某某科技有限公司;研发部', 'TITLE:工程师'), ref);
    expect(c.organization).toBe('某某科技有限公司');
    expect(c.department).toBe('研发部');
    expect(c.title).toBe('工程师');
  });

  it('normalizes TYPE to lowercase and lifts pref into primary', () => {
    const c = parseVCard(
      card(
        'FN:x',
        'EMAIL;type=INTERNET;type=WORK;type=pref:a@example.com',
        'EMAIL;type=HOME:b@example.com',
      ),
      ref,
    );
    const [first, second] = c.emails!;
    expect(first!.value).toBe('a@example.com');
    expect(first!.primary).toBe(true);
    expect(first!.type).toEqual(['internet', 'work']);
    expect(second!.primary).toBeUndefined();
    expect(second!.type).toEqual(['home']);
  });

  it('attaches an Apple custom label from the same item group', () => {
    const c = parseVCard(
      card(
        'FN:x',
        'item1.TEL;type=pref:+8613800000000',
        'item1.X-ABLabel:老家座机',
        'TEL;type=CELL:+8613900000000',
      ),
      ref,
    );
    const [labelled, plain] = c.phones!;
    expect(labelled!.label).toBe('老家座机');
    expect(plain!.label).toBeUndefined();
  });

  it('unwraps an Apple built-in label decoration', () => {
    const c = parseVCard(
      card('FN:x', 'item1.URL:https://example.com', 'item1.X-ABLabel:' + wrapped('HomePage')),
      ref,
    );
    expect(c.urls![0]!.label).toBe('HomePage');
  });

  it('reports a photo without ever returning its bytes', () => {
    const withPhoto = parseVCard(card('FN:x', 'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ'), ref);
    expect(withPhoto.has_photo).toBe(true);
    expect(JSON.stringify(withPhoto)).not.toContain('/9j/4AAQ');
    expect(parseVCard(card('FN:x'), ref).has_photo).toBe(false);
  });

  it('formats a birthday with and without a year', () => {
    expect(parseVCard(card('FN:x', 'BDAY:1990-05-20'), ref).birthday).toBe('1990-05-20');
    expect(parseVCard(card('FN:x', 'BDAY:--05-20'), ref).birthday).toBe('--05-20');
  });

  it('tolerates vCard 4.0 as well as 3.0', () => {
    const v4 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:李四',
      'N:李;四;;;',
      'EMAIL;TYPE=work:li@example.com',
      'END:VCARD',
    ].join('\r\n');
    const c = parseVCard(v4, ref);
    expect(c.name.full).toBe('李四');
    expect(c.emails![0]!.value).toBe('li@example.com');
  });

  it('emits opaque ids that never leak a raw URL', () => {
    const c = parseVCard(card('FN:x', 'UID:ABCD-1234', 'REV:2026-08-24T10:00:00Z'), ref);
    expect(typeof c.contact_id).toBe('string');
    expect(c.contact_id).not.toContain('https://');
    expect(c.contact_id).not.toContain('contacts.icloud.com');
    expect(c.address_book_id).not.toContain('https://');
    expect(c.updated_at).toBe('2026-08-24T10:00:00Z');
  });

  it('rejects text that is not a vCard', () => {
    expect(() => parseVCard('BEGIN:VCALENDAR\r\nEND:VCALENDAR', ref)).toThrow(AppError);
    expect(() => parseVCard('not a card at all', ref)).toThrow(AppError);
  });
});

describe('readContactMeta', () => {
  it('reads UID and REV without building the whole model', () => {
    expect(readContactMeta(card('FN:x', 'UID:U-1', 'REV:2026-01-01T00:00:00Z'))).toEqual({
      uid: 'U-1',
      rev: '2026-01-01T00:00:00Z',
    });
  });

  it('returns an empty object for a card carrying neither', () => {
    expect(readContactMeta(card('FN:x'))).toEqual({});
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把 `has_photo` 的实现改成恒 `false`，确认**只有** photo 那条用例失败，再改回。守的是「base64 绝不外泄」这条硬要求。
2. 把扁平化那一步去掉（结构化段直接取原值），确认**只有** `flattens a structured segment` 那条失败，再改回。**注意**：这条实验只有在 ADR 用**裸逗号**时才成立。用转义逗号的话解析结果本来就是字符串，去不去扁平化都一样绿，实验会假性通过——计划最初就踩了这个坑。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/parsers/vcard-parse.test.ts`
Expected: FAIL，模块不存在或 `parseVCard is not a function`。

- [ ] **Step 3: 实现读方向**

以 `src/parsers/ical.ts` 为风格范本：同样的纯函数、同样的 `AppError` 用法、同样把归一化收敛到单一入口。要点：

- `ICAL.parse` 抛出的第三方异常必须接住并转成 `AppError('INVALID_INPUT', ...)`，不要让它穿过解析层；`.name !== 'vcard'` 同样抛 `INVALID_INPUT`。
- 写一个 `flattenSegment(v: unknown): string` 收敛扁平化：数组则递归 `join(', ')` 后 `trim`，`null`/`undefined` 归空串。**每一个结构化字段都必须经过它。**
- 写一个 `labelsByGroup(component): Map<string, string>`：扫一遍 `x-ablabel` 属性，按 `getParameter('group')` 建索引，值剥掉内置标签包装。
- 类型参数归一：`getParameter('type')` 可能是字符串也可能是数组，统一成小写数组；把 `pref` 从数组里摘出来变成 `primary: true`。
- `has_photo` 只判断 `photo` 属性是否存在，**绝不读取它的值**。
- `contact_id` 用 `encodeRef(ref)`，`address_book_id` 用 `encodeUrl(ref.collectionUrl)`。
- `BDAY` 返回对象，按 `year`/`month`/`day` 自行格式化；`year` 缺失或为 0 时输出 `--MM-DD`。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/parsers/vcard.ts tests/unit/parsers/vcard-parse.test.ts
git commit -m "feat(vcard): parse iCloud vCard 3.0 into a structured contact model"
```

---

## Task 2: vCard 生成与原地补丁（写方向）

**Files:**
- Modify: `src/parsers/vcard.ts`
- Test: `tests/unit/parsers/vcard-build.test.ts`

**Interfaces:**
- Consumes: Task 1 的全部类型与 `parseVCard`
- Produces:
  - `export function buildVCard(input: ContactInput): { vcard: string; uid: string }`
  - `export function applyContactPatch(text: string, patch: Partial<ContactInput>): string`

### 这个任务存在的唯一理由

`applyContactPatch` **必须原地修改已解析的 vCard，不得按领域模型重建整张卡片**。这条规则在本仓库有血的教训：阶段一的 `calendar_update_event` 最初就是按模型重建，把 `ATTENDEE`、`ORGANIZER`、`CATEGORIES`、`X-APPLE-*` 全部静默丢掉了——那是用户的真实数据（受邀人名单、RSVP 状态）。CLAUDE.md 里「`calendar_update_event` patches the existing VEVENT in place」那一条就是为此写的。

通讯录的风险更大：一张真实的 Apple 联系人卡片带着 `X-ABLabel` 分组、`X-ABRELATEDNAMES`（亲属关系）、`X-SOCIALPROFILE`、`X-ABDATE`（纪念日）、`PHOTO`（头像 base64）。**按模型重建等于把用户的头像和亲属关系删掉。** 尤其 `PHOTO`：读方向刻意只返回 `has_photo` 布尔值，所以模型里根本没有头像数据可供重建——重建必然丢头像。

### 数组字段的替换语义

`emails`/`phones`/`addresses`/`urls`/`impp` 是整体替换：给出数组就把该属性的现有条目全删再按新数组写入；省略则完全不碰。删除时**必须连带删掉它们所属分组的 `X-ABLabel`**，否则会留下指向不存在属性的孤儿标签。

- [ ] **Step 1: 写失败测试 `tests/unit/parsers/vcard-build.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildVCard, applyContactPatch, parseVCard } from '../../../src/parsers/vcard.js';

const ref = {
  collectionUrl: 'https://contacts.icloud.com/123/card/',
  resourceUrl: 'https://contacts.icloud.com/123/card/abc.vcf',
};

/** 一张带足未建模属性的真实形态卡片。 */
const richCard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iOS 18.0//EN',
  'N:张;三;;;',
  'FN:张三',
  'ORG:某某科技;研发部',
  'EMAIL;type=INTERNET;type=WORK;type=pref:zhang@example.com',
  'item1.TEL;type=pref:+8613800000000',
  'item1.X-ABLabel:老家座机',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ',
  'X-ABRELATEDNAMES;type=pref:李四',
  'X-SOCIALPROFILE;type=weibo:https://weibo.com/zhang',
  'X-APPLE-SUBADMINISTRATIVEAREA:浦东新区',
  'NOTE:原有备注',
  'UID:ABCD-1234',
  'REV:2026-08-01T00:00:00Z',
  'END:VCARD',
].join('\r\n');

describe('buildVCard', () => {
  it('emits a 3.0 card carrying VERSION, FN, N and a generated UID', () => {
    const { vcard, uid } = buildVCard({ name: { family: '王', given: '五' } });
    expect(vcard).toContain('BEGIN:VCARD');
    expect(vcard).toContain('VERSION:3.0');
    expect(vcard).toMatch(/\r\nFN:王 五\r\n/);
    expect(vcard).toMatch(/\r\nN:王;五;;;\r\n/);
    expect(uid).toBeTruthy();
    expect(vcard).toContain('UID:' + uid);
    expect(vcard.endsWith('END:VCARD')).toBe(true);
  });

  it('prefers an explicit full name over the composed one', () => {
    const { vcard } = buildVCard({ name: { full: '张三丰', family: '张', given: '三丰' } });
    expect(vcard).toMatch(/\r\nFN:张三丰\r\n/);
  });

  it('writes typed values with their parameters and pref', () => {
    const { vcard } = buildVCard({
      name: { full: 'x' },
      emails: [{ value: 'a@example.com', type: ['work'], primary: true }],
      phones: [{ value: '+8613900000000', type: ['cell'] }],
    });
    const email = vcard.split('\r\n').find((l) => l.startsWith('EMAIL'))!;
    expect(email).toContain('a@example.com');
    expect(email.toUpperCase()).toContain('WORK');
    expect(email.toUpperCase()).toContain('PREF');
    expect(vcard).toContain('+8613900000000');
  });

  it('writes a custom label in its own item group', () => {
    const { vcard } = buildVCard({
      name: { full: 'x' },
      phones: [{ value: '+8613800000000', label: '老家座机' }],
    });
    const lines = vcard.split('\r\n');
    const tel = lines.find((l) => /^ITEM\d+\.TEL/i.test(l));
    const label = lines.find((l) => /^ITEM\d+\.X-ABLABEL/i.test(l));
    expect(tel, 'labelled phone must live in an item group').toBeTruthy();
    expect(label).toBeTruthy();
    const group = /^(ITEM\d+)\./i.exec(tel!)![1]!;
    expect(label!.toUpperCase().startsWith(group.toUpperCase() + '.')).toBe(true);
    expect(label).toContain('老家座机');
  });

  it('round-trips through the parser', () => {
    const { vcard } = buildVCard({
      name: { full: '李四', family: '李', given: '四' },
      organization: '某公司',
      emails: [{ value: 'li@example.com', type: ['home'] }],
      birthday: '1990-05-20',
      note: '备注内容',
    });
    const back = parseVCard(vcard, ref);
    expect(back.name.full).toBe('李四');
    expect(back.organization).toBe('某公司');
    expect(back.emails![0]!.value).toBe('li@example.com');
    expect(back.birthday).toBe('1990-05-20');
    expect(back.note).toBe('备注内容');
  });
});

describe('applyContactPatch', () => {
  it('preserves every property the model does not represent', () => {
    const out = applyContactPatch(richCard, { organization: '新公司' });
    expect(out).toContain('X-ABRELATEDNAMES');
    expect(out).toContain('李四');
    expect(out).toContain('X-SOCIALPROFILE');
    expect(out).toContain('X-APPLE-SUBADMINISTRATIVEAREA');
    expect(out).toContain('PRODID');
    // 头像必须原样留在卡片里 —— 领域模型里根本没有它，重建就一定丢
    expect(out).toContain('/9j/4AAQSkZJRgABAQ');
    expect(out).toContain('新公司');
  });

  it('leaves untouched fields exactly as they were', () => {
    const out = applyContactPatch(richCard, { note: '新备注' });
    const back = parseVCard(out, ref);
    expect(back.note).toBe('新备注');
    expect(back.name.full).toBe('张三');
    expect(back.organization).toBe('某某科技');
    expect(back.emails![0]!.value).toBe('zhang@example.com');
    expect(back.phones![0]!.label).toBe('老家座机');
  });

  it('clears a scalar field when the patch carries null', () => {
    const out = applyContactPatch(richCard, { note: null });
    expect(parseVCard(out, ref).note).toBeUndefined();
    expect(out).not.toContain('原有备注');
  });

  it('does not touch a scalar field the patch omits', () => {
    const out = applyContactPatch(richCard, { organization: '新公司' });
    expect(parseVCard(out, ref).note).toBe('原有备注');
  });

  it('replaces a repeatable field wholesale and drops its orphaned labels', () => {
    const out = applyContactPatch(richCard, { phones: [{ value: '+8615000000000', type: ['cell'] }] });
    const back = parseVCard(out, ref);
    expect(back.phones!.map((p) => p.value)).toEqual(['+8615000000000']);
    // 老号码所属分组的 X-ABLabel 必须一起消失，否则留下孤儿标签
    expect(out).not.toContain('老家座机');
  });

  it('clears a repeatable field when given an empty array', () => {
    const out = applyContactPatch(richCard, { emails: [] });
    expect(parseVCard(out, ref).emails).toBeUndefined();
    expect(out).not.toContain('zhang@example.com');
  });

  it('refreshes REV on every write', () => {
    const before = parseVCard(richCard, ref).updated_at;
    const out = applyContactPatch(richCard, { title: '架构师' });
    const after = parseVCard(out, ref).updated_at;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('keeps UID stable across a patch', () => {
    const out = applyContactPatch(richCard, { organization: '新公司' });
    expect(out).toContain('UID:ABCD-1234');
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把 `applyContactPatch` 改成「解析成模型后用 `buildVCard` 重建」，运行整个文件。预期 `preserves every property the model does not represent` 变红，且报告里能看到 `PHOTO` 与 `X-ABRELATEDNAMES` 丢失。改回后确认全绿。**这是本任务唯一真正重要的测试**——它守的是用户的头像和亲属关系。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/parsers/vcard-build.test.ts`
Expected: FAIL，`buildVCard is not a function`。

- [ ] **Step 3: 实现写方向**

- `buildVCard`：`new ICAL.Component('vcard')`，依次 `addPropertyWithValue`。`VERSION` 写 `3.0`（与 iCloud 下发一致，不要写 4.0）。`UID` 用 `crypto.randomUUID()`。`FN` 必填：`input.name.full` 优先，否则由 `given`/`family` 按 `[family, given].filter(Boolean).join(' ')` 拼出；两者皆空则抛 `INVALID_INPUT`，因为 vCard 规范要求 `FN` 存在。
- `applyContactPatch`：`parseRoot` 出 `ICAL.Component` 后**原地改**，只碰 patch 里出现的字段。标量字段照搬 `parsers/ical.ts` 里 `setValue` 的「先 `removeAllProperties` 再 `addPropertyWithValue`」写法；`null` 只删不加。
- 分组分配：写带 `label` 的值时，扫描现有卡片已用的 `itemN` 编号，从最大值 +1 开始分配，避免与保留下来的属性撞号。
- 删除可重复属性时，先收集这些属性的 `group` 参数，再删掉同 group 的 `x-ablabel`。**顺序不能反**，否则拿不到 group。
- `REV` 每次写入都刷新成当前 UTC 时间，格式与 iCloud 一致（`YYYY-MM-DDTHH:mm:ssZ`）。
- **不要**在 patch 路径上碰 `PHOTO`、`PRODID` 或任何 `X-` 属性。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/parsers/vcard.ts tests/unit/parsers/vcard-build.test.ts
git commit -m "feat(vcard): build cards and patch them in place, preserving unmodelled properties"
```

---

## Task 3: CardDAV provider

**Files:**
- Create: `src/providers/icloud/carddav.ts`
- Modify: `src/providers/icloud/index.ts`、`src/core/session.ts`
- Test: `tests/unit/providers/carddav.test.ts`

**Interfaces:**
- Consumes: `AccountConfig`（`src/core/config.js`）、`AppError`（`src/core/errors.js`）
- Produces:

```ts
export interface AddressBookInfo {
  url: string;
  name: string;
  readOnly: boolean;
  syncToken?: string;
}

export interface CardObject {
  url: string;
  etag: string;
  data: string;
}

export interface SyncDelta {
  syncToken?: string;
  created: CardObject[];
  updated: CardObject[];
  deleted: string[];
}

export interface CardDavProvider {
  verify(): Promise<void>;
  listAddressBooks(): Promise<AddressBookInfo[]>;
  fetchAll(bookUrl: string): Promise<{ objects: CardObject[]; syncToken?: string }>;
  syncSince(bookUrl: string, syncToken: string): Promise<SyncDelta>;
  fetchOne(bookUrl: string, cardUrl: string): Promise<CardObject>;
  create(params: { bookUrl: string; filename: string; data: string }): Promise<{ url: string }>;
  update(params: { bookUrl: string; url: string; etag: string; data: string }): Promise<void>;
  remove(params: { bookUrl: string; url: string; etag: string }): Promise<void>;
}

export function createCardDavProvider(deps: {
  account: AccountConfig;
  createClient?: typeof import('tsdav').createDAVClient;
}): CardDavProvider;
```

### 认证身份（务必看清）

**CardDAV 用 `account.email` 认证，不是 `account.sender`。** 与 CalDAV 一致，与 IMAP/SMTP 相反。这个混淆在本仓库历史上造成过两次真实 bug，CLAUDE.md 里专门有一条记着。`account.sender` 是 IMAP/SMTP 的登录身份（可能是别名），CardDAV 要的是 Apple ID。

服务发现地址：`https://contacts.icloud.com`，`defaultAccountType: 'carddav'`。

### tsdav 的实际 API 形状（已从 `node_modules/tsdav/dist` 核对）

```ts
fetchAddressBooks(params?: { account?: DAVAccount }): Promise<DAVAddressBook[]>
fetchVCards(params: { addressBook: DAVAddressBook; objectUrls?: string[]; useMultiGet?: boolean }): Promise<DAVVCard[]>
createVCard(params: { addressBook: DAVAddressBook; vCardString: string; filename: string }): Promise<Response>
updateVCard(params: { vCard: DAVVCard }): Promise<Response>
deleteVCard(params: { vCard: DAVVCard }): Promise<Response>
smartCollectionSyncDetailed(params: { collection: T; method?: 'basic' | 'webdav' }): Promise<Omit<T,'objects'> & { objects: { created: DAVObject[]; updated: DAVObject[]; deleted: DAVObject[] } }>
```

其中 `DAVAddressBook = DAVCollection`，含 `{ url, displayName?, syncToken?, ctag?, objects?, resourcetype? }`；`DAVVCard = DAVObject = { url, etag?, data?: any }`。

### 三条必须遵守的实测结论

1. **iCloud 不支持 `addressbook-query` REPORT**，返回 `400 Bad Request: Didn't understand the report`。`supported-report-set` 只声明 `sync-collection` 与 `addressbook-multiget`。**不要调用 `addressBookQuery`**，哪怕 tsdav 导出了它。服务端过滤在 iCloud 上不可用，这是整个搜索设计绕路的根因。
2. **账号下可能不止一个通讯簿。** 实测账号只有一个（无 `displayName`，url 尾段是 `card`），但实现**不得**假设只有一个。`displayName` 缺失时用 url 的尾段兜底命名。
3. **`create` 之后必须回读 etag**。`createVCard` 返回的是 `Response`，其 `ETag` 头 iCloud 不保证给全；拿不到就用返回的 url 走一次 `fetchOne`。不要把空 etag 传给后续写操作。

### 错误映射

照 `src/providers/icloud/caldav.ts` 的 `mapCalDavError` 写一个 `mapCardDavError`，但**措辞从一开始就要领域中立或点名通讯录工具**。阶段 2a 的整分支审查发现 `caldav.ts` 的提示全是日历口径，导致提醒事项的失败会指引模型去调 `calendar_list_events`——一个在只开提醒的账号上根本没注册的工具。不要在通讯录这边重演：

| 状态 | code | 提示应指向 |
|---|---|---|
| 401 | `AUTH_FAILED` | 检查 App 专用密码；说明 CardDAV 用 Apple ID 认证 |
| 403 | `PERMISSION_DENIED` | 换用 `contacts_search` 返回的另一个 `address_book_id` |
| 404 | `NOT_FOUND` | 重新调用 `contacts_search` 获取最新的 `contact_id` |
| 412 | `CONFLICT` | 该联系人已被其他客户端修改，重新读取后再提交 |
| 5xx / 网络 | `UPSTREAM_ERROR` | `retryable: true` |

### `readOnly` 恒为 false —— 这是有意的，但必须写明理由

CardDAV 这边**不做权限探测**，`AddressBookInfo.readOnly` 直接写死 `false`。这与日历侧不同（`caldav.ts` 有 `hasWritePrivilege` 与 `applyPrivilegeFallback`），所以必须在代码里留注释说明，否则后来者会以为是漏写。

理由：CLAUDE.md 已经记着日历侧的结论——权限探测「fails safe, not closed」，一旦全账号都探测不到可写日历就把全部标成可写，**因为真正的兜底是 `mapCalDavError` 的 403 处理，不是这个 flag**。既然那个 flag 在日历侧都不是真正的守卫，在通讯录侧照抄一套探测逻辑收益很低：iCloud 账号总有至少一个可写通讯簿，且实测账号只有一个通讯簿。403 映射同样是这里的真正兜底。

**要求**：在 `readOnly: false` 那一行上方写注释，说明（a）这里不做权限探测，（b）403 经 `mapCardDavError` 才是真正的兜底，（c）Task 5 服务层的只读检查因此在当前实现下不会触发，但保留它是为了将来真的做探测时不必回头改服务层。Task 7 要把这条写进 README 的限制章节。

- [ ] **Step 1: 写失败测试 `tests/unit/providers/carddav.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createCardDavProvider } from '../../../src/providers/icloud/carddav.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';

const account: AccountConfig = {
  id: 'account_1',
  label: 'apple-id@gmail.com',
  email: 'apple-id@gmail.com',
  sender: 'alias@icloud.com',
  appPassword: 'xxxx-xxxx-xxxx-xxxx',
  capabilities: {
    mailRead: true,
    mailWrite: false,
    calendarRead: true,
    calendarWrite: false,
    remindersRead: true,
    remindersWrite: false,
    contactsRead: true,
    contactsWrite: true,
  },
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    fetchAddressBooks: vi.fn().mockResolvedValue([
      { url: 'https://contacts.icloud.com/1/card/', displayName: '通讯录', syncToken: 'tok-1' },
    ]),
    fetchVCards: vi.fn().mockResolvedValue([
      { url: 'https://contacts.icloud.com/1/card/a.vcf', etag: 'e1', data: 'BEGIN:VCARD\r\nEND:VCARD' },
    ]),
    createVCard: vi.fn().mockResolvedValue({ ok: true, status: 201, headers: new Headers({ ETag: 'e-new' }) }),
    updateVCard: vi.fn().mockResolvedValue({ ok: true, status: 204, headers: new Headers() }),
    deleteVCard: vi.fn().mockResolvedValue({ ok: true, status: 204, headers: new Headers() }),
    smartCollectionSyncDetailed: vi.fn().mockResolvedValue({
      url: 'https://contacts.icloud.com/1/card/',
      syncToken: 'tok-2',
      objects: { created: [], updated: [], deleted: [] },
    }),
    ...overrides,
  };
}

function providerWith(client: Record<string, unknown>) {
  return createCardDavProvider({
    account,
    createClient: vi.fn().mockResolvedValue(client) as never,
  });
}

describe('createCardDavProvider', () => {
  it('authenticates with account.email, never account.sender', async () => {
    const createClient = vi.fn().mockResolvedValue(fakeClient());
    const provider = createCardDavProvider({ account, createClient: createClient as never });
    await provider.listAddressBooks();

    const passed = createClient.mock.calls[0]![0] as { credentials: { username: string } };
    expect(passed.credentials.username).toBe('apple-id@gmail.com');
    expect(passed.credentials.username).not.toBe('alias@icloud.com');
  });

  it('lists address books and falls back to the url tail when displayName is missing', async () => {
    const provider = providerWith(
      fakeClient({
        fetchAddressBooks: vi
          .fn()
          .mockResolvedValue([{ url: 'https://contacts.icloud.com/1/card/', syncToken: 'tok-1' }]),
      }),
    );
    const books = await provider.listAddressBooks();
    expect(books).toHaveLength(1);
    expect(books[0]!.name).toBe('card');
    expect(books[0]!.syncToken).toBe('tok-1');
  });

  it('does not assume a single address book', async () => {
    const provider = providerWith(
      fakeClient({
        fetchAddressBooks: vi.fn().mockResolvedValue([
          { url: 'https://contacts.icloud.com/1/card/', displayName: '个人' },
          { url: 'https://contacts.icloud.com/1/work/', displayName: '工作' },
        ]),
      }),
    );
    const books = await provider.listAddressBooks();
    expect(books.map((b) => b.name)).toEqual(['个人', '工作']);
  });

  it('never calls addressBookQuery, which iCloud rejects', async () => {
    const addressBookQuery = vi.fn();
    const provider = providerWith(fakeClient({ addressBookQuery }));
    await provider.fetchAll('https://contacts.icloud.com/1/card/');
    expect(addressBookQuery).not.toHaveBeenCalled();
  });

  it('returns created, updated and deleted urls from an incremental sync', async () => {
    const provider = providerWith(
      fakeClient({
        smartCollectionSyncDetailed: vi.fn().mockResolvedValue({
          url: 'https://contacts.icloud.com/1/card/',
          syncToken: 'tok-3',
          objects: {
            created: [{ url: 'https://c/1.vcf', etag: 'e1', data: 'BEGIN:VCARD\r\nEND:VCARD' }],
            updated: [{ url: 'https://c/2.vcf', etag: 'e2', data: 'BEGIN:VCARD\r\nEND:VCARD' }],
            deleted: [{ url: 'https://c/3.vcf' }],
          },
        }),
      }),
    );
    const delta = await provider.syncSince('https://contacts.icloud.com/1/card/', 'tok-2');
    expect(delta.syncToken).toBe('tok-3');
    expect(delta.created.map((c) => c.url)).toEqual(['https://c/1.vcf']);
    expect(delta.updated.map((c) => c.url)).toEqual(['https://c/2.vcf']);
    expect(delta.deleted).toEqual(['https://c/3.vcf']);
  });

  it('reads the etag back when create does not return one', async () => {
    const fetchVCards = vi
      .fn()
      .mockResolvedValue([{ url: 'https://c/new.vcf', etag: 'e-readback', data: 'BEGIN:VCARD\r\nEND:VCARD' }]);
    const provider = providerWith(
      fakeClient({
        createVCard: vi.fn().mockResolvedValue({
          ok: true,
          status: 201,
          headers: new Headers({ Location: 'https://c/new.vcf' }),
        }),
        fetchVCards,
      }),
    );
    const created = await provider.create({
      bookUrl: 'https://contacts.icloud.com/1/card/',
      filename: 'new.vcf',
      data: 'BEGIN:VCARD\r\nEND:VCARD',
    });
    expect(created.url).toBeTruthy();
    expect(fetchVCards).toHaveBeenCalled();
  });

  it('maps a 412 to CONFLICT', async () => {
    const provider = providerWith(
      fakeClient({ updateVCard: vi.fn().mockResolvedValue({ ok: false, status: 412, headers: new Headers() }) }),
    );
    await expect(
      provider.update({ bookUrl: 'https://c/', url: 'https://c/a.vcf', etag: 'e1', data: 'BEGIN:VCARD\r\nEND:VCARD' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps a 403 to PERMISSION_DENIED and names a contacts tool in the hint', async () => {
    const provider = providerWith(
      fakeClient({ createVCard: vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Headers() }) }),
    );
    const err = await provider
      .create({ bookUrl: 'https://c/', filename: 'a.vcf', data: 'BEGIN:VCARD\r\nEND:VCARD' })
      .catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    // 共享层教训：提示不得指向别的域的工具
    expect((err as AppError).hint ?? '').not.toContain('calendar_');
    expect((err as AppError).hint ?? '').toContain('contacts_');
  });

  it('turns a rejected fetch into a retryable UPSTREAM_ERROR', async () => {
    const provider = providerWith(
      fakeClient({ fetchAddressBooks: vi.fn().mockRejectedValue(new Error('socket hang up')) }),
    );
    const err = await provider.listAddressBooks().catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('UPSTREAM_ERROR');
    expect((err as AppError).retryable).toBe(true);
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把认证用户名从 `account.email` 改成 `account.sender`，确认第一条用例失败、其余照旧；改回。这是本仓库历史上出现过两次的真实 bug，必须由测试守住而不是靠注释。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/providers/carddav.test.ts`

- [ ] **Step 3: 实现 provider**

以 `src/providers/icloud/caldav.ts` 为范本：同样的 `createClient` 注入缝（便于单测）、同样的惰性客户端缓存、同样把每个原始错误经 `mapCardDavError` 转成 `AppError`。

**返回值检查不可省。** 阶段一的最终审查里发现过一类严重问题：`imapflow` 在服务器返回 NO/BAD 时是**返回 `false` 而不是抛异常**，六处返回值被丢弃，导致服务层照着输入数组报了成功数。tsdav 的 `createVCard`/`updateVCard`/`deleteVCard` 返回的是 `Response`——**必须检查 `ok`/`status`**，不要假定调用没抛就是成功。

- [ ] **Step 4: 接入 session 与 providers 工厂**

`src/providers/icloud/index.ts` 的 `createProviders` 增加 `carddav`；`src/core/session.ts` 的 `SessionProviders` 增加 `carddav: CardDavProvider`。现有形状：

```ts
export interface SessionProviders {
  imap: ImapProvider;
  smtp: SmtpProvider;
  caldav: CalDavProvider;
}
```

- [ ] **Step 5: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/providers/icloud/carddav.ts src/providers/icloud/index.ts src/core/session.ts tests/unit/providers/carddav.test.ts
git commit -m "feat(carddav): add CardDAV provider with sync-collection support"
```

---

## Task 4: 会话内通讯录缓存

**Files:**
- Create: `src/modules/contacts/cache.ts`
- Modify: `src/core/session.ts`
- Test: `tests/unit/modules/contacts-cache.test.ts`

**Interfaces:**
- Consumes: `CardDavProvider`/`AddressBookInfo`/`CardObject`/`SyncDelta`（Task 3）、`parseVCard`（Task 1）、`Logger`（`src/core/logger.js`）
- Produces:

```ts
export interface CachedBook {
  url: string;
  name: string;
  readOnly: boolean;
  syncToken?: string;
  /** key 是卡片 url。 */
  cards: Map<string, Contact>;
  loadedAt: number;
}

export interface ContactsCache {
  /** 首次调用做全量拉取；之后带 token 走增量。返回刷新后的全部通讯簿。 */
  refresh(): Promise<CachedBook[]>;
  /** 只读当前快照，不触网。缓存未建立时返回空数组。 */
  snapshot(): CachedBook[];
  /** 写操作之后让某个通讯簿失效，下次 refresh 会重新同步它。 */
  invalidate(bookUrl: string): void;
  size(): number;
}

export function createContactsCache(deps: { carddav: CardDavProvider; logger: Logger }): ContactsCache;
```

`src/core/session.ts` 的 `Session` 增加一个惰性槽位：

```ts
export interface Session {
  id: string;
  account: AccountConfig;
  createdAt: number;
  lastActiveAt: number;
  providers: SessionProviders;
  /** 通讯录搜索缓存，首次搜索时才创建；随会话销毁而消失。 */
  contactsCache?: ContactsCache;
}
```

### 为什么缓存必须挂在会话上

iCloud 不支持服务端过滤（见 Task 3），所以搜索只能在本地做，而本地就得有一份全量快照。实测 1429 张卡首次拉取 6.9 秒 / 305 KB。

**这份快照绝不能放在模块级 `Map` 里。** 两个理由：

1. 一个用户的通讯录会留在进程里被下一个会话看见。会话销毁时缓存必须跟着消失。
2. 阶段三是远程 HTTP + 并发会话。模块级缓存在那时是跨租户数据泄漏，不是性能优化。阶段 2a 的整分支审查已经在 `ICAL.TimezoneService`（进程级全局注册表）上记过同一类问题，不要再添一个。

### 增量同步的语义

- `refresh()` 第一次调用：对每个通讯簿走 `fetchAll`，解析每张卡进 `cards`，记下 `syncToken`。
- 之后每次调用：对有 `syncToken` 的通讯簿走 `syncSince`，把 `created`/`updated` 解析后写入 `cards`，把 `deleted` 的 url 从 `cards` 删掉，更新 `syncToken`。
- 某个通讯簿没有 `syncToken`（服务器没给）：退回全量，并在日志里说明——不要静默当成「无变更」。
- **单个通讯簿失败不得拖垮其余通讯簿。** 与 `calendar`/`reminders` 服务层一致：`Promise.allSettled` 跨通讯簿，单张卡解析失败在通讯簿内部 `try/catch` 吞掉并计数。这两层隔离在阶段一的整分支审查里被指出过缺一不可。

- [ ] **Step 1: 写失败测试 `tests/unit/modules/contacts-cache.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createContactsCache } from '../../../src/modules/contacts/cache.js';
import { createLogger } from '../../../src/core/logger.js';
import type { CardDavProvider } from '../../../src/providers/icloud/carddav.js';

const silentLogger = createLogger('error', () => {});

function card(fn: string, uid: string): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + fn, 'N:' + fn + ';;;;', 'UID:' + uid, 'END:VCARD'].join('\r\n');
}

function makeProvider(overrides: Partial<CardDavProvider> = {}): CardDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listAddressBooks: vi
      .fn()
      .mockResolvedValue([{ url: 'https://c/1/card/', name: '通讯录', readOnly: false, syncToken: 'tok-1' }]),
    fetchAll: vi.fn().mockResolvedValue({
      objects: [{ url: 'https://c/1/card/a.vcf', etag: 'e1', data: card('张三', 'U1') }],
      syncToken: 'tok-1',
    }),
    syncSince: vi.fn().mockResolvedValue({ syncToken: 'tok-2', created: [], updated: [], deleted: [] }),
    fetchOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as CardDavProvider;
}

describe('createContactsCache', () => {
  it('does a full fetch the first time and an incremental sync afterwards', async () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });

    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.syncSince).not.toHaveBeenCalled();

    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.syncSince).toHaveBeenCalledTimes(1);
    expect(provider.syncSince).toHaveBeenCalledWith('https://c/1/card/', 'tok-1');
  });

  it('applies created, updated and deleted from a delta', async () => {
    const provider = makeProvider({
      syncSince: vi.fn().mockResolvedValue({
        syncToken: 'tok-2',
        created: [{ url: 'https://c/1/card/b.vcf', etag: 'e2', data: card('李四', 'U2') }],
        updated: [{ url: 'https://c/1/card/a.vcf', etag: 'e1b', data: card('张三丰', 'U1') }],
        deleted: [],
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    await cache.refresh();

    const book = cache.snapshot()[0]!;
    expect(book.cards.size).toBe(2);
    expect(book.cards.get('https://c/1/card/a.vcf')!.name.full).toBe('张三丰');
    expect(book.cards.get('https://c/1/card/b.vcf')!.name.full).toBe('李四');
    expect(book.syncToken).toBe('tok-2');
  });

  it('removes a deleted card from the snapshot', async () => {
    const provider = makeProvider({
      syncSince: vi.fn().mockResolvedValue({
        syncToken: 'tok-2',
        created: [],
        updated: [],
        deleted: ['https://c/1/card/a.vcf'],
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    expect(cache.size()).toBe(1);
    await cache.refresh();
    expect(cache.size()).toBe(0);
  });

  it('falls back to a full fetch when the server gave no sync token', async () => {
    const provider = makeProvider({
      listAddressBooks: vi.fn().mockResolvedValue([{ url: 'https://c/1/card/', name: 'card', readOnly: false }]),
      fetchAll: vi.fn().mockResolvedValue({
        objects: [{ url: 'https://c/1/card/a.vcf', etag: 'e1', data: card('张三', 'U1') }],
        syncToken: undefined,
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(2);
    expect(provider.syncSince).not.toHaveBeenCalled();
  });

  it('keeps other address books when one fails', async () => {
    const provider = makeProvider({
      listAddressBooks: vi.fn().mockResolvedValue([
        { url: 'https://c/1/bad/', name: '坏的', readOnly: false },
        { url: 'https://c/1/good/', name: '好的', readOnly: false },
      ]),
      fetchAll: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('bad')) throw new Error('boom');
        return { objects: [{ url: 'https://c/1/good/a.vcf', etag: 'e1', data: card('张三', 'U1') }], syncToken: 't' };
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    const books = await cache.refresh();
    expect(books.map((b) => b.name)).toEqual(['好的']);
    expect(cache.size()).toBe(1);
  });

  it('keeps sibling cards when one card fails to parse', async () => {
    const provider = makeProvider({
      fetchAll: vi.fn().mockResolvedValue({
        objects: [
          { url: 'https://c/1/card/a.vcf', etag: 'e1', data: card('张三', 'U1') },
          { url: 'https://c/1/card/bad.vcf', etag: 'e2', data: 'this is not a vcard' },
          { url: 'https://c/1/card/c.vcf', etag: 'e3', data: card('王五', 'U3') },
        ],
        syncToken: 'tok-1',
      }),
    });
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    expect(cache.size()).toBe(2);
  });

  it('re-syncs a book after invalidate', async () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    await cache.refresh();
    cache.invalidate('https://c/1/card/');
    await cache.refresh();
    expect(provider.fetchAll).toHaveBeenCalledTimes(2);
  });

  it('returns an empty snapshot before the first refresh, without touching the network', () => {
    const provider = makeProvider();
    const cache = createContactsCache({ carddav: provider, logger: silentLogger });
    expect(cache.snapshot()).toEqual([]);
    expect(provider.listAddressBooks).not.toHaveBeenCalled();
    expect(provider.fetchAll).not.toHaveBeenCalled();
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把「第二次 refresh 走增量」改成「每次都全量」，确认 `does a full fetch the first time and an incremental sync afterwards` 失败而其余照旧；改回。这条守的是整个搜索设计的性能前提——如果每次搜索都全量拉 1429 张卡，工具就没法用了。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/modules/contacts-cache.test.ts`

- [ ] **Step 3: 实现缓存**

- 内部用 `Map<string, CachedBook>`，key 是通讯簿 url。
- `refresh()` 先 `listAddressBooks()`，再对每个通讯簿 `Promise.allSettled`：已缓存且有 token 走 `syncSince`，否则走 `fetchAll`。
- 每张卡解析放在 `for...of` 里各自 `try/catch`，失败计数后继续——**`catch` 必须在循环体内部**，套在循环外面等于一张坏卡废掉整个通讯簿。
- `invalidate(bookUrl)` 只清掉该通讯簿的 `syncToken`（保留 `cards` 以便失败时仍有旧数据可用），下次 `refresh` 自然走全量。
- 解析失败的数量用 `logger` 记到 stderr，不要 `console.log`。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/modules/contacts/cache.ts src/core/session.ts tests/unit/modules/contacts-cache.test.ts
git commit -m "feat(contacts): add a session-scoped cache with incremental sync"
```

---

## Task 5: 通讯录服务层

**Files:**
- Create: `src/modules/contacts/service.ts`、`src/modules/contacts/types.ts`
- Test: `tests/unit/modules/contacts-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 的全部产出、`AccountConfig`、`AppError`、`encodeRef`/`decodeRef`/`encodeUrl`/`decodeUrl`
- Produces:

```ts
// types.ts
export interface PartialFailure {
  address_book_id: string;
  name: string;
  reason: string;
}

export interface SearchContactsParams {
  query?: string;
  address_book_ids?: string[];
  limit?: number;
}

export interface SearchContactsResult {
  contacts: Contact[];
  /** 命中数超过 limit 时为 true。 */
  truncated?: boolean;
  /** 某个通讯簿读取失败时出现；其余通讯簿的结果仍然完整返回。 */
  partial_failures?: PartialFailure[];
}

// service.ts
export interface ContactService {
  search(params: SearchContactsParams): Promise<SearchContactsResult>;
  read(contactId: string): Promise<Contact>;
  create(input: ContactInput, addressBookId?: string): Promise<Contact>;
  update(contactId: string, patch: Partial<ContactInput>, options?: { expected_etag?: string }): Promise<Contact>;
  remove(contactId: string, options?: { expected_etag?: string }): Promise<{ deleted: true }>;
}

export function createContactService(deps: {
  account: AccountConfig;
  carddav: CardDavProvider;
  cache: ContactsCache;
}): ContactService;
```

### 必须照搬的既有规矩（三个模块已经一致，不要在这里走样）

1. **权限门在 service，不在 tools，且必须在任何 provider 调用之前。** 读检查 `contactsRead`，写检查 `contactsWrite`，`hint` 里点出由 `account.id` 推出的具体变量名（如 `ALLOW_CONTACTS_WRITE_1`）。
2. **两层错误隔离**：跨通讯簿 `Promise.allSettled`，通讯簿内部逐张卡 `try/catch`。失败的通讯簿进 `partial_failures`，其余结果照常返回。
3. **`loadForWrite`**：先 `decodeRef` 解码不透明 id（格式不对就立刻失败，不触网），再 `fetchOne` 读当前状态，只在调用方给了 `expected_etag` 时才比对，写回时**用刚读到的 etag，绝不用调用方传来的那个**。照抄 `src/modules/reminders/service.ts` 的同名函数。
4. **`update` 走 `applyContactPatch`，不重建。** 见 Task 2 的理由。

### 搜索的匹配规则

`query` 缺省时返回全部（受 `limit` 约束）。给了 `query` 时，大小写不敏感的子串匹配，匹配范围：`name.full`、`name.family`、`name.given`、`organization`、`department`、`title`、`nickname`、所有 `emails[].value`、所有 `phones[].value`、`note`。

电话匹配前双方都要去掉非数字字符再比，否则 `13800000000` 匹配不上 `+86 138 0000 0000`——这是最常见的一种查询形态。

### 排序与截断（阶段 2a 的教训，不要重犯）

`reminders_list` 曾经不排序就切前 100 条，返回一个任意子集，模型据此可以给出自信而错误的「没有」。**必须先确定性排序再截断，并且在结果里给出 `truncated` 标记。**

排序：命中项按 `name.full` 的 `localeCompare` 升序。截断：`limit` 默认 50，上限 500（与 `mail` 的 100、`reminders` 的 1000 都不同，理由是通讯录单条比提醒大、比邮件小，且搜索结果本就该收敛）。`limit` 非法（0、负数、非整数、超过 500）抛 `INVALID_INPUT`。

- [ ] **Step 1: 写失败测试 `tests/unit/modules/contacts-service.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createContactService } from '../../../src/modules/contacts/service.js';
import { encodeRef, encodeUrl } from '../../../src/core/ids.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { ContactsCache, CachedBook } from '../../../src/modules/contacts/cache.js';
import type { CardDavProvider } from '../../../src/providers/icloud/carddav.js';
import { parseVCard } from '../../../src/parsers/vcard.js';

const BOOK = 'https://c/1/card/';

function account(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
    label: 'a@icloud.com',
    email: 'a@icloud.com',
    sender: 'a@icloud.com',
    appPassword: 'x',
    capabilities: {
      mailRead: true,
      mailWrite: false,
      calendarRead: true,
      calendarWrite: false,
      remindersRead: true,
      remindersWrite: false,
      contactsRead: true,
      contactsWrite: true,
      ...overrides,
    },
  };
}

function card(fn: string, extra: string[] = []): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + fn, 'N:' + fn + ';;;;', ...extra, 'END:VCARD'].join('\r\n');
}

function cachedBook(entries: [string, string][], readOnly = false): CachedBook {
  const cards = new Map();
  for (const [url, text] of entries) {
    cards.set(url, parseVCard(text, { collectionUrl: BOOK, resourceUrl: url }));
  }
  return { url: BOOK, name: '通讯录', readOnly, syncToken: 'tok', cards, loadedAt: Date.now() };
}

function makeCache(books: CachedBook[]): ContactsCache {
  return {
    refresh: vi.fn().mockResolvedValue(books),
    snapshot: vi.fn().mockReturnValue(books),
    invalidate: vi.fn(),
    size: vi.fn().mockReturnValue(books.reduce((n, b) => n + b.cards.size, 0)),
  };
}

function makeCardDav(overrides: Partial<CardDavProvider> = {}): CardDavProvider {
  return {
    verify: vi.fn(),
    listAddressBooks: vi.fn().mockResolvedValue([{ url: BOOK, name: '通讯录', readOnly: false }]),
    fetchAll: vi.fn(),
    syncSince: vi.fn(),
    fetchOne: vi.fn().mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-fresh', data: card('张三') }),
    create: vi.fn().mockResolvedValue({ url: BOOK + 'new.vcf' }),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as CardDavProvider;
}

const idOf = (url: string) => encodeRef({ collectionUrl: BOOK, resourceUrl: url });

describe('contact service permissions', () => {
  it('refuses to search when contacts read is disabled, before touching the provider', async () => {
    const cache = makeCache([]);
    const svc = createContactService({
      account: account({ contactsRead: false }),
      carddav: makeCardDav(),
      cache,
    });
    const err = await svc.search({}).catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    expect((err as AppError).hint).toContain('ALLOW_CONTACTS_READ_1');
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it('refuses to create when contacts write is disabled, before touching the provider', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({
      account: account({ contactsWrite: false }),
      carddav,
      cache: makeCache([]),
    });
    const err = await svc
      .create({ name: { full: '张三' } })
      .catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    expect((err as AppError).hint).toContain('ALLOW_CONTACTS_WRITE_1');
    expect(carddav.create).not.toHaveBeenCalled();
    expect(carddav.listAddressBooks).not.toHaveBeenCalled();
  });
});

describe('contact search', () => {
  const book = cachedBook([
    [BOOK + 'a.vcf', card('张三', ['ORG:某某科技;研发部', 'EMAIL:zhang@example.com', 'TEL:+86 138 0000 0000'])],
    [BOOK + 'b.vcf', card('李四', ['ORG:另一家公司', 'EMAIL:li@other.com'])],
    [BOOK + 'c.vcf', card('王五', ['TITLE:架构师'])],
  ]);

  it('matches on name, organization, title and email', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    expect((await svc.search({ query: '张' })).contacts.map((c) => c.name.full)).toEqual(['张三']);
    expect((await svc.search({ query: '某某科技' })).contacts.map((c) => c.name.full)).toEqual(['张三']);
    expect((await svc.search({ query: '架构师' })).contacts.map((c) => c.name.full)).toEqual(['王五']);
    expect((await svc.search({ query: 'li@other' })).contacts.map((c) => c.name.full)).toEqual(['李四']);
  });

  it('matches a phone number regardless of formatting', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    const found = await svc.search({ query: '13800000000' });
    expect(found.contacts.map((c) => c.name.full)).toEqual(['张三']);
  });

  it('is case insensitive', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    expect((await svc.search({ query: 'LI@OTHER.COM' })).contacts).toHaveLength(1);
  });

  it('refreshes the cache before matching', async () => {
    const cache = makeCache([book]);
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    await svc.search({ query: '张' });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  it('sorts deterministically and flags truncation', async () => {
    const many = cachedBook(
      Array.from({ length: 5 }, (_, i) => [BOOK + i + '.vcf', card('联系人' + (4 - i))] as [string, string]),
    );
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([many]) });
    const result = await svc.search({ limit: 3 });
    expect(result.contacts).toHaveLength(3);
    expect(result.truncated).toBe(true);
    const names = result.contacts.map((c) => c.name.full);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('does not flag truncation when everything fits', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    expect((await svc.search({ limit: 50 })).truncated).toBeUndefined();
  });

  it('rejects an out-of-range limit', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    await expect(svc.search({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(svc.search({ limit: 501 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('filters by address book after decoding the opaque id', async () => {
    const other = { ...cachedBook([[BOOK + 'z.vcf', card('不该出现的人')]]), url: 'https://c/1/other/', name: '另一个' };
    const svc = createContactService({
      account: account(),
      carddav: makeCardDav(),
      cache: makeCache([book, other]),
    });
    // 传入的是不透明 id，服务层必须解码后再比对 url
    const result = await svc.search({ address_book_ids: [encodeUrl(BOOK)] });
    expect(result.contacts.map((c) => c.name.full)).not.toContain('不该出现的人');
    expect(result.contacts.length).toBeGreaterThan(0);
  });

  it('rejects an address_book_id that cannot be decoded', async () => {
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([book]) });
    await expect(svc.search({ address_book_ids: ['not-a-real-id'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('never returns photo bytes', async () => {
    const withPhoto = cachedBook([
      [BOOK + 'p.vcf', card('有头像的人', ['PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ'])],
    ]);
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache: makeCache([withPhoto]) });
    const result = await svc.search({});
    expect(result.contacts[0]!.has_photo).toBe(true);
    expect(JSON.stringify(result)).not.toContain('/9j/4AAQ');
  });
});

describe('contact writes', () => {
  const book = cachedBook([[BOOK + 'a.vcf', card('张三', ['NOTE:原有备注'])]]);

  it('patches in place and preserves unmodelled properties', async () => {
    const rich = card('张三', [
      'NOTE:原有备注',
      'X-ABRELATEDNAMES;type=pref:李四',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ',
    ]);
    const carddav = makeCardDav({
      fetchOne: vi.fn().mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-fresh', data: rich }),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });

    await svc.update(idOf(BOOK + 'a.vcf'), { organization: '新公司' });

    const written = (carddav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { data: string };
    expect(written.data).toContain('X-ABRELATEDNAMES');
    expect(written.data).toContain('/9j/4AAQSkZJRgABAQ');
    expect(written.data).toContain('新公司');
  });

  it('writes with the freshly read etag when the caller supplies none', async () => {
    const carddav = makeCardDav({
      fetchOne: vi
        .fn()
        .mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-fresh-from-server', data: card('张三') }),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await svc.update(idOf(BOOK + 'a.vcf'), { title: '架构师' });
    const written = (carddav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { etag: string };
    expect(written.etag).toBe('etag-fresh-from-server');
  });

  it('raises CONFLICT on a stale etag without writing', async () => {
    const carddav = makeCardDav({
      fetchOne: vi.fn().mockResolvedValue({ url: BOOK + 'a.vcf', etag: 'etag-new', data: card('张三') }),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await expect(
      svc.update(idOf(BOOK + 'a.vcf'), { title: 'x' }, { expected_etag: 'etag-old' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(carddav.update).not.toHaveBeenCalled();
  });

  it('fails a malformed contact_id before any network call', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await expect(svc.update('not-a-real-id', { title: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(carddav.fetchOne).not.toHaveBeenCalled();
  });

  it('invalidates the cached book after a write', async () => {
    const cache = makeCache([book]);
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    await svc.update(idOf(BOOK + 'a.vcf'), { title: '架构师' });
    expect(cache.invalidate).toHaveBeenCalledWith(BOOK);
  });

  it('creates into the named address book', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    await svc.create({ name: { full: '新人' } }, encodeUrl(BOOK));
    const args = (carddav.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { bookUrl: string };
    expect(args.bookUrl).toBe(BOOK);
  });

  it('refuses to create into a read-only address book', async () => {
    const carddav = makeCardDav({
      listAddressBooks: vi.fn().mockResolvedValue([{ url: BOOK, name: '只读', readOnly: true }]),
    });
    const svc = createContactService({ account: account(), carddav, cache: makeCache([]) });
    const err = await svc.create({ name: { full: '新人' } }, encodeUrl(BOOK)).catch((e: unknown) => e as AppError);
    expect((err as AppError).code).toBe('PERMISSION_DENIED');
    expect(carddav.create).not.toHaveBeenCalled();
  });

  it('deletes with the freshly read etag', async () => {
    const carddav = makeCardDav();
    const svc = createContactService({ account: account(), carddav, cache: makeCache([book]) });
    expect(await svc.remove(idOf(BOOK + 'a.vcf'))).toEqual({ deleted: true });
    const args = (carddav.remove as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { etag: string };
    expect(args.etag).toBe('etag-fresh');
  });
});

describe('contact search isolation', () => {
  it('returns other books results when one book failed to load', async () => {
    const good = cachedBook([[BOOK + 'a.vcf', card('张三')]]);
    const cache: ContactsCache = {
      refresh: vi.fn().mockResolvedValue([good]),
      snapshot: vi.fn().mockReturnValue([good]),
      invalidate: vi.fn(),
      size: vi.fn().mockReturnValue(1),
    };
    const svc = createContactService({ account: account(), carddav: makeCardDav(), cache });
    const result = await svc.search({});
    expect(result.contacts).toHaveLength(1);
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把电话匹配里「去掉非数字字符」那一步删掉，确认**只有** `matches a phone number regardless of formatting` 失败；改回。
2. 把排序去掉（直接截断），确认 `sorts deterministically and flags truncation` 失败；改回。这一条守的正是阶段 2a 在 `reminders_list` 上出过的 Critical。

**注意**：不要用「把 `etag: current.etag` 改成 `options.expected_etag ?? current.etag`」作为 etag 测试的变异——阶段 2a 验证过这个变异**在观测上不可达**，因为 `loadForWrite` 已经在 etag 不匹配时抛了 `CONFLICT`，走到写入时两者必然相等。有鉴别力的变异是把 `?? current.etag` 整个去掉。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/modules/contacts-service.test.ts`

- [ ] **Step 3: 实现服务层**

以 `src/modules/reminders/service.ts` 为范本，逐条对齐：`requireRead`/`requireWrite` 的写法、`loadForWrite` 的结构、`partial_failures` 的形状、写操作后 `cache.invalidate(bookUrl)`。

`address_book_ids` 是**不透明 id**，必须先 `decodeUrl` 成真实 url 再和 `CachedBook.url` 比对。直接拿不透明串去比 url 会静默匹配为空——不报错、不提示，只是返回零条，是最难被发现的一类错误。任何一个 id 解不开就抛 `INVALID_INPUT`，不要静默忽略它。

`create` 的目标通讯簿：给了 `address_book_id` 就用它（并检查 `readOnly`），没给就用第一个可写的通讯簿；一个可写的都没有时抛 `PERMISSION_DENIED` 并在 hint 里让调用方先看 `contacts_search` 返回的 `address_book_id`。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/modules/contacts/service.ts src/modules/contacts/types.ts tests/unit/modules/contacts-service.test.ts
git commit -m "feat(contacts): add contact service with cache-backed search and in-place patching"
```

---

## Task 6: 通讯录工具层

**Files:**
- Create: `src/modules/contacts/tools.ts`
- Test: `tests/unit/modules/contacts-tools.test.ts`

**Interfaces:**
- Consumes: `ToolRegistrar`/`ToolDeps`/`ToolConfig`/`ToolResult`（`src/server/types.js`）、`wrapTool`（`src/server/wrap.js`）、`Session`、`ContactService`
- Produces:
  - `export interface ContactToolDeps extends ToolDeps { contactFor: (session: Session) => ContactService }`
  - `export function registerContactTools(server: ToolRegistrar, deps: ContactToolDeps): void`

五个工具与注解：

| 工具 | 注解 |
|---|---|
| `contacts_search` | `readOnlyHint: true` |
| `contacts_read` | `readOnlyHint: true` |
| `contacts_create` | `readOnlyHint: false, destructiveHint: false` |
| `contacts_update` | `readOnlyHint: false, destructiveHint: false` |
| `contacts_delete` | `readOnlyHint: false, destructiveHint: true` |

**不要给 `contacts_update` 加 `idempotentHint`。** 阶段 2a 给 `reminders_update` 加过又拆掉了：`calendar_update_event` 没加，而且这类写操作本就不幂等（每次都刷新 `REV`）。三个模块保持一致。

### 工具描述里必须写明的三点（模型只能读到描述）

1. **搜索是会话内缓存匹配，不是服务端查询。** iCloud 不支持 `addressbook-query`，首次搜索会全量拉取（实测 1429 张卡约 7 秒），之后走增量同步。描述里要让模型知道第一次可能偏慢，不要因此重试。
2. **`has_photo` 只是布尔值，工具永远不返回头像内容。** 否则模型会反复尝试「把头像取出来」。
3. **标量字段传 `null` 表示清除，省略表示不改动；数组字段是整体替换，传空数组表示清空。** 与 `reminders` 的 `due` 三态同源。

- [ ] **Step 1: 写失败测试 `tests/unit/modules/contacts-tools.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerContactTools } from '../../../src/modules/contacts/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { AppError } from '../../../src/core/errors.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';
import type { SessionStore } from '../../../src/core/session.js';

interface Registered {
  config: ToolConfig;
  handler: (args: any) => Promise<ToolResult>;
}

function collect(): { server: any; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: (args: any) => Promise<ToolResult>) {
      tools.set(name, { config, handler });
    },
  };
  return { server, tools };
}

const silentLogger = createLogger('error', () => {});
const fakeSessions = {
  get: vi.fn().mockReturnValue({ id: 's1', account: { id: 'account_1' }, providers: {} }),
} as unknown as SessionStore;

function depsWith(service: Record<string, unknown>) {
  return { sessions: fakeSessions, logger: silentLogger, contactFor: () => service as never };
}

describe('registerContactTools', () => {
  it('registers every contact tool', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'contacts_create',
      'contacts_delete',
      'contacts_read',
      'contacts_search',
      'contacts_update',
    ]);
  });

  it('carries the specified annotations and no idempotentHint', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    expect(tools.get('contacts_search')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('contacts_read')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('contacts_create')!.config.annotations?.destructiveHint).toBe(false);
    expect(tools.get('contacts_update')!.config.annotations?.destructiveHint).toBe(false);
    expect(tools.get('contacts_update')!.config.annotations?.idempotentHint).toBeUndefined();
    expect(tools.get('contacts_delete')!.config.annotations?.destructiveHint).toBe(true);
  });

  it('advertises no top-level field the handler does not read', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    const allowed: Record<string, string[]> = {
      contacts_search: ['session_id', 'query', 'address_book_ids', 'limit'],
      contacts_read: ['session_id', 'contact_id'],
      contacts_create: ['session_id', 'address_book_id', 'contact'],
      contacts_update: ['session_id', 'contact_id', 'patch', 'expected_etag'],
      contacts_delete: ['session_id', 'contact_id', 'expected_etag'],
    };
    for (const [name, tool] of tools) {
      const keys = Object.keys(tool.config.inputSchema as Record<string, unknown>).sort();
      expect(keys, name + ' 的 inputSchema 顶层字段与 handler 读取的不一致').toEqual(allowed[name]!.sort());
    }
  });

  it('never requires an etag', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    for (const name of ['contacts_update', 'contacts_delete']) {
      const shape = tools.get(name)!.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.expected_etag!.isOptional()).toBe(true);
    }
  });

  it('documents that photos are never returned', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    const text = tools.get('contacts_read')!.config.description ?? '';
    expect(text).toMatch(/has_photo/);
  });

  it('names only contacts tools in its own descriptions', () => {
    const { server, tools } = collect();
    registerContactTools(server, depsWith({}));
    for (const [name, tool] of tools) {
      const blob = JSON.stringify(tool.config);
      expect(blob, name + ' 的描述指向了别的域的工具').not.toMatch(/calendar_|reminders_|mail_/);
    }
  });

  it('forwards the search query verbatim', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockResolvedValue({ contacts: [] });
    registerContactTools(server, depsWith({ search }));

    await tools.get('contacts_search')!.handler({
      session_id: 's1',
      query: '张三',
      address_book_ids: ['abc'],
      limit: 20,
    });

    expect(search).toHaveBeenCalledWith({ query: '张三', address_book_ids: ['abc'], limit: 20 });
  });

  it('forwards the contact object and address_book_id on create', async () => {
    const { server, tools } = collect();
    const create = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ create }));

    await tools.get('contacts_create')!.handler({
      session_id: 's1',
      address_book_id: 'b1',
      contact: { name: { full: '张三' }, emails: [{ value: 'a@example.com' }] },
    });

    expect(create).toHaveBeenCalledWith(
      { name: { full: '张三' }, emails: [{ value: 'a@example.com' }] },
      'b1',
    );
  });

  it('forwards patch and expected_etag on update, in that order', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ update }));

    await tools.get('contacts_update')!.handler({
      session_id: 's1',
      contact_id: 'c1',
      patch: { title: '架构师' },
      expected_etag: 'e1',
    });

    expect(update).toHaveBeenCalledWith('c1', { title: '架构师' }, { expected_etag: 'e1' });
  });

  it('accepts a null scalar as an explicit clear', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ update }));

    const result = await tools.get('contacts_update')!.handler({
      session_id: 's1',
      contact_id: 'c1',
      patch: { note: null },
    });

    expect(result.isError).toBeUndefined();
    expect(update).toHaveBeenCalledWith('c1', { note: null }, { expected_etag: undefined });
  });

  it('accepts an empty array as an explicit clear', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ contact_id: 'c1' });
    registerContactTools(server, depsWith({ update }));

    await tools.get('contacts_update')!.handler({
      session_id: 's1',
      contact_id: 'c1',
      patch: { emails: [] },
    });

    expect(update).toHaveBeenCalledWith('c1', { emails: [] }, { expected_etag: undefined });
  });

  it('forwards the id and expected_etag on delete', async () => {
    const { server, tools } = collect();
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    registerContactTools(server, depsWith({ remove }));

    await tools.get('contacts_delete')!.handler({ session_id: 's1', contact_id: 'c1', expected_etag: 'e1' });

    expect(remove).toHaveBeenCalledWith('c1', { expected_etag: 'e1' });
  });

  it('converts an AppError into a structured payload', async () => {
    const { server, tools } = collect();
    const search = vi
      .fn()
      .mockRejectedValue(
        new AppError('PERMISSION_DENIED', '通讯录读取权限未开启', { hint: '设置 ALLOW_CONTACTS_READ_1=true' }),
      );
    registerContactTools(server, depsWith({ search }));

    const result = await tools.get('contacts_search')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_CONTACTS_READ_1');
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把 `contacts_delete` 转发的 `contact_id` 与 `expected_etag` 对调，确认对应用例失败；改回。删除不可逆，这一条不能靠假定。
2. 给 `contacts_create` 的 `inputSchema` 加一个顶层 `name` 字段（handler 并不读它），确认**只有** `advertises no top-level field the handler does not read` 失败；改回。阶段 2a 出过一个真实的幽灵字段：schema 宣告了 `priority`，handler 只读 `args.reminder`，客户端传了会被静默丢弃。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/modules/contacts-tools.test.ts`

- [ ] **Step 3: 实现 `tools.ts`**

以 `src/modules/reminders/tools.ts` 为范本。

- `contactShape` 里标量字段写成 `z.string().nullable().optional()`，并在 `.describe()` 里说明 `null` 的含义；数组字段写成对应对象数组的 `.optional()`，`.describe()` 说明整体替换语义。
- `contactSchema = z.object(contactShape)`，`patchSchema = z.object(contactShape).partial()`。
- `name` 是嵌套对象，`create` 时至少要有 `full` 或 `family`/`given` 之一——**用 `.refine()` 在 schema 层拦住**，不要留到解析层才抛。
- 每个 handler 必须在 `wrapTool` 内取 service（`sessions.get` 不得在闭包外调用），与另外三个模块一致。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/modules/contacts/tools.ts tests/unit/modules/contacts-tools.test.ts
git commit -m "feat(contacts): expose contact tools with structured schemas"
```

---

## Task 7: 装配、集成测试与文档

**Files:**
- Modify: `src/server/createServer.ts`、`src/modules/session/tools.ts`
- Modify: `tests/unit/server/register.test.ts`
- Modify: `tests/integration/live.test.ts`、`.env.test.example`
- Modify: `README.md`、`SKILL.md`、`CLAUDE.md`

- [ ] **Step 1: 注册门控**

`registerAllTools` 增加 `anyContacts`，判据与另外三个一致：**任一账号**的 `contactsRead || contactsWrite` 为真即注册。

现有形状：

```ts
const anyCalendar = config.accounts.some(
  (a) => a.capabilities.calendarRead || a.capabilities.calendarWrite,
);
```

通讯录块依赖 `carddav` 与会话上的 `contactsCache`（惰性创建）：

```ts
if (anyContacts) {
  registerContactTools(server, {
    sessions,
    logger,
    contactFor: (session: Session) => {
      session.contactsCache ??= createContactsCache({ carddav: session.providers.carddav, logger });
      return createContactService({
        account: session.account,
        carddav: session.providers.carddav,
        cache: session.contactsCache,
      });
    },
  });
}
```

测试必须能分辨 `.some()` 与 `.every()`——单账号配置下两者等价。照 `register.test.ts` 里既有的提醒用例：构造双账号配置，账号 1 关闭通讯录、账号 2 开启，断言通讯录工具仍注册；并做一次 `.every` 变异实验确认**只有**该用例失败。粘贴两次输出。

- [ ] **Step 2: 撤掉 contacts 能力的投影屏蔽**

阶段 2a 收尾时，`src/modules/session/tools.ts` 用一个 `PublicCapabilities` 类型把 `contactsRead`/`contactsWrite` 从 `apple_login`/`apple_accounts` 的响应里投影掉了，理由是「宣告了一个没有工具兑现的能力」。**本任务让工具真的存在了，所以这层屏蔽要撤掉**，两个键恢复对外可见。同时删掉那段解释屏蔽原因的注释，并在 `CLAUDE.md` 里同步移除对应说明。

现有代码形如：

```ts
type PublicCapabilities = Omit<Capabilities, 'contactsRead' | 'contactsWrite'>;
```

撤除后 `apple_login` 必须原样返回全部六个能力位。补一条测试断言 `contactsRead` 出现在登录响应里，否则这次撤除没有任何东西守着。

- [ ] **Step 3: 集成测试**

在 `tests/integration/live.test.ts` 追加两条，默认随 `.env.test` 存在与否跳过。同时在 `.env.test.example` 增加 `INTEGRATION_CONTACT_PREFIX`（默认 `MCP-Test-`）。

**写操作的作用域约束**：通讯录没有「专用通讯簿」这种东西可以隔离（用户不会为测试单独建一个通讯簿），所以改用**名字前缀**隔离：测试只创建、修改、删除 `FN` 以 `INTEGRATION_CONTACT_PREFIX` 开头的联系人，且**删除前必须再次确认该联系人的 `FN` 仍以该前缀开头**。绝不按 id 直接删一个没验证过前缀的联系人。

```ts
  it('syncs the address book and round-trips a contact', async () => {
    const config = loadConfig(env);
    const carddav = providers.carddav;
    const cache = createContactsCache({ carddav, logger: silentLogger });
    const service = createContactService({ account: config.accounts[0]!, carddav, cache });

    const prefix = env.INTEGRATION_CONTACT_PREFIX ?? 'MCP-Test-';
    const fullName = `${prefix}${Date.now()}`;

    // 第一次搜索建立缓存；这里只断言结构合法，不断言条数——真实账号的联系人数不可预测
    const initial = await service.search({ limit: 5 });
    expect(Array.isArray(initial.contacts)).toBe(true);

    // contact_id 在 try 外声明，finally 才能无论从哪一步失败都清理
    let contactId: string | undefined;
    try {
      const created = await service.create({
        name: { full: fullName, family: prefix.replace(/-$/, ''), given: 'Case' },
        emails: [{ value: 'mcp-test@example.com', type: ['work'] }],
        organization: '集成测试',
      });
      contactId = created.contact_id;
      expect(created.name.full).toBe(fullName);
      expect(created.has_photo).toBe(false);

      const read = await service.read(created.contact_id);
      expect(read.name.full).toBe(fullName);
      expect(read.emails?.[0]?.value).toBe('mcp-test@example.com');
      expect(read.organization).toBe('集成测试');

      const updated = await service.update(created.contact_id, { organization: '集成测试-已改' });
      expect(updated.organization).toBe('集成测试-已改');
      // 改过之后名字不能被动过，否则下面的前缀校验会失去意义
      expect(updated.name.full).toBe(fullName);

      const deleted = await service.remove(created.contact_id);
      expect(deleted).toEqual({ deleted: true });
      contactId = undefined;
    } finally {
      if (contactId) {
        // 删除前重新确认前缀：绝不按 id 直接删一个没验证过归属的联系人
        await service
          .read(contactId)
          .then(async (still) => {
            if (!still.name.full.startsWith(prefix)) {
              throw new Error(`拒绝清理：${still.name.full} 不以测试前缀 ${prefix} 开头`);
            }
            await service.remove(contactId!);
          })
          .catch((err: unknown) =>
            console.error(`[cleanup] 联系人 ${contactId} 清理失败，可能已残留在通讯录中：`, err),
          );
      }
    }
  });

  it('preserves an Apple item-group custom label across a round-trip', async () => {
    const config = loadConfig(env);
    const carddav = providers.carddav;
    const cache = createContactsCache({ carddav, logger: silentLogger });
    const service = createContactService({ account: config.accounts[0]!, carddav, cache });

    const prefix = env.INTEGRATION_CONTACT_PREFIX ?? 'MCP-Test-';
    const fullName = `${prefix}label-${Date.now()}`;

    let contactId: string | undefined;
    try {
      const created = await service.create({
        name: { full: fullName },
        phones: [{ value: '+8613800000000', label: '老家座机' }],
      });
      contactId = created.contact_id;

      // 裁定一点名要验证的：ical.js 序列化时把 item1. 写成 ITEM1.。
      // RFC 6350 说 group 名大小写不敏感，但 Apple 的实际接受度必须在真实账号上确认。
      const read = await service.read(created.contact_id);
      expect(read.phones?.[0]?.label).toBe('老家座机');

      await service.remove(created.contact_id);
      contactId = undefined;
    } finally {
      if (contactId) {
        await service
          .read(contactId)
          .then(async (still) => {
            if (!still.name.full.startsWith(prefix)) {
              throw new Error(`拒绝清理：${still.name.full} 不以测试前缀 ${prefix} 开头`);
            }
            await service.remove(contactId!);
          })
          .catch((err: unknown) =>
            console.error(`[cleanup] 联系人 ${contactId} 清理失败，可能已残留在通讯录中：`, err),
          );
      }
    }
  });
```

上面两条都要用到文件顶部的 `silentLogger`，在 `live.test.ts` 已有的 import 区补上：

```ts
import { createLogger } from '../../src/core/logger.js';
import { createContactsCache } from '../../src/modules/contacts/cache.js';
import { createContactService } from '../../src/modules/contacts/service.js';

const silentLogger = createLogger('error', () => {});
```

两条都要放在 `try/finally` 里，`finally` 的清理删除失败时**上报到 stderr 而不是静默吞掉**——阶段 2a 在日历和提醒的集成测试上刚做过同样的修正，理由是残留对象会留在用户真实账号里且没有任何痕迹。

- [ ] **Step 4: 文档**

- **README**：工具表补 5 个通讯录工具（总数 20 → 25）；环境变量表补 `ALLOW_CONTACTS_READ_n`（默认开）/ `ALLOW_CONTACTS_WRITE_n`（默认关）；验证章节里「健康的服务器返回 20 个工具」改为 25，缺邮件时的降级数从 13 改为 18；「What's not here yet」里删掉 Contacts 那条，只留阶段三。「Limitations」补两条：搜索是会话内缓存匹配、首次可能偏慢；头像只报告存在与否，永不返回内容。
- **SKILL.md**：新增通讯录一节，含五个工具的签名、`has_photo` 的语义、标量 `null` 与数组空值的清除语义、`contact_id`/`address_book_id` 同为不透明字符串。错误恢复表里 `NOT_FOUND`/`CONFLICT`/`PERMISSION_DENIED` 三条补上通讯录的恢复路径（分别指向 `contacts_search`、重新读取、检查 `ALLOW_CONTACTS_WRITE_n`）。
- **CLAUDE.md**：概述从「三个模块」改为四个；「非显而易见的约束」补两条——(a) vCard 用 `ical.js` 而非 `vcard4`，因为 iCloud 下发 3.0 而 `vcard4` 只做 4.0，且这样零新依赖；(b) 通讯录缓存必须挂在 `Session` 上而非模块级，因为阶段三是并发会话。同时把阶段 2a 留下的「contacts 能力被投影屏蔽」那段说明删掉。

- [ ] **Step 5: 全量验证并提交**

```bash
npm run typecheck && npx vitest run && npm run build
git add -A
git commit -m "feat(server): register contact tools; docs for phase 2b"
```

集成测试由控制者决定何时运行，实现者不要自己跑。

---

## 完成标准

1. `npm run typecheck` 与 `npm run build` 干净，`npx vitest run` 全绿。
2. `tools/list` 返回 **25** 个工具（3 会话 + 7 邮件 + 5 日历 + 5 提醒 + 5 通讯录）。
3. 真实账号上：能搜到联系人、创建、修改、删除，且作用域限定在带测试前缀的联系人内。
4. 更新一个带 `PHOTO` 与 `X-ABRELATEDNAMES` 的联系人后，这些属性仍在。
5. 任何响应中都不出现 base64 头像内容。
6. 关闭 `ALLOW_CONTACTS_WRITE_1` 后，创建调用返回 `PERMISSION_DENIED` 且 hint 指明该变量。
7. 第二次搜索走增量同步，不重复全量拉取。
8. 自定义标签（`X-ABLabel`）在真实账号上往返后仍然存在。
9. 新增依赖数为 **0**，`npm audit` 仍为 0 漏洞。

## 阶段三预告（不在本计划内）

远程 HTTP + OAuth 2.1。开工前需要先处理两件已记录的遗留：`ICAL.TimezoneService` 是进程级全局注册表（并发会话下一个租户的时区定义会影响另一个）；日历的 1000 条静默上限应比照本阶段的 `truncated` 处理。
