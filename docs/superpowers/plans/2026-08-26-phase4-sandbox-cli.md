# 阶段四：沙盒 CLI 入口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Claude Routine 能在沙盒 shell 里驱动这 25 个工具，凭据来自沙盒自己的 `.env`，一次登录可供多条命令复用。

**Architecture:** 新增第三个入口 `bin/cli.ts`，与 stdio、HTTP 并列。它把 `ToolRegistrar` 再实现一遍（收集到 Map 而不是注册到 MCP server），因此 25 个工具零逐条代码全部可用；每条命令的 flag 从工具自己的 zod schema 推导，不另写一套接口。会话由一个本地守护进程持有，短命令通过本地 socket 连上去复用同一条已认证的连接。

**Tech Stack:** TypeScript ESM（NodeNext）、Node 内置 `net`/`fs`（无新依赖）、既有的 `dotenv` 17.4.2、`zod` 4.4.3、`vitest` 4.1.11。

**Spec:** 无独立 spec 文档。本阶段的设计来自与用户的直接讨论，关键决定与实测依据记录在下方「计划前裁定」。前三阶段的 spec（`docs/superpowers/specs/2026-08-22-apple-icloud-mcp-refactor-design.md`）仍是业务层的权威，本阶段不改动它描述的任何行为。

---

## 这个入口为什么存在

Routine 跑在 Anthropic 的服务器上，只能通过 **connector**（远程 MCP）获得工具——它拉不起本机子进程。所以要用远程 HTTP 入口，就得有域名、证书、OAuth，而且 iCloud 凭据必须常驻在那台服务器上。

但如果 Routine 在沙盒里有 shell，情况完全不同：它可以拉库、读沙盒自己的 `.env`、直接跑代码。凭据随沙盒生灭，**每个人带自己的 `.env`，互不相见**——远程部署那个"单人 MCP"的困局在这里根本不出现。

而 MCP 协议这一层在沙盒里是多余的：MCP 存在的意义是让一个**远端**的模型调用你的工具，而这里模型已经在沙盒里了。它需要的不是协议，是一个能用 shell 调的命令行。

**本阶段不动 stdio 与 HTTP 两个入口的任何行为。** 三个入口共用同一套 `modules/`、`providers/`、`parsers/`。

---

## 计划前裁定（五条，均有实测依据）

### 裁定一：CLI 是第三个 `ToolRegistrar`，不重新实现工具

`ToolRegistrar`（`src/server/types.ts`）只有一个方法。真实的 `McpServer` 满足它，单元测试里的假 server 也满足它。CLI 再实现一个——把 `registerTool` 收进 `Map` 而不是注册到协议层。

于是 `registerAllTools(collector, deps)` 一句话拿到全部 25 个工具**连同它们的 schema 与 handler**。以后加工具自动就有 CLI 命令，不会出现「MCP 有而 CLI 没有」的漂移。

### 裁定二：flag 从 zod schema 推导，不手写

22 个工具手写 flag 解析器是 22 处会和 schema 漂移的地方。改为内省每个工具的 `inputSchema`。实测（zod 4.4.3）确认可以稳定取到基础类型、可选性、可空性与 `.describe()`：

```
session_id   base=string   optional=false nullable=false  desc=会话
folder       base=string   optional=true  nullable=false
unseen       base=boolean  optional=true  nullable=false
limit        base=number   optional=true  nullable=false
note         base=string   optional=true  nullable=true
query        base=object   optional=true  nullable=false
tags         base=array    optional=true  nullable=false
```

映射规则：

| schema | flag |
|---|---|
| `string` / `number` | `--folder INBOX` / `--limit 10` |
| `boolean` | `--unseen`（出现即 true） |
| `object` / `array` | `--query '<json>'` |
| **`nullable`（三态）** | `--note <值>` 设置；**`--unset-note` 清除**；省略不改 |

三态那一行值得单独说：`nullable` 在本项目里的含义是「传 null 表示清除该字段」（见 `SKILL.md` 的接口约定）。命令行上没有自然的「传 null」写法，`--note` 不给值会和布尔 flag 混淆。`--unset-note` 显式、无歧义，且能从 schema 自动生成。

`--help` 也从同一份 schema 生成，所以帮助文本永远和实际接受的参数一致。

### 裁定三：CLI 里不出现 `session_id`

`session_id` 存在的意义是给**远端**客户端一个句柄。在 CLI 里，会话边界就是进程边界（一次性模式）或守护进程的生命周期（常驻模式），暴露它只是多一个能忘记清理的东西。

`apple_login` / `work_done` 因此**不作为命令出现**——会话由 CLI 隐式管理，`finally` 保证连接一定关闭。`apple_accounts` 保留（它本来就不需要会话）。

### 裁定四：会话复用只能靠常驻进程，不能靠 id 文件

会话持有活的 IMAP/TLS 连接。进程一退出 socket 就没了——**上一次调用打印的 id，下一次拿到手里是个死号**，连接不能序列化到文件。

所以：

- **一次性模式（默认）**：单条命令自己完成建会话 → 执行 → 销毁。简单场景不用 ceremony。
- **常驻模式**：`cli start` 起一个后台进程握住会话与连接；后续命令通过本地 socket 连上去复用。`cli stop` 销毁。

常驻模式真正省下的不只是几次登录验证，还有 **IMAP 的 TCP + TLS + AUTH 握手**——那才是跨进程时的开销大头。

### 裁定五：socket 权限就是全部的访问控制，必须显式收紧

那个 socket 后面挂着一个**已登录、握着用户 iCloud 连接的会话**。谁连上谁就能读用户的邮件。

实测（WSL Ubuntu 22.04 与远程 Ubuntu 24.04）：

```
默认权限: 755（远程机器上是 775）  →  chmod 600 后: 600
chmod 之后自己仍可连: 是
```

**Node 创建的 unix socket 默认是敞开的**，必须在 `listen` 之后立刻 `chmod 600`。

而 Windows 本地环境下 unix socket 与命名管道**都被沙箱策略挡住**（实测均为 `EACCES`），所以需要 TCP 兜底。但本机任何进程都能连一个 TCP 端口，没有文件权限可依赖——**因此 TCP 路径必须加握手令牌**，令牌存在一个 `600` 的文件里。

两条传输的安全性质由此对齐：**都归结为「能不能读到那个 600 的文件」**。

这一条的失败形态是「功能完全正常，只是别人也能用」——不会有任何症状，所以必须有测试守着，而不是靠代码注释。

---

## Global Constraints

