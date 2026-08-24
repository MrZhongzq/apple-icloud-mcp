# 阶段 2a 实现计划：提醒事项（Reminders）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 iCloud 提醒事项作为 5 个 MCP 工具接入，复用既有的 CalDAV provider 与 iCal 解析层，只新增 VTODO 的字段映射与集合筛选。

**Architecture:** 与日历模块同构 —— `modules/reminders/{types,service,tools}.ts`，服务层持权限闸门与乐观锁，工具层只做 schema 与转发。**不新增 provider**：`CalDavProvider` 已是通用的，VTODO 集合与 VEVENT 集合走同一套 `listCalendars`/`fetchObjects`/`create`/`update`/`remove`。解析层在 `parsers/ical.ts` 内新增 VTODO 分支，与 VEVENT 共用 `parseRoot`/`registerTimezones`/`toIcalTime`/`applyPatchToVevent` 一族私有函数。

**Tech Stack:** 与阶段一相同。无新增依赖。

**Spec:** `docs/superpowers/specs/2026-08-22-apple-icloud-mcp-refactor-design.md`（§5.4 提醒事项、§9 阶段 2a）

## Global Constraints

阶段一确立、本阶段继续适用的硬约束（`CLAUDE.md` 有完整说明）：

- TypeScript **ESM**：所有相对导入必须带 `.js` 后缀。`strict` 与 `noUncheckedIndexedAccess` 已开启。
- **stdout 属于 MCP 协议**，一切日志走 stderr；业务代码中不得出现 `console.log`。
- **权限闸门只在 service 层**：provider 不查能力位，tools 层也不查。写权限缺省关闭（`ALLOW_REMINDERS_WRITE_n` 必须显式为 `true`）。
- **etag 不进工具接口**：`reminder_id` 是 `base64url(collectionUrl|resourceUrl)`，写操作前由 `loadForWrite` 实时读取 etag；`expected_etag` 是可选的乐观锁输入。
- **更新一律原地打补丁，不得按模型重建**。阶段一的教训：重建会静默删掉模型未覆盖的属性。VTODO 同样携带我们不建模的内容（`X-APPLE-SORT-ORDER`、`VALARM`、`CATEGORIES`、`RELATED-TO` 等），必须原样保留。
- 时间在工具边界一律是 **ISO 8601 带时区偏移的字符串**；内部用 `Date`。
- 每个任务结束时 `npx tsc --noEmit`、`npm run typecheck`、`npx vitest run` 必须全绿才提交。基线：248 测试 / 20 文件。

## 已知的 iCloud 实际行为

探测该账号（2026-08-24）得到的事实，计划据此制定：

- 账号下存在一个名为 `Reminders ⚠️` 的集合，与日历同处 `caldav.icloud.com`，由 `fetchCalendars()` 一并返回。
- 因此**提醒集合的发现不需要新的 provider 方法** —— 用现有 `listCalendars()`，按 `components` 含 `VTODO` 筛选即可。
- 日历服务当前的筛选是 `components.length === 0 || components.includes('VEVENT')`。**注意这个 `length === 0` 的宽松分支**：一个未声明 `components` 的集合会同时被日历和提醒认领。任务 1 需要处理这个歧义。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/parsers/ical.ts`（修改） | 新增 `parseTodoObject` / `buildTodoObject` / `applyTodoPatch` / `readTodoMeta`，与 VEVENT 侧共用私有工具函数 |
| `src/modules/reminders/types.ts` | `Reminder`、`ReminderInput`、`ReminderListSummary`、查询参数 |
| `src/modules/reminders/service.ts` | 权限闸门、集合筛选、乐观锁、原地补丁 |
| `src/modules/reminders/tools.ts` | 5 个工具的 zod schema 与注册 |
| `src/server/createServer.ts`（修改） | 按 `remindersRead`/`remindersWrite` 注册提醒工具 |
| `tests/fixtures/calendar/todo-*.ics` | VTODO 夹具 |
| `tests/unit/parsers/ical-todo.test.ts` | 解析层单测 |
| `tests/unit/modules/reminders-service.test.ts` | 服务层单测（假 provider） |
| `tests/unit/modules/reminders-tools.test.ts` | 工具层单测 |
| `tests/integration/live.test.ts`（修改） | 真实账号的提醒读写，写操作限定在专用列表 |

---

### Task 1: VTODO 集合的发现与归属歧义

先解决筛选，因为服务层和解析层都依赖它。

**Files:**
- Modify: `src/modules/calendar/service.ts`（收紧日历侧筛选）
- Create: `src/modules/reminders/types.ts`
- Test: `tests/unit/modules/calendar-service.test.ts`（追加）

**Interfaces:**
- Consumes: `CalendarInfo`（`components: string[]`）
- Produces（`src/modules/reminders/types.ts`）:
  - `interface ReminderListSummary { list_id: string; name: string; color?: string; writable: boolean }`

- [ ] **Step 1: 写失败测试 —— 归属歧义**

当前日历筛选 `c.components.length === 0 || c.components.includes('VEVENT')` 会把一个只支持 VTODO 的集合也算进日历（若它未声明 components）。追加到 `tests/unit/modules/calendar-service.test.ts`：

```ts
  it('excludes a VTODO-only collection from the calendar list', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: HOME, name: '个人', readOnly: false, components: ['VEVENT'] },
        { url: `${HOME}reminders/`, name: '提醒', readOnly: false, components: ['VTODO'] },
      ]),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });
    const calendars = await service.listCalendars();
    expect(calendars.map((c) => c.name)).toEqual(['个人']);
  });

  it('still includes a collection that declares no components', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: HOME, name: '未声明', readOnly: false, components: [] },
      ]),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });
    expect(await service.listCalendars()).toHaveLength(1);
  });