- **ESM 相对导入必须带 `.js` 后缀**（NodeNext），即使源文件是 `.ts`。
- `strict` 与 `noUncheckedIndexedAccess` 均开启。
- **CLI 的 stdout 只放结果 JSON**；日志、错误、进度一律走 stderr。理由和 stdio 入口一样：调用方要能 `cli ... > out.json` 直接拿到干净的 JSON。**`src/` 下禁止 `console.log`**，CLI 打印结果用 `process.stdout.write`。
- **验证用 `npm run typecheck`**，不要用裸 `npx tsc --noEmit`——后者只覆盖 `src/**/*`；`npm run typecheck` 会再跑 `tsconfig.test.json`（含 `tests/**/*`）。vitest 用 esbuild 转译，**从不做类型检查**。
- `npx vitest run` 必须全绿（当前 569 个测试 / 39 个文件）。
- **不新增依赖**。`net`、`fs`、`os`、`path` 都是内置的；`dotenv` 已在依赖里。`npm audit` 保持 0。
- **不得运行集成测试**——它会连真实 iCloud 账号（且当前密码已吊销，只会失败）。
- **生成代码里避免反斜杠转义序列**——本项目已因此栽过六次。需要时用 `String.fromCharCode(92)`；CRLF 用 `(13, 10)`。
- **不改动 `src/modules/`、`src/providers/`、`src/parsers/`、`src/core/` 的任何行为。** CLI 是纯增量的第三个入口。若发现下层缺东西，**上报而不是顺手改**。
- `tests/helpers/no-secret-leak.ts` 导出 `expectNoSecretLeak(err, secrets[])`，用于任何「不得泄露」的断言。它会摊平 `message`、`stack`、`cause` 与不可枚举属性——`JSON.stringify(err)` 看不见 `Error.prototype.message`。

## 测试环境

- **unix socket 路径在 Windows 上跑不了**（实测 `EACCES`），必须在 WSL 里验证。本机已装好：`wsl -d Ubuntu-22.04`，Node v22.14.0 在 `/opt/node`，已软链到 `/usr/local/bin`。
- **被 skip 的测试和通过的测试看起来太像了。** 任何因平台而 skip 的用例，必须在 skip 时打印明确原因（例如 `跳过：unix socket 在本平台不可用，请在 WSL 中运行`），并且**每个任务结束前必须在 WSL 里跑一次完整套件**，把两条传输路径都覆盖到。
- WSL 里跑 sudo 必须 `echo <密码> | sudo -S`，直接 sudo 会静默挂起。本阶段应该用不到 sudo。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/cli/registry.ts` | 收集型 `ToolRegistrar`：把 25 个工具连同 schema 与 handler 收进 Map。无 I/O。 |
| `src/cli/flags.ts` | 纯函数：从 zod schema 推导 flag 规格；解析 argv；生成 `--help` 文本。无 I/O。 |
| `src/cli/transport.ts` | 传输选择与安全：unix socket（chmod 600）或 TCP + 令牌；socket 路径与令牌文件的位置和权限。 |
| `src/cli/daemon.ts` | 守护进程：持有会话、监听 socket、处理请求、空闲自动退出。 |
| `src/cli/client.ts` | 短命令侧：连守护进程；连不上就退回一次性模式（并清理僵死的 socket 文件）。 |
| `src/bin/cli.ts` | 入口：加载 `.env`、分派 `start`/`stop`/`batch`/工具命令、决定退出码。 |

---

## Task 1: 工具收集与 flag 推导

**Files:**
- Create: `src/cli/registry.ts`、`src/cli/flags.ts`
- Test: `tests/unit/cli/registry.test.ts`、`tests/unit/cli/flags.test.ts`

**Interfaces:**
- Consumes: `ToolRegistrar`/`ToolConfig`/`ToolResult`/`ToolExtra`（`src/server/types.js`）、`registerAllTools`（`src/server/createServer.js`）、`AppConfig`、`SessionStore`、`Logger`
- Produces:

```ts
// src/cli/registry.ts
export interface CollectedTool {
  name: string;
  config: ToolConfig;
  handler: (args: unknown, extra?: ToolExtra) => Promise<ToolResult>;
}
/** 用收集型 registrar 跑一遍 registerAllTools，拿到全部已注册工具。 */
export function collectTools(deps: {
  config: AppConfig;
  sessions: SessionStore;
  logger: Logger;
}): Map<string, CollectedTool>;

// src/cli/flags.ts
export type FlagKind = 'string' | 'number' | 'boolean' | 'json';
export interface FlagSpec {
  /** 参数名，如 `limit`。 */
  key: string;
  /** 命令行上的写法，如 `--limit`。 */
  flag: string;
  kind: FlagKind;
  required: boolean;
  /** 该参数接受 null（三态），因而额外生成 `--unset-<key>`。 */
  nullable: boolean;
  description?: string;
}
export function deriveFlags(config: ToolConfig): FlagSpec[];
export function parseFlags(specs: FlagSpec[], argv: string[]): Record<string, unknown>;
export function renderHelp(name: string, config: ToolConfig, specs: FlagSpec[]): string;
```

### 为什么是「收集」而不是「重新实现」

`ToolRegistrar`（`src/server/types.ts`）只有一个 `registerTool` 方法。真实的 `McpServer` 满足它，测试里的假 server 也满足它。CLI 只需要第三个实现：把每次注册收进 Map。

`registerAllTools(collector, { config, sessions, logger })` 一句话就能拿到 25 个工具连同 schema 与 handler。**以后谁加了工具，CLI 自动就有对应命令**——不会出现「MCP 有而 CLI 没有」。

### `session_id` 不出现在 flag 里

每个需要会话的工具的 `inputSchema` 里都有 `session_id`。它由 CLI 隐式注入（Task 2），**不能生成成 flag**——否则用户要手填一个他拿不到的值。`deriveFlags` 必须把它排除掉。

### 三态标量：`--unset-<key>`

`nullable` 在本项目的含义是「传 `null` 表示清除该字段，省略表示不改动」（见 `SKILL.md` 的接口约定）。命令行上 `--note` 不给值会和布尔 flag 混淆，所以对每个 nullable 字段额外生成 `--unset-note`，语义是「把它设成 null」。

**同时给出 `--note` 和 `--unset-note` 是矛盾输入，必须报错**，不能默默取其一。

- [ ] **Step 1: 写失败测试 `tests/unit/cli/flags.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { deriveFlags, parseFlags, renderHelp } from '../../../src/cli/flags.js';
import type { ToolConfig } from '../../../src/server/types.js';

function cfg(shape: Record<string, z.ZodTypeAny>): ToolConfig {
  return { description: '测试工具', inputSchema: shape };
}

const sample = cfg({
  session_id: z.string().describe('会话'),
  folder: z.string().optional().describe('邮件文件夹'),
  unseen: z.boolean().optional(),
  limit: z.number().int().optional(),
  note: z.string().nullable().optional(),
  query: z.object({ from: z.string().optional() }).optional(),
  tags: z.array(z.string()).optional(),
  subject: z.string(),
});

describe('deriveFlags', () => {
  it('never exposes session_id, which the CLI injects itself', () => {
    const keys = deriveFlags(sample).map((f) => f.key);
    expect(keys, 'session_id 由 CLI 隐式注入，做成 flag 等于要用户填一个他拿不到的值').not.toContain(
      'session_id',
    );
  });

  it('maps each schema type to the right flag kind', () => {
    const by = Object.fromEntries(deriveFlags(sample).map((f) => [f.key, f]));
    expect(by.folder!.kind).toBe('string');
    expect(by.unseen!.kind).toBe('boolean');
    expect(by.limit!.kind).toBe('number');
    expect(by.query!.kind, '嵌套对象只能整块传 JSON').toBe('json');
    expect(by.tags!.kind).toBe('json');
  });

  it('marks a non-optional field required', () => {
    const by = Object.fromEntries(deriveFlags(sample).map((f) => [f.key, f]));
    expect(by.subject!.required).toBe(true);
    expect(by.folder!.required).toBe(false);
  });

  it('flags a nullable field so an unset variant can be offered', () => {
    const by = Object.fromEntries(deriveFlags(sample).map((f) => [f.key, f]));
    expect(by.note!.nullable).toBe(true);
    expect(by.folder!.nullable).toBe(false);
  });

  it('carries the schema description through, whichever side of the wrapper it sits on', () => {
    // zod 4.4.3 实测：optional().describe() 的描述在最外层，
    // describe().optional() 的最外层是 undefined、描述在内层。本项目两种写法都有。
    const both = cfg({
      outer: z.string().optional().describe('外层描述'),
      inner: z.string().describe('内层描述').optional(),
    });
    const by = Object.fromEntries(deriveFlags(both).map((f) => [f.key, f]));
    expect(by.outer!.description).toBe('外层描述');
    expect(by.inner!.description, '只看最外层会让这一半的帮助文本静默变空').toBe('内层描述');
  });
});

describe('parseFlags', () => {
  const specs = deriveFlags(sample);

  it('parses each kind into the right JS type', () => {
    const got = parseFlags(specs, [
      '--subject', 'hi',
      '--folder', 'INBOX',
      '--unseen',
      '--limit', '10',
      '--query', '{"from":"a@b.c"}',
      '--tags', '["x","y"]',
    ]);
    expect(got).toEqual({
      subject: 'hi',
      folder: 'INBOX',
      unseen: true,
      limit: 10,
      query: { from: 'a@b.c' },
      tags: ['x', 'y'],
    });
  });

  it('omits what was not given, rather than filling in defaults', () => {
    const got = parseFlags(specs, ['--subject', 'hi']);
    expect(Object.keys(got)).toEqual(['subject']);
    expect('folder' in got, '没给的参数不能凭空出现，否则会覆盖服务端的默认值').toBe(false);
  });

  it('turns --unset-note into an explicit null', () => {
    const got = parseFlags(specs, ['--subject', 'hi', '--unset-note']);
    expect(got.note, 'null 表示清除该字段，与「省略」是两回事').toBeNull();
  });

  it('refuses to both set and unset the same field', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--note', 'x', '--unset-note'])).toThrow();
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--nonsense', 'x']),
      '静默忽略拼错的 flag，会让人以为参数生效了').toThrow();
  });

  it('rejects a missing required flag', () => {
    expect(() => parseFlags(specs, ['--folder', 'INBOX'])).toThrow();
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseFlags(specs, ['--subject'])).toThrow();
  });

  it('rejects a non-numeric value for a number flag', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--limit', 'abc'])).toThrow();
  });

  it('rejects malformed json rather than passing the raw string through', () => {
    expect(() => parseFlags(specs, ['--subject', 'hi', '--query', '{not json'])).toThrow();
  });

  it('accepts a value that begins with a dash when it follows a value-taking flag', () => {
    const got = parseFlags(specs, ['--subject', '-weird-subject']);
    expect(got.subject, '以短横开头的合法值不能被误判成另一个 flag').toBe('-weird-subject');
  });
});