```

第一条应当已经通过（`['VTODO']` 不含 `VEVENT`）；第二条固化"未声明即认领"的现有行为。运行确认，并在报告中说明哪条是新覆盖、哪条是既有行为。

- [ ] **Step 2: 实现 `types.ts`**

```ts
/** 提醒列表的对外摘要。list_id 是不透明字符串，由 core/ids.ts 的 encodeUrl 生成。 */
export interface ReminderListSummary {
  list_id: string;
  name: string;
  color?: string;
  writable: boolean;
}
```

- [ ] **Step 3: 运行测试并提交**

Run: `npx vitest run tests/unit/modules/calendar-service.test.ts && npx tsc --noEmit`

```bash
git add src/modules/reminders/types.ts tests/unit/modules/calendar-service.test.ts
git commit -m "test(calendar): pin VTODO-collection exclusion before adding reminders"
```

---

### Task 2: VTODO 解析

**Files:**
- Modify: `src/parsers/ical.ts`
- Create: `tests/fixtures/calendar/todo-basic.ics`
- Create: `tests/fixtures/calendar/todo-completed.ics`
- Create: `tests/fixtures/calendar/todo-with-extras.ics`
- Test: `tests/unit/parsers/ical-todo.test.ts`

**Interfaces:**
- Consumes: `encodeRef`/`ResourceRef`（`core/ids.ts`）、`AppError`、以及 `ical.ts` 内既有的私有函数 `parseRoot`、`registerTimezones`、`toIsoString`、`toIcalTime`
- Produces:
  - `interface Reminder { reminder_id: string; list_id: string; uid: string; title: string; notes?: string; due?: string; completed: boolean; completed_at?: string; priority?: number; percent_complete?: number; created?: string }`
  - `function parseTodoObject(icsText: string, ref: ResourceRef): Reminder[]`

`priority` 用 iCal 原值 0–9（0 = 未设置，1 最高，9 最低），不做"高/中/低"的翻译 —— Apple 客户端用 1/5/9 表示高/中/低，翻译会丢信息。工具层的描述里说明这一点。

- [ ] **Step 1: 创建三个夹具**

`tests/fixtures/calendar/todo-basic.ics` —— 未完成、带截止日期与优先级：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTODO
UID:todo-001
DTSTAMP:20260810T000000Z
CREATED:20260809T120000Z
SUMMARY:买咖啡豆
DESCRIPTION:曼特宁，中深烘
DUE:20260815T090000Z
PRIORITY:1
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR
```

`tests/fixtures/calendar/todo-completed.ics` —— 已完成：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTODO
UID:todo-002
DTSTAMP:20260812T000000Z
SUMMARY:交房租
STATUS:COMPLETED
COMPLETED:20260811T133000Z
PERCENT-COMPLETE:100
END:VTODO
END:VCALENDAR
```

`tests/fixtures/calendar/todo-with-extras.ics` —— 携带我们不建模的属性，用于原地补丁的保留验证：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTODO
UID:todo-003
DTSTAMP:20260810T000000Z
SUMMARY:准备季度汇报
DUE;VALUE=DATE:20260901
PRIORITY:5
STATUS:NEEDS-ACTION
CATEGORIES:工作,重要
RELATED-TO:todo-001
X-APPLE-SORT-ORDER:12
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT60M
DESCRIPTION:提醒
END:VALARM
END:VTODO
END:VCALENDAR
```

- [ ] **Step 2: 写失败测试 `tests/unit/parsers/ical-todo.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTodoObject } from '../../../src/parsers/ical.js';
import { encodeRef } from '../../../src/core/ids.js';

const ref = {
  collectionUrl: 'https://caldav.icloud.com/1/calendars/reminders/',
  resourceUrl: 'https://caldav.icloud.com/1/calendars/reminders/x.ics',
};

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/calendar', name), 'utf8');

describe('parseTodoObject', () => {
  it('reads title, notes, due and priority', () => {
    const [todo] = parseTodoObject(fixture('todo-basic.ics'), ref);
    expect(todo!.title).toBe('买咖啡豆');
    expect(todo!.notes).toBe('曼特宁，中深烘');
    expect(todo!.due).toBe('2026-08-15T09:00:00.000Z');
    expect(todo!.priority).toBe(1);
    expect(todo!.completed).toBe(false);
  });

  it('derives completed from STATUS and reports the completion instant', () => {
    const [todo] = parseTodoObject(fixture('todo-completed.ics'), ref);
    expect(todo!.completed).toBe(true);
    expect(todo!.completed_at).toBe('2026-08-11T13:30:00.000Z');
    expect(todo!.percent_complete).toBe(100);
  });

  it('gives the reminder an opaque id derived from its ref', () => {
    const [todo] = parseTodoObject(fixture('todo-basic.ics'), ref);
    expect(todo!.reminder_id).toBe(encodeRef(ref));
    expect(todo!.uid).toBe('todo-001');
  });

  it('handles a DATE-valued due without shifting it by the host timezone', () => {
    const [todo] = parseTodoObject(fixture('todo-with-extras.ics'), ref);
    expect(todo!.due!.slice(0, 10)).toBe('2026-09-01');
  });

  it('returns an empty array when the object holds no VTODO', () => {
    expect(parseTodoObject(fixture('all-day.ics'), ref)).toEqual([]);
  });
});
```