describe('renderHelp', () => {
  it('lists every flag with its type, and marks the required ones', () => {
    const text = renderHelp('mail_search', sample, deriveFlags(sample));
    expect(text).toContain('mail_search');
    expect(text).toContain('--folder');
    expect(text).toContain('--unset-note');
    expect(text).toMatch(/--subject[^\n]*必填|必填[^\n]*--subject/);
    expect(text, '帮助里不该出现由 CLI 注入的参数').not.toContain('--session_id');
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 让 `deriveFlags` 不再排除 `session_id`，确认 `never exposes session_id` 与 `renderHelp` 那条转红；改回。
2. 让 `parseFlags` 遇到未知 flag 时静默忽略，确认 `rejects an unknown flag` 转红；改回。这一条守的是「拼错 flag 却以为生效了」——最难自查的一类使用错误。

- [ ] **Step 2: 写失败测试 `tests/unit/cli/registry.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { collectTools } from '../../../src/cli/registry.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { SessionStore } from '../../../src/core/session.js';

const logger = createLogger('error', () => {});

function appConfig(overrides: Partial<AppConfig['accounts'][0]['capabilities']> = {}): AppConfig {
  return {
    accounts: [
      {
        id: 'account_1',
        label: 'a@icloud.com',
        email: 'a@icloud.com',
        sender: 'a@icloud.com',
        appPassword: 'x',
        capabilities: {
          mailRead: true, mailWrite: false,
          calendarRead: true, calendarWrite: false,
          remindersRead: true, remindersWrite: false,
          contactsRead: true, contactsWrite: false,
          ...overrides,
        },
      },
    ],
    sessionTtlMs: 60_000,
    imapIdleTimeoutMs: 60_000,
    logLevel: 'error',
    deprecations: [],
    notices: [],
  } as AppConfig;
}

const sessions = {} as SessionStore;

describe('collectTools', () => {
  it('collects all 25 tools without starting an MCP server', () => {
    const tools = collectTools({ config: appConfig(), sessions, logger });
    expect(tools.size).toBe(25);
    for (const name of ['apple_accounts', 'mail_search', 'calendar_create_event', 'reminders_list', 'contacts_search']) {
      expect(tools.has(name), `缺少 ${name}`).toBe(true);
    }
  });

  it('carries each tool schema and handler through unchanged', () => {
    const tools = collectTools({ config: appConfig(), sessions, logger });
    const search = tools.get('mail_search')!;
    expect(typeof search.handler).toBe('function');
    expect(search.config.inputSchema).toHaveProperty('session_id');
    expect(search.config.description.length).toBeGreaterThan(0);
  });

  it('honours capability gating exactly as the MCP entrypoints do', () => {
    // 邮件能力全关的账号：mail_* 一个都不该被注册
    const tools = collectTools({
      config: appConfig({ mailRead: false, mailWrite: false }),
      sessions,
      logger,
    });
    expect([...tools.keys()].filter((n) => n.startsWith('mail_')), '能力门控必须与 MCP 入口一致').toHaveLength(0);
    expect(tools.has('calendar_list')).toBe(true);
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把 `collectTools` 改成只收集前 10 个工具，确认 `collects all 25 tools` 转红；改回。

- [ ] **Step 3: 运行确认两个文件都失败**

Run: `npx vitest run tests/unit/cli/`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现**

`registry.ts`：一个对象字面量满足 `ToolRegistrar`，`registerTool` 往 Map 里塞 `{ name, config, handler }`，然后调 `registerAllTools`。就这么多——不要在这里做任何校验或转换。

`flags.ts` 的 schema 内省要点（zod 4.4.3，已实测）：逐层剥 `optional` 与 `nullable` 包装（读 `_def.type` 与 `_def.innerType`），记下剥掉了哪些，再看最内层的 `_def.type` 决定 `kind`。`object`/`array` 一律归为 `json`。`.description` **两个位置都要找**。实测（zod 4.4.3）：`z.string().optional().describe('x')` 的描述在最外层，而 `z.string().describe('x').optional()` 的最外层是 `undefined`、描述在剥开后的内层——**本项目两种写法都有**。所以剥壳的每一层都要检查 `description`，取第一个非空的；只看最外层会让一半工具的帮助文本变空，而且是静默变空、没有任何报错。

`parseFlags` 逐个 token 走：`--unset-<key>` 优先匹配（否则会被当成未知 flag）；布尔 flag 不吃下一个 token；其余 flag 吃下一个 token **不管它是否以短横开头**——那是合法值。

- [ ] **Step 5: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/cli/registry.ts src/cli/flags.ts tests/unit/cli/
git commit -m "feat(cli): collect the tool registry and derive flags from each schema"
```

---

## Task 2: 一次性执行模式

**Files:**
- Create: `src/cli/execute.ts`、`src/bin/cli.ts`
- Modify: `package.json`（新增 `cli` 脚本）
- Test: `tests/unit/cli/execute.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `collectTools`/`deriveFlags`/`parseFlags`/`renderHelp`、`loadConfig`（`src/core/config.js`）、`createSessionStore`（`src/core/session.js`）、`createProviders`（`src/providers/icloud/index.js`）、`AppError`
- Produces:

```ts
// src/cli/execute.ts
export interface ExecuteResult {
  /** 工具返回的 JSON（已从 MCP 的 content 信封里取出）。 */
  value: unknown;
  /** 工具以结构化错误失败时为 true；此时 value 是 { error: {...} }。 */
  isError: boolean;
}
/**
 * 在一个隐式会话里执行一次工具调用：建会话 → 注入 session_id → 调用 → 销毁。
 * 会话的销毁放在 finally，任何失败路径都不会漏掉连接。
 */
export function executeOnce(deps: {
  config: AppConfig;
  logger: Logger;
  tools: Map<string, CollectedTool>;
}, call: { tool: string; args: Record<string, unknown> }): Promise<ExecuteResult>;
```

### 会话隐式化的实现

需要会话的工具的 `inputSchema` 里都有 `session_id`。`executeOnce` 的职责就是把它填上：

1. `createSessionStore` + `createProviders` 建一个会话（等价于 `apple_login` 做的事）
2. 把 `session_id` 注入 `args`
3. 调 handler
4. **`finally` 里销毁会话**——这一步不能漏，它关闭 IMAP/SMTP 连接

`apple_accounts` 不需要会话（它的 schema 里没有 `session_id`），**所以判断依据是「schema 里有没有 session_id」，不是硬编码工具名单**。硬编码名单会在加新工具时悄悄过时。

### stdout 只放结果

成功 → 结果 JSON 写 **stdout**，退出码 0。
工具返回结构化错误 → 错误载荷写 **stderr**，退出码 **2**。
CLI 自身出错（未知命令、参数非法、配置缺失）→ 说明写 stderr，退出码 **1**。

两种失败码分开是有用的：调用方能区分「工具执行了但失败了」（可能要看 `retryable`、可能要换参数重试）和「命令根本没跑起来」（重试没有意义）。

**结果 JSON 里不要包 MCP 的 `content` 信封**——那是协议的东西，CLI 的调用方不关心。取 `content[0].text` 解析后直接输出。

- [ ] **Step 1: 写失败测试 `tests/unit/cli/execute.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { executeOnce } from '../../../src/cli/execute.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import { z } from 'zod';

const logger = createLogger('error', () => {});

const config = {
  accounts: [
    {
      id: 'account_1', label: 'a@icloud.com', email: 'a@icloud.com', sender: 'a@icloud.com',
      appPassword: 'x',
      capabilities: {
        mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
        remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
      },
    },
  ],
  sessionTtlMs: 60_000, imapIdleTimeoutMs: 60_000, logLevel: 'error',
  deprecations: [], notices: [],
} as AppConfig;

function toolsWith(overrides: Partial<Record<string, CollectedTool>> = {}): Map<string, CollectedTool> {
  const seen: { sessionId?: unknown } = {};
  const withSession: CollectedTool = {
    name: 'mail_search',
    config: { description: 'x', inputSchema: { session_id: z.string(), folder: z.string().optional() } },
    handler: async (args) => {
      seen.sessionId = (args as { session_id?: string }).session_id;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, got: args }) }] };
    },
  };
  const noSession: CollectedTool = {
    name: 'apple_accounts',
    config: { description: 'x', inputSchema: {} },
    handler: async () => ({ content: [{ type: 'text', text: JSON.stringify([{ email: 'a@icloud.com' }]) }] }),
  };
  const map = new Map<string, CollectedTool>([
    ['mail_search', withSession],
    ['apple_accounts', noSession],
  ]);
  for (const [k, v] of Object.entries(overrides)) if (v) map.set(k, v);
  (map as unknown as { __seen: typeof seen }).__seen = seen;
  return map;
}

describe('executeOnce', () => {
  it('injects a session_id for a tool whose schema asks for one', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'mail_search', args: { folder: 'INBOX' } });
    const got = (res.value as { got: { session_id?: string; folder?: string } }).got;
    expect(got.session_id, 'schema 里有 session_id 就必须注入').toBeTruthy();
    expect(got.folder).toBe('INBOX');
  });

  it('does not invent a session for a tool that does not ask for one', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'apple_accounts', args: {} });
    expect(Array.isArray(res.value)).toBe(true);
    expect(res.isError).toBe(false);
  });

  it('unwraps the MCP content envelope', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'apple_accounts', args: {} });
    expect(res.value, 'content 信封是协议的东西，CLI 调用方不该看到').not.toHaveProperty('content');
  });

  it('reports a structured tool error without throwing', async () => {
    const failing: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'AUTH_FAILED', message: '认证失败', retryable: false } }) }],
        isError: true,
      }),
    };
    const res = await executeOnce({ config, logger, tools: toolsWith({ mail_search: failing }) },
      { tool: 'mail_search', args: {} });
    expect(res.isError).toBe(true);
    expect((res.value as { error: { code: string } }).error.code).toBe('AUTH_FAILED');
  });

  it('destroys the session even when the handler throws', async () => {
    const closed: string[] = [];
    const throwing: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => { throw new Error('boom'); },
    };
    await expect(
      executeOnce({ config, logger, tools: toolsWith({ mail_search: throwing }) }, { tool: 'mail_search', args: {} }),
    ).rejects.toThrow();
    // 会话销毁的证据由实现暴露：见 Step 4 的 onSessionClosed 钩子说明
  });

  it('rejects an unknown tool name', async () => {
    await expect(
      executeOnce({ config, logger, tools: toolsWith() }, { tool: 'no_such_tool', args: {} }),
    ).rejects.toThrow();
  });
});
```

**注意**：上面 `destroys the session even when the handler throws` 那条测试**只断言了抛出，没有断言会话真的被销毁**——这样写它无法区分「销毁了」和「没销毁」。Step 4 要求实现暴露一个可注入的会话工厂，然后把这条测试改成断言销毁确实发生。**先照抄，Step 4 再补**，这是刻意的：先让它红，再让它有意义。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/cli/execute.test.ts`

- [ ] **Step 3: 实现 `execute.ts`**

要点：

- 判断是否需要会话：`'session_id' in tool.config.inputSchema`。**不要硬编码工具名单**。
- 会话工厂做成可注入的可选依赖（默认用真实的 `createSessionStore` + `createProviders`），这样测试能观察销毁行为。
- `finally` 里销毁会话。
- 解析 `content[0].text`；解析失败要抛一个说明清楚的错误，而不是把原始文本吐出去。

- [ ] **Step 4: 把那条空转的测试改成真测试**

给 `executeOnce` 的 deps 加一个可选的会话工厂，测试注入一个能记录 `close` 调用的假实现，然后断言：

```ts
  it('destroys the session even when the handler throws', async () => {
    const closed: string[] = [];
    const sessionFactory = makeFakeSessionFactory(closed);   // 记录销毁
    const throwing: CollectedTool = { /* 同上，handler 抛异常 */ };
    await expect(
      executeOnce({ config, logger, tools: toolsWith({ mail_search: throwing }), sessionFactory },
        { tool: 'mail_search', args: {} }),
    ).rejects.toThrow();
    expect(closed, 'handler 抛异常时会话仍必须销毁，否则会漏一条 IMAP 连接').toHaveLength(1);
  });
```

**鉴别性实验（必做，贴两次输出）**：把 `finally` 里的销毁改成只在成功路径上执行，确认这条测试转红；改回。

- [ ] **Step 5: 实现 `bin/cli.ts` 并接上 package.json**

分派逻辑：

```
cli --list                 列出全部工具（名字 + 一行描述）
cli <tool> --help          从 schema 生成该工具的帮助
cli <tool> [flags...]      执行
```

`.env` 加载：CLI 自己读（stdio 入口靠客户端注入 env，CLI 没有那个父进程）。用已有的 `dotenv`，只在 `.env` 存在时加载，**不要覆盖已经存在的环境变量**——沙盒里可能是直接注入的。

退出码：0 成功 / 2 工具返回结构化错误 / 1 CLI 自身错误。

`package.json` 加：

```json
"cli": "node dist/bin/cli.js"
```

- [ ] **Step 6: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run && npm run build
git add src/cli/execute.ts src/bin/cli.ts package.json tests/unit/cli/execute.test.ts
git commit -m "feat(cli): run a single tool call in an implicit session"
```

---

## Task 3: 守护进程与本地传输

**Files:**
- Create: `src/cli/transport.ts`、`src/cli/daemon.ts`、`src/cli/client.ts`
- Modify: `src/bin/cli.ts`（接上 `start`/`stop`，以及"先试守护进程"的分派）
- Test: `tests/unit/cli/transport.test.ts`、`tests/unit/cli/daemon.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `collectTools`、Task 2 的 `executeOnce`、`AppConfig`、`Logger`
- Produces:

```ts
// src/cli/transport.ts
export type Endpoint =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; port: number; token: string };

export interface EndpointFiles {
  /** 描述当前监听端点的文件；权限 600。 */
  infoPath: string;
  /** unix 模式下的 socket 路径。 */
  socketPath: string;
}
/** 端点文件放在临时目录，随沙盒销毁；可用 MCP_CLI_RUNTIME_DIR 覆盖。 */
export function endpointFiles(): EndpointFiles;
/** 本平台能不能用 unix socket。Windows 沙箱下实测为 EACCES，需要 TCP 兜底。 */
export function canUseUnixSocket(): Promise<boolean>;
export function writeEndpoint(files: EndpointFiles, ep: Endpoint): Promise<void>;
export function readEndpoint(files: EndpointFiles): Promise<Endpoint | undefined>;
export function clearEndpoint(files: EndpointFiles): Promise<void>;

// src/cli/daemon.ts
export interface DaemonHandle {
  endpoint: Endpoint;
  close(): Promise<void>;
}
export function startDaemon(deps: {
  config: AppConfig;
  logger: Logger;
  idleMs?: number;          // 默认 15 分钟
  files?: EndpointFiles;    // 测试注入
  /** 强制走 TCP 传输。只给测试用——否则 POSIX 上永远走 unix，令牌那条路径没人验证。 */
  forceTcp?: boolean;
}): Promise<DaemonHandle>;

// src/cli/client.ts
export interface CallRequest { tool: string; args: Record<string, unknown> }
/** 连守护进程执行；连不上返回 undefined，由调用方退回一次性模式。 */
export function callDaemon(req: CallRequest, files?: EndpointFiles): Promise<ExecuteResult | undefined>;
export function stopDaemon(files?: EndpointFiles): Promise<boolean>;
```