最后一条复用阶段一的日历夹具，验证"喂给它一个 VEVENT 对象不会炸也不会误判"。

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run tests/unit/parsers/ical-todo.test.ts`
Expected: FAIL，`parseTodoObject is not a function`

- [ ] **Step 4: 在 `src/parsers/ical.ts` 追加实现**

放在文件末尾，紧邻 VEVENT 的同类函数：

```ts
export interface Reminder {
  reminder_id: string;
  list_id: string;
  uid: string;
  title: string;
  notes?: string;
  due?: string;
  completed: boolean;
  completed_at?: string;
  /** iCal 原值 0-9：0 未设置，1 最高，9 最低。Apple 客户端用 1/5/9 表示高/中/低。 */
  priority?: number;
  percent_complete?: number;
  created?: string;
}

export function parseTodoObject(icsText: string, ref: ResourceRef): Reminder[] {
  const root = parseRoot(icsText);
  registerTimezones(root);

  return root.getAllSubcomponents('vtodo').map((vtodo) => {
    const status = String(vtodo.getFirstPropertyValue('status') ?? '').toUpperCase();
    const completedAt = vtodo.getFirstPropertyValue('completed');
    const percent = vtodo.getFirstPropertyValue('percent-complete');

    const reminder: Reminder = {
      reminder_id: encodeRef(ref),
      list_id: encodeUrl(ref.collectionUrl),
      uid: String(vtodo.getFirstPropertyValue('uid') ?? ''),
      title: String(vtodo.getFirstPropertyValue('summary') ?? ''),
      completed: status === 'COMPLETED' || Number(percent ?? 0) === 100,
    };

    const notes = vtodo.getFirstPropertyValue('description');
    if (typeof notes === 'string' && notes) reminder.notes = notes;

    const due = vtodo.getFirstPropertyValue('due');
    if (due && typeof due !== 'string') {
      reminder.due = toIsoString(due as ICAL.Time, timezoneOfProperty(vtodo, 'due'));
    }

    if (completedAt && typeof completedAt !== 'string') {
      reminder.completed_at = toIsoString(completedAt as ICAL.Time);
    }

    const priority = vtodo.getFirstPropertyValue('priority');
    if (priority !== null && priority !== undefined) reminder.priority = Number(priority);
    if (percent !== null && percent !== undefined) reminder.percent_complete = Number(percent);

    const created = vtodo.getFirstPropertyValue('created');
    if (created && typeof created !== 'string') {
      reminder.created = toIsoString(created as ICAL.Time);
    }

    return reminder;
  });
}
```

`timezoneOfProperty` 是既有 `timezoneOf` 的泛化 —— 现有实现固定读 `dtstart`。把它改成接受属性名并保留 `timezoneOf(vevent)` 作为 `timezoneOfProperty(vevent, 'dtstart')` 的薄封装，避免改动 VEVENT 侧的调用点。若你发现改动面超出这一处，停下报告。

- [ ] **Step 5: 运行确认通过并提交**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 253 passed（248 + 5）

```bash
git add src/parsers/ical.ts tests/fixtures/calendar/todo-*.ics tests/unit/parsers/ical-todo.test.ts
git commit -m "feat(parsers): read VTODO into structured reminders"
```

---
### Task 3: VTODO 的生成与原地补丁

阶段一最重要的一条教训在这里复用：**更新既有待办必须原地打补丁**，按模型重建会静默删掉 `CATEGORIES`、`RELATED-TO`、`X-APPLE-SORT-ORDER`、`VALARM` 等我们不建模的属性。

**Files:**
- Modify: `src/parsers/ical.ts`
- Test: `tests/unit/parsers/ical-todo.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的产出，以及 `ical.ts` 内既有的 `applyPatchToVevent` 一族私有辅助
- Produces:
  - `interface ReminderInput { title: string; notes?: string; due?: string; all_day_due?: boolean; priority?: number; completed?: boolean }`
  - `function buildTodoObject(input: ReminderInput, existing?: { uid: string; sequence: number }): { ics: string; uid: string }`
  - `function applyTodoPatch(icsText: string, patch: Partial<ReminderInput>): string`
  - `function readTodoMeta(icsText: string): { uid: string; sequence: number }`

完成状态的写法要成对：置为完成时写 `STATUS:COMPLETED` + `COMPLETED:<now>` + `PERCENT-COMPLETE:100`；取消完成时写 `STATUS:NEEDS-ACTION` 并**移除** `COMPLETED` 与 `PERCENT-COMPLETE`。只改其中一个会让 Apple 客户端显示矛盾状态。

- [ ] **Step 1: 写失败测试（追加到 `ical-todo.test.ts`）**