### 为什么必须是常驻进程

会话持有活的 IMAP/TLS 连接。进程一退出 socket 就没了——一个写在文件里的 `session_id`，下次拿到手里是死号，**连接不能序列化**。要复用就得有一个进程活着。

守护进程真正省下的不只是几次登录验证，还有每次命令都要重做的 **TCP + TLS + AUTH 握手**。

### socket 的权限就是全部的访问控制

守护进程后面挂着一个**已登录、握着用户 iCloud 连接的会话**。谁连上谁就能读用户的邮件。

实测（WSL Ubuntu 22.04 / 远程 Ubuntu 24.04）：

```
Node 创建的 unix socket 默认权限: 755（远程机器上 775）
chmod 600 之后: 600，自己仍然连得上
```

**所以 `listen` 之后必须立刻 `chmod 600`。** 默认值是敞开的。

Windows 本地实测 unix socket 与命名管道**都是 `EACCES`**（沙箱策略），因此需要 TCP 兜底。但本机任何进程都能连 TCP 端口，没有文件权限可依赖——**TCP 路径必须加握手令牌**：守护进程生成一个随机令牌写进 `600` 的端点文件，客户端读出来、连接后先发它；不匹配立刻断开。

两条传输由此对齐：**安全性归结为「能不能读到那个 600 的文件」**。

这条的失败形态是「功能完全正常，只是别人也能用」——没有任何症状，所以必须有测试守着。

### 僵死端点

守护进程被 kill 或沙盒重启后，端点文件可能还在但没人监听。客户端连不上时**必须清理掉它再退回一次性模式**，否则每条命令都要先经历一次连接超时。

- [ ] **Step 1: 写失败测试 `tests/unit/cli/transport.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  endpointFiles, canUseUnixSocket, writeEndpoint, readEndpoint, clearEndpoint,
} from '../../../src/cli/transport.js';

let dir: string;
let files: ReturnType<typeof endpointFiles>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-ep-'));
  files = { infoPath: join(dir, 'endpoint.json'), socketPath: join(dir, 'cli.sock') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('endpoint file', () => {
  it('round-trips a unix endpoint', async () => {
    await writeEndpoint(files, { kind: 'unix', path: files.socketPath });
    expect(await readEndpoint(files)).toEqual({ kind: 'unix', path: files.socketPath });
  });

  it('round-trips a tcp endpoint with its token', async () => {
    await writeEndpoint(files, { kind: 'tcp', port: 12345, token: 'sekrit' });
    expect(await readEndpoint(files)).toEqual({ kind: 'tcp', port: 12345, token: 'sekrit' });
  });

  it('writes the endpoint file 0600, since it carries the tcp token', async () => {
    await writeEndpoint(files, { kind: 'tcp', port: 1, token: 'sekrit' });
    if (process.platform === 'win32') {
      // Windows 上 POSIX 权限位无意义，这里只断言文件存在；真正的检查在 WSL/Linux 上跑
      expect(existsSync(files.infoPath)).toBe(true);
      return;
    }
    const mode = statSync(files.infoPath).mode & 0o777;
    expect(mode, '端点文件里有 TCP 令牌，权限放宽等于把会话交出去').toBe(0o600);
  });

  it('returns undefined when there is no endpoint file', async () => {
    expect(await readEndpoint(files)).toBeUndefined();
  });

  it('returns undefined rather than throwing on a corrupted endpoint file', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(files.infoPath, 'not json', 'utf8');
    expect(await readEndpoint(files)).toBeUndefined();
  });

  it('clears both the info file and the socket file', async () => {
    await writeEndpoint(files, { kind: 'unix', path: files.socketPath });
    await clearEndpoint(files);
    expect(existsSync(files.infoPath)).toBe(false);
  });
});

describe('endpointFiles', () => {
  it('honours MCP_CLI_RUNTIME_DIR so a sandbox can pin the location', () => {
    const prev = process.env.MCP_CLI_RUNTIME_DIR;
    process.env.MCP_CLI_RUNTIME_DIR = dir;
    try {
      const f = endpointFiles();
      expect(f.infoPath.startsWith(dir)).toBe(true);
      expect(f.socketPath.startsWith(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MCP_CLI_RUNTIME_DIR;
      else process.env.MCP_CLI_RUNTIME_DIR = prev;
    }
  });

  it('falls back to the OS temp dir', () => {
    const prev = process.env.MCP_CLI_RUNTIME_DIR;
    delete process.env.MCP_CLI_RUNTIME_DIR;
    try {
      expect(endpointFiles().infoPath.length).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env.MCP_CLI_RUNTIME_DIR = prev;
    }
  });
});

describe('canUseUnixSocket', () => {
  it('answers without throwing, whatever the platform', async () => {
    const ok = await canUseUnixSocket();
    expect(typeof ok).toBe('boolean');
    if (process.platform !== 'win32') {
      expect(ok, 'POSIX 平台上 unix socket 应当可用；不可用会静默退到 TCP，那条路径依赖令牌').toBe(true);
    }
  });
});
```