```ts
import { buildTodoObject, applyTodoPatch, readTodoMeta, parseTodoObject } from '../../../src/parsers/ical.js';

describe('buildTodoObject', () => {
  it('produces a parseable VTODO with UID and DTSTAMP', () => {
    const { ics, uid } = buildTodoObject({ title: '新待办', due: '2026-09-10T02:00:00.000Z' });
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('SUMMARY:新待办');
    expect(ics).toContain('DUE:20260910T020000Z');
    expect(ics).toContain('UID:' + uid);
    expect(ics).toContain('DTSTAMP:');
    const [parsed] = parseTodoObject(ics, ref);
    expect(parsed!.title).toBe('新待办');
    expect(parsed!.completed).toBe(false);
  });

  it('writes a DATE-valued due when all_day_due is set', () => {
    const { ics } = buildTodoObject({ title: 'x', due: '2026-09-01T00:00:00.000Z', all_day_due: true });
    expect(ics).toContain('DUE;VALUE=DATE:20260901');
  });

  it('omits DUE entirely when none is given', () => {
    const { ics } = buildTodoObject({ title: '无截止' });
    expect(ics).not.toContain('DUE');
  });
});

describe('applyTodoPatch', () => {
  it('preserves properties the model does not know about', () => {
    const updated = applyTodoPatch(fixture('todo-with-extras.ics'), { title: '改过的标题' });
    expect(updated).toContain('SUMMARY:改过的标题');
    expect(updated).toContain('CATEGORIES:工作,重要');
    expect(updated).toContain('RELATED-TO:todo-001');
    expect(updated).toContain('X-APPLE-SORT-ORDER:12');
    expect(updated).toContain('BEGIN:VALARM');
  });

  it('replaces rather than duplicates a patched property', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { title: '改名' });
    expect(updated.match(/^SUMMARY:/gm)).toHaveLength(1);
    expect(updated).not.toContain('买咖啡豆');
  });

  it('writes the completion trio together when marking done', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { completed: true });
    expect(updated).toContain('STATUS:COMPLETED');
    expect(updated).toMatch(/^COMPLETED:/m);
    expect(updated).toContain('PERCENT-COMPLETE:100');
    const [todo] = parseTodoObject(updated, ref);
    expect(todo!.completed).toBe(true);
  });

  it('clears the completion trio when un-completing', () => {
    const done = applyTodoPatch(fixture('todo-basic.ics'), { completed: true });
    const undone = applyTodoPatch(done, { completed: false });
    expect(undone).toContain('STATUS:NEEDS-ACTION');
    expect(undone).not.toMatch(/^COMPLETED:/m);
    expect(undone).not.toContain('PERCENT-COMPLETE');
    const [todo] = parseTodoObject(undone, ref);
    expect(todo!.completed).toBe(false);
  });

  it('bumps SEQUENCE', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { title: 'x' });
    expect(updated).toContain('SEQUENCE:1');
  });

  it('removes DUE when the patch sets it to null', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { due: null as never });
    expect(updated).not.toMatch(/^DUE/m);
  });
});

describe('readTodoMeta', () => {
  it('reads the uid and defaults the sequence to zero', () => {
    expect(readTodoMeta(fixture('todo-basic.ics'))).toEqual({ uid: 'todo-001', sequence: 0 });
  });
});
```

最后一条 `due: null` 是有意的：模型需要一种"取消截止日期"的表达。`ReminderInput.due` 的类型写作 `string | null`，`undefined` 表示不改、`null` 表示清除。工具层的 schema 用 `z.string().nullable().optional()` 表达。若你认为这个三态在 zod + MCP 上不可行，停下报告，不要自行改成别的语义。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/parsers/ical-todo.test.ts`

- [ ] **Step 3: 实现**

复用 VEVENT 侧的 `applyPatchToVevent` 模式，但字段映射不同。把两者共有的"先删后加"辅助（`setValue`/`bumpSequence`/`refreshDtstamp`）提取为可被两边调用的私有函数 —— **不要复制粘贴**；阶段一在这一点上专门要求过共享实现。

`ReminderInput.due` 为 `string | null | undefined` 的三态处理：`undefined` 跳过、`null` 移除属性、字符串则按 `all_day_due` 决定写 DATE 还是 DATE-TIME。

- [ ] **Step 4: 运行确认通过并提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/parsers/ical.ts tests/unit/parsers/ical-todo.test.ts
git commit -m "feat(parsers): build and patch VTODO in place"
```

---

### Task 4: 提醒服务层

**Files:**
- Create: `src/modules/reminders/service.ts`
- Modify: `src/modules/reminders/types.ts`
- Test: `tests/unit/modules/reminders-service.test.ts`

**Interfaces:**
- Consumes: `CalDavProvider`、Task 2/3 的 `parseTodoObject`/`buildTodoObject`/`applyTodoPatch`/`readTodoMeta`、`encodeUrl`/`decodeUrl`/`encodeRef`/`decodeRef`、`AccountConfig`、`AppError`
- Produces（追加到 `types.ts`）:
  - `interface PartialFailure { list_id: string; name: string; reason: string }`
  - `interface ListRemindersParams { list_ids?: string[]; completed?: boolean; due_before?: string; due_after?: string; limit?: number }`
  - `interface ListRemindersResult { reminders: Reminder[]; partial_failures?: PartialFailure[] }`
- Produces（`service.ts`）:
  - `interface ReminderService { listLists(): Promise<ReminderListSummary[]>; list(params: ListRemindersParams): Promise<ListRemindersResult>; create(input: ReminderInput, listId?: string): Promise<Reminder>; update(reminderId: string, patch: Partial<ReminderInput>, options?: { expected_etag?: string }): Promise<Reminder>; remove(reminderId: string, options?: { expected_etag?: string }): Promise<{ deleted: true }> }`
  - `function createReminderService(deps: { account: AccountConfig; caldav: CalDavProvider }): ReminderService`

三条必须照搬日历服务、不是可选项的做法：

1. **权限闸门先于任何 I/O**，hint 给真实变量名 `ALLOW_REMINDERS_WRITE_${suffix}`。
2. **两层错误隔离**：外层按列表 `Promise.allSettled`，内层按对象 `try/catch`。阶段一终审发现只做外层，一个坏对象仍会吞掉整个集合。
3. **`loadForWrite`**：`decodeRef` 先于网络 → `fetchOne` 取当前 etag → 比对 `expected_etag`（若给）→ 用**新读到的** etag 写回。

VTODO 集合筛选用 `components.includes('VTODO')` 严格匹配，**不要**沿用日历侧的 `length === 0` 宽松分支。

- [ ] **Step 1: 写失败测试 `tests/unit/modules/reminders-service.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReminderService } from '../../../src/modules/reminders/service.js';
import { encodeRef, encodeUrl } from '../../../src/core/ids.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { CalDavProvider } from '../../../src/providers/icloud/caldav.js';

const LIST = 'https://caldav.icloud.com/1/calendars/reminders/';
const OTHER = 'https://caldav.icloud.com/1/calendars/work-reminders/';
const CAL = 'https://caldav.icloud.com/1/calendars/home/';
const TODO_URL = `${LIST}todo-001.ics`;
const reminderId = encodeRef({ collectionUrl: LIST, resourceUrl: TODO_URL });

const fx = (n: string) => readFileSync(join(process.cwd(), 'tests/fixtures/calendar', n), 'utf8');
const basic = fx('todo-basic.ics');
const completed = fx('todo-completed.ics');
const extras = fx('todo-with-extras.ics');

function makeAccount(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
    email: 'me@icloud.com',
    sender: 'me@icloud.com',
    label: 'me@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    capabilities: {
      mailRead: true, mailWrite: true,
      calendarRead: true, calendarWrite: true,
      remindersRead: true, remindersWrite: true,
      contactsRead: true, contactsWrite: true,
      ...overrides,
    },
  };
}

function makeCalDav(overrides: Partial<CalDavProvider> = {}): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi.fn().mockResolvedValue([
      { url: LIST, name: '提醒', color: '#00FF00', readOnly: false, components: ['VTODO'] },
      { url: CAL, name: '个人', readOnly: false, components: ['VEVENT'] },
    ]),
    fetchObjects: vi.fn().mockResolvedValue([
      { collectionUrl: LIST, url: TODO_URL, etag: 'etag-1', data: basic },
    ]),
    fetchOne: vi.fn().mockResolvedValue({
      collectionUrl: LIST, url: TODO_URL, etag: 'etag-1', data: basic,
    }),
    create: vi.fn().mockImplementation(async (url: string, filename: string, ics: string) => ({
      collectionUrl: url, url: `${url}${filename}`, etag: 'etag-new', data: ics,
    })),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ReminderService permissions', () => {
  it('refuses to list when reminders read is disabled', async () => {
    const service = createReminderService({ account: makeAccount({ remindersRead: false }), caldav: makeCalDav() });
    await expect(service.list({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to create when reminders write is disabled', async () => {
    const service = createReminderService({ account: makeAccount({ remindersWrite: false }), caldav: makeCalDav() });
    await expect(service.create({ title: 'x' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('names the environment variable in the hint', async () => {
    const service = createReminderService({ account: makeAccount({ remindersWrite: false }), caldav: makeCalDav() });
    try {
      await service.remove(reminderId);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain('ALLOW_REMINDERS_WRITE');
    }
  });

  it('checks the gate before touching the provider', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount({ remindersRead: false }), caldav });
    await expect(service.listLists()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(caldav.listCalendars).not.toHaveBeenCalled();
  });
});

describe('ReminderService.listLists', () => {
  it('returns only VTODO collections with opaque ids', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    const lists = await service.listLists();
    expect(lists).toEqual([
      { list_id: encodeUrl(LIST), name: '提醒', color: '#00FF00', writable: true },
    ]);
  });

  it('does not claim a collection that declares no components', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([{ url: CAL, name: '未声明', readOnly: false, components: [] }]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    expect(await service.listLists()).toEqual([]);
  });
});

describe('ReminderService.list', () => {
  it('returns parsed reminders from every VTODO list', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    const result = await service.list({});
    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0]!.title).toBe('买咖啡豆');
    expect(result.partial_failures).toBeUndefined();
  });

  it('queries only VTODO collections, never the calendar', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.list({});
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(1);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(LIST, undefined);
  });

  it('filters by completion state', async () => {
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic },
        { collectionUrl: LIST, url: `${LIST}todo-002.ics`, etag: 'e2', data: completed },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    expect((await service.list({ completed: true })).reminders.map((r) => r.title)).toEqual(['交房租']);
    expect((await service.list({ completed: false })).reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    expect((await service.list({})).reminders).toHaveLength(2);
  });

  it('filters by due range and drops reminders with no due date', async () => {
    const noDue = basic.replace(/^DUE:.*$/m, '');
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic },
        { collectionUrl: LIST, url: `${LIST}nodue.ics`, etag: 'e2', data: noDue },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const inRange = await service.list({ due_after: '2026-08-01T00:00:00Z', due_before: '2026-09-01T00:00:00Z' });
    expect(inRange.reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    const outOfRange = await service.list({ due_after: '2026-09-01T00:00:00Z' });
    expect(outOfRange.reminders).toEqual([]);
  });

  it('restricts to the requested lists', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '提醒', readOnly: false, components: ['VTODO'] },
        { url: OTHER, name: '工作', readOnly: false, components: ['VTODO'] },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.list({ list_ids: [encodeUrl(OTHER)] });
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(1);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(OTHER, undefined);
  });

  it('raises NOT_FOUND naming a list_id that matches nothing', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(service.list({ list_ids: [encodeUrl('https://caldav.icloud.com/1/calendars/gone/')] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a limit outside the allowed range', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(service.list({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.list({ limit: 5000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('isolates a failing list instead of failing the whole query', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '提醒', readOnly: false, components: ['VTODO'] },
        { url: OTHER, name: '工作', readOnly: false, components: ['VTODO'] },
      ]),
      fetchObjects: vi.fn().mockImplementation(async (url: string) => {
        if (url === OTHER) throw new Error('boom');
        return [{ collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic }];
      }),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const result = await service.list({});
    expect(result.reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    expect(result.partial_failures).toHaveLength(1);
    expect(result.partial_failures![0]!.name).toBe('工作');
  });

  it('isolates a single unparseable object within a list', async () => {
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic },
        { collectionUrl: LIST, url: `${LIST}broken.ics`, etag: 'e2', data: 'NOT ICALENDAR AT ALL' },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const result = await service.list({});
    expect(result.reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    expect(result.partial_failures).toHaveLength(1);
  });
});

describe('ReminderService.create', () => {
  it('writes to the first writable VTODO list by default', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    const created = await service.create({ title: '新待办' });
    expect(caldav.create).toHaveBeenCalledWith(LIST, expect.stringMatching(/\.ics$/), expect.stringContaining('SUMMARY:新待办'));
    expect(created.title).toBe('新待办');
    expect(created.completed).toBe(false);
  });

  it('honours an explicit list_id', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '提醒', readOnly: false, components: ['VTODO'] },
        { url: OTHER, name: '工作', readOnly: false, components: ['VTODO'] },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.create({ title: 'x' }, encodeUrl(OTHER));
    expect(caldav.create).toHaveBeenCalledWith(OTHER, expect.anything(), expect.anything());
  });

  it('raises NOT_FOUND when no writable list exists', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '只读', readOnly: true, components: ['VTODO'] },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.create({ title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ReminderService.update', () => {
  it('patches in place and preserves unmodelled properties', async () => {
    const caldav = makeCalDav({
      fetchOne: vi.fn().mockResolvedValue({ collectionUrl: LIST, url: TODO_URL, etag: 'etag-1', data: extras }),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.update(reminderId, { title: '改过的标题' });

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('SUMMARY:改过的标题');
    expect(written).toContain('CATEGORIES:工作,重要');
    expect(written).toContain('RELATED-TO:todo-001');
    expect(written).toContain('X-APPLE-SORT-ORDER:12');
    expect(written).toContain('BEGIN:VALARM');
  });

  it('writes with the freshly read etag, not the supplied one', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.update(reminderId, { title: 'x' }, { expected_etag: 'etag-1' });
    expect((caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].etag).toBe('etag-1');
  });

  it('raises CONFLICT when expected_etag does not match, without writing', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.update(reminderId, { title: 'x' }, { expected_etag: 'stale' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(caldav.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed reminder_id before any network call', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.update('garbage', { title: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.fetchOne).not.toHaveBeenCalled();
  });

  it('round-trips a completion toggle', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    const updated = await service.update(reminderId, { completed: true });
    expect(updated.completed).toBe(true);
    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('STATUS:COMPLETED');
    expect(written).toContain('PERCENT-COMPLETE:100');
  });
});

describe('ReminderService.remove', () => {
  it('deletes with the current etag', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    expect(await service.remove(reminderId)).toEqual({ deleted: true });
    expect(caldav.remove).toHaveBeenCalledWith({ url: TODO_URL, etag: 'etag-1' });
  });

  it('rejects a malformed reminder_id before any network call', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.remove('garbage')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.fetchOne).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/modules/reminders-service.test.ts`