- [ ] **Step 2: 写失败测试 `tests/unit/cli/daemon.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { startDaemon } from '../../../src/cli/daemon.js';
import { callDaemon, stopDaemon } from '../../../src/cli/client.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';

const logger = createLogger('error', () => {});
const config = {
  accounts: [{
    id: 'account_1', label: 'a@icloud.com', email: 'a@icloud.com', sender: 'a@icloud.com', appPassword: 'x',
    capabilities: {
      mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
      remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
    },
  }],
  sessionTtlMs: 60_000, imapIdleTimeoutMs: 60_000, logLevel: 'error', deprecations: [], notices: [],
} as AppConfig;

let dir: string;
let files: { infoPath: string; socketPath: string };
let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-d-'));
  files = { infoPath: join(dir, 'endpoint.json'), socketPath: join(dir, 'cli.sock') };
  handle = undefined;
});
afterEach(async () => {
  await handle?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('daemon lifecycle', () => {
  it('starts, serves a call, and stops', async () => {
    handle = await startDaemon({ config, logger, files });
    const res = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(res, '守护进程在跑时不该退回一次性模式').toBeDefined();
    expect(Array.isArray(res!.value)).toBe(true);
    expect(await stopDaemon(files)).toBe(true);
  });

  it('serves several calls over one session', async () => {
    handle = await startDaemon({ config, logger, files });
    const a = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    const b = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it('reports a tool error without killing the daemon', async () => {
    handle = await startDaemon({ config, logger, files });
    const bad = await callDaemon({ tool: 'no_such_tool', args: {} }, files);
    expect(bad?.isError, '未知工具应当作为一次失败的调用返回，而不是打死守护进程').toBe(true);
    const after = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(after, '一次坏调用之后守护进程必须还活着').toBeDefined();
  });
});

describe('daemon access control', () => {
  it.skipIf(process.platform === 'win32')(
    'chmods the unix socket to 0600 — the default is world-accessible',
    async () => {
      handle = await startDaemon({ config, logger, files });
      if (handle.endpoint.kind !== 'unix') {
        // TCP 模式下这条不适用；令牌那条测试覆盖它
        return;
      }
      const mode = statSync(handle.endpoint.path).mode & 0o777;
      expect(mode, 'Node 建出来默认是 755/775，谁都能连；那后面挂着一个已登录的 iCloud 会话').toBe(0o600);
    },
  );

  it('refuses a tcp connection that presents no token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') return;
    const port = handle.endpoint.port;
    const closed = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify({ tool: 'apple_accounts', args: {} }) + String.fromCharCode(10)));
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('close', () => resolve(got.length === 0 || !got.includes('email')));
      setTimeout(() => { c.destroy(); resolve(true); }, 2000);
    });
    expect(closed, 'TCP 路径没有文件权限可依赖，令牌是唯一的门').toBe(true);
  });

  it('refuses a tcp connection presenting the wrong token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') return;
    const port = handle.endpoint.port;
    const rejected = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write(JSON.stringify({ token: 'wrong-token', tool: 'apple_accounts', args: {} }) + String.fromCharCode(10));
      });
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('close', () => resolve(!got.includes('email')));
      setTimeout(() => { c.destroy(); resolve(true); }, 2000);
    });
    expect(rejected).toBe(true);
  });
});

describe('client fallback', () => {
  it('returns undefined when no daemon is running', async () => {
    expect(await callDaemon({ tool: 'apple_accounts', args: {} }, files)).toBeUndefined();
  });

  it('clears a stale endpoint file instead of timing out on every call', async () => {
    const { writeFileSync, existsSync } = await import('node:fs');
    writeFileSync(files.infoPath, JSON.stringify({ kind: 'unix', path: files.socketPath }), { mode: 0o600 });
    const res = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(res).toBeUndefined();
    expect(existsSync(files.infoPath), '僵死端点不清掉，之后每条命令都要先超时一次').toBe(false);
  });

  it('stopDaemon returns false when nothing is running', async () => {
    expect(await stopDaemon(files)).toBe(false);
  });
});

describe('idle shutdown', () => {
  it('exits on its own after the idle window, so a forgotten daemon does not linger', async () => {
    handle = await startDaemon({ config, logger, files, idleMs: 150 });
    await new Promise((r) => setTimeout(r, 500));
    expect(await callDaemon({ tool: 'apple_accounts', args: {} }, files),
      '空闲超时后守护进程应已退出，调用方退回一次性模式').toBeUndefined();
  });
});
```

**注意 `forceTcp`**：`startDaemon` 需要一个测试专用开关，强制走 TCP 路径，否则在 POSIX 上那两条令牌测试永远走不到。Step 3 要把它加进 deps（可选、只在测试里用）。

**鉴别性实验（必做，贴三次输出）**：

1. 去掉 `chmod 600`，在 **WSL 里**确认 `chmods the unix socket to 0600` 转红；改回。（Windows 上这条被 skip，所以必须在 WSL 跑。）
2. 去掉令牌校验，确认两条 TCP 测试转红；改回。
3. 去掉僵死端点清理，确认 `clears a stale endpoint file` 转红；改回。

- [ ] **Step 3: 运行确认失败**

Run（Windows）：`npx vitest run tests/unit/cli/`
Run（WSL，必须）：`wsl -d Ubuntu-22.04 -e bash -lc "cd /mnt/f/apple_mcp && npx vitest run tests/unit/cli/"`

- [ ] **Step 4: 实现**

协议：一行一个 JSON（换行分隔）。请求 `{ token?, tool, args }`，响应 `{ value, isError }` 或 `{ error }`。用换行分隔而不是长度前缀，是因为调试时能直接 `nc` 上去看。

`startDaemon`：先 `canUseUnixSocket()` 决定传输，`forceTcp: true` 时直接走 TCP（该参数只给测试用，但**必须真实声明在 deps 类型里**——用 `as never` 强转塞进去会同时绕过类型检查和这类接口不一致）；unix 模式下 `listen` 后**立刻 `chmodSync(path, 0o600)`**；TCP 模式下 `randomBytes(32).toString('base64url')` 生成令牌，`listen(0, '127.0.0.1')` 只绑本地回环。两种模式都写端点文件（`mode: 0o600`）。

会话：守护进程启动时建一次，所有请求复用。**空闲计时器每次请求重置**，到点则销毁会话、关闭监听、删除端点文件、退出。

`callDaemon`：读端点 → 连 → 发请求 → 读一行响应。连接失败（`ENOENT`/`ECONNREFUSED`）时**清理端点文件**并返回 `undefined`。

- [ ] **Step 5: 接进 `bin/cli.ts`**

```
cli start    起守护进程（后台），打印它监听在哪
cli stop     停守护进程
cli <tool>   先试 callDaemon；返回 undefined 就退回 executeOnce
```

**"先试守护进程、失败退回一次性"这条分派必须有测试**——它是"常驻模式省时间"这个卖点唯一的落点，写反了就是每条命令都在重新登录，而功能表现完全正常。

- [ ] **Step 6: 两个平台都跑通后提交**

```bash
npm run typecheck && npx vitest run && npm run build
wsl -d Ubuntu-22.04 -e bash -lc "cd /mnt/f/apple_mcp && npx vitest run"
git add src/cli/ src/bin/cli.ts tests/unit/cli/
git commit -m "feat(cli): hold a reusable session in a local daemon"
```