Expected: FAIL，无法解析 `src/modules/reminders/service.js`

- [ ] **Step 3: 实现 `service.ts`**

以 `src/modules/calendar/service.ts` 为范本，逐段对照改写：权限闸门、`todoLists()` 筛选、`list()` 的两层隔离与过滤、`create()` 的目标选择、`loadForWrite()`、`update()` 走 `applyTodoPatch`、`remove()`。`fetchObjects` 对 VTODO 不传时间范围（第二参数为 `undefined`）—— CalDAV 的 `time-range` 过滤对 VTODO 语义复杂，截止日期的过滤在服务层用解析结果做。

- [ ] **Step 4: 运行确认通过并提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/modules/reminders tests/unit/modules/reminders-service.test.ts
git commit -m "feat(reminders): add reminder service with permission gates and in-place patching"
```

---

### Task 5: 提醒工具层

**Files:**
- Create: `src/modules/reminders/tools.ts`
- Test: `tests/unit/modules/reminders-tools.test.ts`

**Interfaces:**
- Consumes: `ToolRegistrar`/`ToolDeps`/`ToolConfig`/`ToolResult`（`src/server/types.js`）、`wrapTool`（`src/server/wrap.js`）、`Session`、`ReminderService`
- Produces:
  - `interface ReminderToolDeps extends ToolDeps { reminderFor: (session: Session) => ReminderService }`
  - `function registerReminderTools(server: ToolRegistrar, deps: ReminderToolDeps): void`

五个工具与注解：

| 工具 | 注解 |
|---|---|
| `reminders_lists` | `readOnlyHint: true` |
| `reminders_list` | `readOnlyHint: true` |
| `reminders_create` | `readOnlyHint: false, destructiveHint: false` |
| `reminders_update` | `readOnlyHint: false, destructiveHint: false, idempotentHint: true` |
| `reminders_delete` | `readOnlyHint: false, destructiveHint: true` |

工具描述里必须写明的两点（模型只能读到描述）：

- `priority` 是 iCal 的 0–9，**数值越小优先级越高**：Apple 客户端用 1 表示高、5 中、9 低，0 表示未设置。这与直觉相反，不写明必然被用错。
- `due` 传 `null` 表示清除截止日期，省略表示不改动。

- [ ] **Step 1: 写失败测试 `tests/unit/modules/reminders-tools.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerReminderTools } from '../../../src/modules/reminders/tools.js';
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
  return { sessions: fakeSessions, logger: silentLogger, reminderFor: () => service as never };
}