---

## Task 4: 批量模式与文档

**Files:**
- Modify: `src/bin/cli.ts`、`SKILL.md`、`docs/部署与-Routine-接入.md`
- Create: `src/cli/batch.ts`、`docs/沙盒-CLI-用法.md`
- Test: `tests/unit/cli/batch.test.ts`

**Interfaces:**

```ts
// src/cli/batch.ts
export interface BatchOp { tool: string; args?: Record<string, unknown> }
export interface BatchOutcome { tool: string; ok: boolean; value: unknown }
/** 一次会话跑完一串操作。stopOnError 为 true 时首个失败即停止。 */
export function runBatch(deps: {
  config: AppConfig; logger: Logger; tools: Map<string, CollectedTool>;
}, ops: BatchOp[], opts?: { stopOnError?: boolean }): Promise<BatchOutcome[]>;
```

- [ ] **Step 1: 写失败测试 `tests/unit/cli/batch.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runBatch } from '../../../src/cli/batch.js';
import { createLogger } from '../../../src/core/logger.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import type { AppConfig } from '../../../src/core/config.js';

const logger = createLogger('error', () => {});
const config = {
  accounts: [{
    id: 'account_1', label: 'a', email: 'a@icloud.com', sender: 'a@icloud.com', appPassword: 'x',
    capabilities: {
      mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
      remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
    },
  }],
  sessionTtlMs: 60_000, imapIdleTimeoutMs: 60_000, logLevel: 'error', deprecations: [], notices: [],
} as AppConfig;

let logins = 0;
function tools(): Map<string, CollectedTool> {
  const ok: CollectedTool = {
    name: 'apple_accounts',
    config: { description: 'x', inputSchema: {} },
    handler: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }),
  };
  const bad: CollectedTool = {
    name: 'mail_search',
    config: { description: 'x', inputSchema: { session_id: z.string() } },
    handler: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有' } }) }],
      isError: true,
    }),
  };
  return new Map([['apple_accounts', ok], ['mail_search', bad]]);
}

describe('runBatch', () => {
  it('returns one outcome per operation, in order', async () => {
    const out = await runBatch({ config, logger, tools: tools() }, [
      { tool: 'apple_accounts' }, { tool: 'apple_accounts' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it('keeps going past a failure by default, and marks which one failed', async () => {
    const out = await runBatch({ config, logger, tools: tools() }, [
      { tool: 'mail_search' }, { tool: 'apple_accounts' },
    ]);
    expect(out.map((o) => o.ok), '默认不中断——一个只读操作失败不该让后面的都不跑').toEqual([false, true]);
  });

  it('stops at the first failure when asked', async () => {
    const out = await runBatch({ config, logger, tools: tools() },
      [{ tool: 'mail_search' }, { tool: 'apple_accounts' }], { stopOnError: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.ok).toBe(false);
  });

  it('rejects an unknown tool in the batch before running anything', async () => {
    await expect(
      runBatch({ config, logger, tools: tools() }, [{ tool: 'apple_accounts' }, { tool: 'nope' }]),
      '整批先校验：跑了一半才发现第三条拼错了，前两条的副作用已经发生了',
    ).rejects.toThrow();
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把"整批先校验工具名"改成边跑边查，确认 `rejects an unknown tool in the batch before running anything` 转红；改回。

- [ ] **Step 2: 运行确认失败并实现**

`runBatch` 先把所有 `tool` 名字对着 Map 校验一遍，全部存在才开始执行；然后建**一个**会话跑完全部操作，`finally` 销毁。

`bin/cli.ts` 加 `cli batch ops.json`，输出是 `BatchOutcome[]` 的 JSON。全部成功退出 0；有失败退出 2。

- [ ] **Step 3: SKILL.md 补一条禁令**

在「Running unattended」一节里加：

> **Never print the credential file or the variables it sets.** In a sandbox the password stays out of the conversation only because nothing echoes it — `cat .env`, `env`, `echo $ICLOUD_APP_PASSWORD_1`, and printing a command that embeds it all defeat that. If you need to check whether a variable is set, test that it is non-empty; do not print its value.

理由要写进去而不是只写规则：**"密码不进上下文"这条性质，靠的不是任何机制，而是没人去打印它。**

- [ ] **Step 4: 写 `docs/沙盒-CLI-用法.md`（中文）**

面向部署者，覆盖：

- 沙盒里的完整流程：拉库 → `npm ci` → `npm run build` → 准备 `.env` → 跑命令
- 一次性 vs 常驻两种模式，以及什么时候值得 `start`
- `--list` / `--help` 怎么看
- 三态字段的 `--unset-<key>` 怎么用
- 批量模式的 `ops.json` 格式
- 退出码 0/1/2 的含义与 shell 里怎么判断
- **明确写出：不要 `cat .env`**，以及为什么

- [ ] **Step 5: 在 `docs/部署与-Routine-接入.md` 里加一节指路**

那份文档现在只讲远程 HTTP 部署。加一小节说明：如果你的 Routine 能用 shell（cowork 沙盒），沙盒 CLI 这条路不需要域名、证书、OAuth，而且**每个人带自己的 `.env`**——远程部署那个"凭据必须常驻在服务器上"的限制在这里不存在。链到新文档。

- [ ] **Step 6: 全量验证（两个平台）并提交**

```bash
npm run typecheck && npx vitest run && npm run build
wsl -d Ubuntu-22.04 -e bash -lc "cd /mnt/f/apple_mcp && npx vitest run"
git add -A
git commit -m "feat(cli): add batch mode, and document sandbox usage"
```

---

## 完成标准

1. `npm run typecheck`、`npx vitest run`、`npm run build` 全绿；`npm audit` 为 0；**无新增依赖**。
2. **WSL 里跑一次完整套件也全绿**——unix socket 那条是生产路径，不能只在 Windows 上跑（那里它会被 skip）。
3. `cli --list` 列出 25 个工具；`cli mail_search --help` 的内容与 schema 一致。
4. 一次性模式：单条命令能建会话、执行、销毁，连接不残留。
5. 常驻模式：`start` 之后多条命令复用同一会话；`stop` 之后退回一次性模式。
6. unix socket 权限是 `600`；TCP 路径无令牌或错令牌一律拒绝。
7. 僵死端点文件被自动清理，不会让每条命令先超时一次。
8. stdout 只有结果 JSON；退出码 0 / 1 / 2 区分正确。
9. stdio 与 HTTP 两个入口**行为完全未变**——工具数仍是 25，`apple_login` 语义不变。