describe('registerReminderTools', () => {
  it('registers every reminder tool', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'reminders_create',
      'reminders_delete',
      'reminders_list',
      'reminders_lists',
      'reminders_update',
    ]);
  });

  it('carries the specified annotations', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    expect(tools.get('reminders_lists')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('reminders_list')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('reminders_create')!.config.annotations?.destructiveHint).toBe(false);
    expect(tools.get('reminders_update')!.config.annotations?.idempotentHint).toBe(true);
    expect(tools.get('reminders_delete')!.config.annotations?.destructiveHint).toBe(true);
  });

  it('requires session_id in every schema', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    for (const [name, tool] of tools) {
      const shape = tool.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.session_id, `${name} 缺少 session_id`).toBeDefined();
    }
  });

  it('never exposes an etag as a required input', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    for (const name of ['reminders_update', 'reminders_delete']) {
      const shape = tools.get(name)!.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.expected_etag!.isOptional()).toBe(true);
    }
  });

  it('documents that a lower priority number means higher priority', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    const shape = tools.get('reminders_create')!.config.inputSchema as Record<string, z.ZodTypeAny>;
    const described = shape.priority!.description ?? '';
    expect(described).toMatch(/1/);
    expect(described).toMatch(/9/);
  });

  it('forwards the list query verbatim', async () => {
    const { server, tools } = collect();
    const list = vi.fn().mockResolvedValue({ reminders: [] });
    registerReminderTools(server, depsWith({ list }));

    await tools.get('reminders_list')!.handler({
      session_id: 's1',
      list_ids: ['abc'],
      completed: false,
      due_before: '2026-09-01T00:00:00Z',
      limit: 50,
    });

    expect(list).toHaveBeenCalledWith({
      list_ids: ['abc'],
      completed: false,
      due_before: '2026-09-01T00:00:00Z',
      due_after: undefined,
      limit: 50,
    });
  });

  it('passes the session through when listing lists', async () => {
    const { server, tools } = collect();
    const listLists = vi.fn().mockResolvedValue([{ list_id: 'l1', name: '提醒', writable: true }]);
    registerReminderTools(server, depsWith({ listLists }));

    const result = await tools.get('reminders_lists')!.handler({ session_id: 's1' });
    expect(listLists).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0]!.text)[0].name).toBe('提醒');
  });

  it('forwards the reminder object and list_id on create', async () => {
    const { server, tools } = collect();
    const create = vi.fn().mockResolvedValue({ reminder_id: 'r1', title: '新待办' });
    registerReminderTools(server, depsWith({ create }));

    await tools.get('reminders_create')!.handler({
      session_id: 's1',
      list_id: 'l1',
      reminder: { title: '新待办', due: '2026-09-10T02:00:00Z', priority: 1 },
    });

    expect(create).toHaveBeenCalledWith(
      { title: '新待办', due: '2026-09-10T02:00:00Z', priority: 1 },
      'l1',
    );
  });

  it('forwards patch and expected_etag on update', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ reminder_id: 'r1' });
    registerReminderTools(server, depsWith({ update }));

    await tools.get('reminders_update')!.handler({
      session_id: 's1',
      reminder_id: 'r1',
      patch: { completed: true },
      expected_etag: 'e1',
    });

    expect(update).toHaveBeenCalledWith('r1', { completed: true }, { expected_etag: 'e1' });
  });

  it('accepts a null due as an explicit clear', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ reminder_id: 'r1' });
    registerReminderTools(server, depsWith({ update }));

    const result = await tools.get('reminders_update')!.handler({
      session_id: 's1',
      reminder_id: 'r1',
      patch: { due: null },
    });

    expect(result.isError).toBeUndefined();
    expect(update).toHaveBeenCalledWith('r1', { due: null }, { expected_etag: undefined });
  });

  it('forwards the id and expected_etag on delete', async () => {
    const { server, tools } = collect();
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    registerReminderTools(server, depsWith({ remove }));

    await tools.get('reminders_delete')!.handler({
      session_id: 's1',
      reminder_id: 'r1',
      expected_etag: 'e1',
    });

    expect(remove).toHaveBeenCalledWith('r1', { expected_etag: 'e1' });
  });

  it('converts an AppError into a structured payload', async () => {
    const { server, tools } = collect();
    const list = vi.fn().mockRejectedValue(
      new AppError('PERMISSION_DENIED', '提醒读取权限未开启', { hint: '设置 ALLOW_REMINDERS_READ_1=true' }),
    );
    registerReminderTools(server, depsWith({ list }));

    const result = await tools.get('reminders_list')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_REMINDERS_READ_1');
  });
});
```

**鉴别性实验（必做）**：把 `reminders_delete` 转发的 `reminder_id` 与 `expected_etag` 对调，确认对应用例失败，再改回。粘贴两次输出。阶段一有过注册与注解全对、handler 从未被调用、参数写反也发现不了的教训；删除操作尤其不可逆。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/modules/reminders-tools.test.ts`

- [ ] **Step 3: 实现 `tools.ts`**

以 `src/modules/calendar/tools.ts` 为范本。`reminderShape` 与 `patchSchema` 的关系照搬日历侧（`z.object(reminderShape)` 与 `.partial()`），但 `due` 需要三态，因此 `reminderShape.due` 写作 `z.string().nullable().optional()`，并在 `.describe()` 里说明 null 的含义。`priority` 写作 `z.number().int().min(0).max(9).optional()`，`.describe()` 说明数值方向。

每个 handler 必须在 `wrapTool` 内取 service（`sessions.get` 不得在闭包外调用），与另外两个模块一致。

- [ ] **Step 4: 运行确认通过并提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/modules/reminders/tools.ts tests/unit/modules/reminders-tools.test.ts
git commit -m "feat(reminders): expose reminder tools with structured schemas"
```

---

### Task 6: 装配与文档

**Files:**
- Modify: `src/server/createServer.ts`
- Modify: `tests/unit/server/register.test.ts`
- Modify: `README.md`、`SKILL.md`、`CLAUDE.md`
- Modify: `tests/integration/live.test.ts`

- [ ] **Step 1: 注册门控**

`registerAllTools` 增加 `anyReminders`，判据与邮件/日历一致：**任一账号**的 `remindersRead || remindersWrite` 为真即注册。

测试必须能分辨 `.some()` 与 `.every()` —— 单账号配置下两者等价。照 Task 18 的做法：构造双账号配置，账号 1 关闭提醒、账号 2 开启，断言提醒工具仍注册；并做一次 `.every` 变异实验确认只有该用例失败。

- [ ] **Step 2: 集成测试**

在 `tests/integration/live.test.ts` 追加，默认随 `.env.test` 存在与否跳过：

```ts
  it('detects a VTODO list and round-trips a reminder', async () => {
    // 用 INTEGRATION_REMINDER_LIST_NAME（新增，默认 'MCP-Test'）定位专用列表
    // 创建 → 断言未完成 → 标记完成 → 断言 completed 与 completed_at → 删除
  });
```

写操作**必须**限定在该专用列表内。若账号中不存在同名 VTODO 列表，用清晰的错误提示要求先手动创建，与既有日历用例的做法一致。同时在 `.env.test.example` 增加 `INTEGRATION_REMINDER_LIST_NAME`。

- [ ] **Step 3: 文档**

- **README**：工具表补 5 个提醒工具（总数 15 → 20）；环境变量表补 `ALLOW_REMINDERS_READ_n` / `ALLOW_REMINDERS_WRITE_n`（读默认开、写默认关）；验证章节里"健康的服务器返回 15 个工具"改为 20，八工具的降级说明相应调整。
- **SKILL.md**：新增提醒事项一节，含五个工具的签名、`priority` 的 0–9 语义与方向、`due` 的三态（省略/字符串/null）、以及 `list_id`/`reminder_id` 同为不透明字符串。
- **CLAUDE.md**：在"非显而易见的约束"中加入 VTODO 与 VEVENT 共用解析层但集合筛选判据不同（`VTODO` 严格匹配、`VEVENT` 容忍未声明）这一条，说明为什么两侧不一致是有意的。

- [ ] **Step 4: 全量验证并提交**

```bash
npx tsc --noEmit && npm run typecheck && npx vitest run && npm run build
npx vitest run --config vitest.integration.config.ts   # 有 .env.test 时应新增 1 条通过
git commit -m "feat(server): register reminder tools; docs for phase 2a"
```

---

## 完成标准

1. `npx vitest run` 全绿，`npm run typecheck` 与 `npm run build` 干净。
2. `tools/list` 返回 **20** 个工具（3 会话 + 7 邮件 + 5 日历 + 5 提醒）。
3. 真实账号上：能列出提醒列表、创建一条待办、切换完成状态、删除，且专用列表之外的数据未被触碰。
4. 关闭 `ALLOW_REMINDERS_WRITE_1` 后，创建调用返回 `PERMISSION_DENIED` 且 hint 指明该变量。
5. 更新一条带 `CATEGORIES`/`VALARM` 的待办后，这些属性仍在。
6. 一个提醒列表不可读时，其余列表的结果照常返回，失败者出现在 `partial_failures`。

## 阶段 2b 预告（不在本计划内）

通讯录：`providers/icloud/carddav.ts` + `parsers/vcard.ts` + `modules/contacts`。已确定的设计约束见 spec §5.5 的实测结论 —— iCloud 不支持 `addressbook-query`，搜索走 `sync-collection` 增量同步 + 会话缓存；vCard 为 3.0；`PHOTO` 不入响应。单独出计划。
