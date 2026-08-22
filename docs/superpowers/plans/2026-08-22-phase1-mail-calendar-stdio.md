# 阶段一实现计划：Core + Mail + Calendar + stdio

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 apple-icloud-mcp 重构成一个本地 stdio 可用的 MCP server，提供邮件与日历能力，所有协议细节（MIME/iCal）在服务端处理完毕。

**Architecture:** 严格单向分层 `bin → server → modules/*/tools → modules/*/service → providers`。service 层通过构造函数接收 provider 接口，因此单测中整体替换为假实现，不需要网络。解析层（MIME/iCal）是纯函数模块，用固化 fixture 驱动测试。

**Tech Stack:** Node 20 LTS · TypeScript 5.7 (ESM, NodeNext) · @modelcontextprotocol/sdk 1.30 · imapflow 1.7 · mailparser 3.9 · nodemailer 9 · tsdav 2.3 · ical.js 2.2 · zod 4.4 · vitest 4.1

**Spec:** `docs/superpowers/specs/2026-08-22-apple-icloud-mcp-refactor-design.md`

## Global Constraints

- Node 基线 **20 LTS**；`package.json` 声明 `"engines": {"node": ">=20"}`。
- TypeScript **ESM**：`"type": "module"`，tsconfig `module`/`moduleResolution` 均为 `NodeNext`，**所有相对导入必须带 `.js` 后缀**（即使源文件是 `.ts`）。
- 依赖版本锁定为：`@modelcontextprotocol/sdk@1.30.0` · `imapflow@1.7.2` · `mailparser@3.9.15` · `nodemailer@9.0.5` · `tsdav@2.3.1` · `ical.js@2.2.1` · `zod@4.4.3` · `vitest@4.1.11` · `dotenv@17.4.2`。不引入 `uuid`（用 `crypto.randomUUID`）、不引入 `express`/`cors`（阶段三才需要）。
- **stdio 传输下 stdout 属于 MCP 协议**。任何日志、警告、调试输出一律走 **stderr**。业务代码中不得出现 `console.log`。
- 权限缺省值：**读操作缺省 `true`，写操作缺省 `false`**。
- 环境变量新命名为大写下划线（`ICLOUD_ACCOUNT_1` 等），旧的小写命名保留兼容映射并记录弃用提示。
- 时间在工具边界一律是 **ISO 8601 带时区偏移的字符串**；内部传递用 `Date`。
- 凭据（App 专用密码）不得出现在任何日志、错误消息、异常 message 中。
- 每个任务结束时 `npx tsc --noEmit` 与 `npx vitest run` 必须全绿才提交。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/errors.ts` | `AppError`、`ErrorCode` 枚举、`toErrorPayload()` |
| `src/core/logger.ts` | 分级日志（写 stderr）、敏感信息脱敏 |
| `src/core/config.ts` | zod schema、旧变量名兼容、账号解析与查找 |
| `src/core/ids.ts` | 不透明资源 ID 的编解码 |
| `src/core/session.ts` | 会话存储、TTL、清理定时器、每会话连接缓存 |
| `src/parsers/mime.ts` | mailparser 封装：解码、HTML→文本、摘要生成 |
| `src/parsers/ical.ts` | ical.js 封装：VEVENT 解析与生成、RRULE 结构化互转、展开 |
| `src/providers/icloud/imap.ts` | ImapFlow 封装与错误映射，`ImapProvider` 接口 |
| `src/providers/icloud/smtp.ts` | nodemailer 封装，`SmtpProvider` 接口 |
| `src/providers/icloud/caldav.ts` | tsdav 封装，`CalDavProvider` 接口 |
| `src/modules/mail/{types,service,tools}.ts` | 邮件领域类型、业务逻辑、MCP 工具定义 |
| `src/modules/calendar/{types,service,tools}.ts` | 日历领域类型、业务逻辑、MCP 工具定义 |
| `src/modules/session/tools.ts` | `apple_accounts` / `apple_login` / `work_done` |
| `src/server/createServer.ts` | 按能力开关装配并注册模块 |
| `src/bin/stdio.ts` | stdio 入口 |
| `tests/unit/**` | 解析层与服务层单测 |
| `tests/fixtures/**` | 真实报文与 .ics 样本 |
| `tests/integration/**` | 默认 skip 的真实账号测试 |

---

### Task 1: 项目骨架重建

清空旧实现，建立新的依赖、构建与测试基线。这是后续所有任务的前提。

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `tests/unit/smoke.test.ts`
- Delete: `src/config.ts`, `src/server.ts`, `src/services/auth.ts`, `src/services/calendar.ts`, `src/services/mail.ts`, `dist/`

**Interfaces:**
- Consumes: 无
- Produces: 可运行的 `npm test` / `npm run build` / `npm run typecheck`

- [ ] **Step 1: 删除旧实现与构建产物**

```bash
rm -rf src dist
mkdir -p src tests/unit tests/fixtures tests/integration
```

- [ ] **Step 2: 重写 `package.json`**

```json
{
  "name": "apple-icloud-mcp",
  "version": "2.0.0",
  "description": "MCP server for Apple iCloud Mail, Calendar, Reminders and Contacts",
  "type": "module",
  "main": "dist/bin/stdio.js",
  "bin": { "apple-icloud-mcp": "dist/bin/stdio.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "start": "tsx src/bin/stdio.ts",
    "serve": "node dist/bin/stdio.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "dotenv": "17.4.2",
    "ical.js": "2.2.1",
    "imapflow": "1.7.2",
    "mailparser": "3.9.15",
    "nodemailer": "9.0.5",
    "tsdav": "2.3.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/mailparser": "3.4.6",
    "@types/node": "22.10.2",
    "@types/nodemailer": "6.4.17",
    "tsx": "4.19.2",
    "typescript": "5.7.3",
    "vitest": "4.1.11"
  }
}
```

- [ ] **Step 3: 重写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
  },
});
```

- [ ] **Step 5: 创建 `.env.example`**

```bash
# ---- 账号 1（必填）----
# Apple ID 邮箱：用于 CalDAV / CardDAV 认证
ICLOUD_ACCOUNT_1=your-name@icloud.com
# App 专用密码：https://appleid.apple.com 生成，格式 xxxx-xxxx-xxxx-xxxx
ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop
# 邮件收发身份（IMAP/SMTP 认证）。留空则与 ICLOUD_ACCOUNT_1 相同
# ICLOUD_SENDER_1=your-alias@icloud.com
# 展示名，多账号时便于区分
# ICLOUD_LABEL_1=personal

# ---- 权限：读缺省开启，写缺省关闭 ----
ALLOW_MAIL_READ_1=true
ALLOW_MAIL_WRITE_1=false
ALLOW_CALENDAR_READ_1=true
ALLOW_CALENDAR_WRITE_1=false

# ---- 账号 2-5（可选，后缀 _2 .. _5）----
# ICLOUD_ACCOUNT_2=
# ICLOUD_APP_PASSWORD_2=

# ---- 运行参数 ----
SESSION_TTL_MINUTES=30
IMAP_IDLE_TIMEOUT_SECONDS=300
LOG_LEVEL=info
```

- [ ] **Step 6: 写冒烟测试 `tests/unit/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest with ESM and TypeScript', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: 安装依赖并验证工具链**

```bash
npm install
npx vitest run
```
Expected: vitest 1 passed。（此时 `src/` 为空，`tsc --noEmit` 会报 "No inputs were found"，属正常，下个任务加文件后消失。）

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "chore: rebuild project skeleton for v2 refactor"
```

---

### Task 2: 错误类型

**Files:**
- Create: `src/core/errors.ts`
- Test: `tests/unit/core/errors.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ErrorCode = 'AUTH_FAILED' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'INVALID_INPUT' | 'SESSION_EXPIRED' | 'CONFLICT' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'INTERNAL'`
  - `class AppError extends Error { code: ErrorCode; hint?: string; retryable: boolean; cause?: unknown }`，构造签名 `new AppError(code, message, options?: {hint?, retryable?, cause?})`
  - `function toErrorPayload(err: unknown): { error: { code: ErrorCode; message: string; hint?: string; retryable: boolean } }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { AppError, toErrorPayload } from '../../../src/core/errors.js';

describe('AppError', () => {
  it('defaults retryable to false and keeps code and hint', () => {
    const err = new AppError('PERMISSION_DENIED', '邮件写权限未开启', {
      hint: '在环境变量中设置 ALLOW_MAIL_WRITE_1=true 后重启服务',
    });
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.retryable).toBe(false);
    expect(err.hint).toContain('ALLOW_MAIL_WRITE_1');
    expect(err).toBeInstanceOf(Error);
  });

  it('marks upstream errors retryable when told to', () => {
    const err = new AppError('UPSTREAM_ERROR', 'iCloud 暂时不可达', { retryable: true });
    expect(err.retryable).toBe(true);
  });
});

describe('toErrorPayload', () => {
  it('serializes AppError without leaking the cause', () => {
    const err = new AppError('AUTH_FAILED', 'App 专用密码被拒绝', {
      hint: '确认密码未被吊销',
      cause: new Error('LOGIN failed: password=hunter2'),
    });
    const payload = toErrorPayload(err);
    expect(payload).toEqual({
      error: {
        code: 'AUTH_FAILED',
        message: 'App 专用密码被拒绝',
        hint: '确认密码未被吊销',
        retryable: false,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });

  it('wraps unknown throwables as INTERNAL', () => {
    const payload = toErrorPayload(new TypeError('x is not a function'));
    expect(payload.error.code).toBe('INTERNAL');
    expect(payload.error.retryable).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/core/errors.test.ts`
Expected: FAIL，`Failed to resolve import ... src/core/errors.js`

- [ ] **Step 3: 实现 `src/core/errors.ts`**

```ts
export type ErrorCode =
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'SESSION_EXPIRED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export interface AppErrorOptions {
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    retryable: boolean;
  };
}

/** 把任意抛出物转成给模型看的结构化载荷。cause 只留在日志里，不外泄。 */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof AppError) {
    const error: ErrorPayload['error'] = {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
    };
    if (err.hint !== undefined) error.hint = err.hint;
    return { error };
  }
  return {
    error: {
      code: 'INTERNAL',
      message: '服务内部错误',
      retryable: false,
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/core/errors.test.ts && npx tsc --noEmit`
Expected: 4 passed；tsc 无输出

- [ ] **Step 5: 提交**

```bash
git add src/core/errors.ts tests/unit/core/errors.test.ts
git commit -m "feat(core): add AppError with structured error codes"
```

---

### Task 3: 日志与脱敏

stdio 下 stdout 归 MCP 协议独占，所有输出必须走 stderr。脱敏是硬要求：App 专用密码永远不能进日志。

**Files:**
- Create: `src/core/logger.ts`
- Test: `tests/unit/core/logger.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type LogLevel = 'error' | 'warn' | 'info' | 'debug'`
  - `function redact(value: unknown): unknown`
  - `interface Logger { error(msg: string, meta?: Record<string, unknown>): void; warn(...same); info(...same); debug(...same) }`
  - `function createLogger(level: LogLevel, write?: (line: string) => void): Logger`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { createLogger, redact } from '../../../src/core/logger.js';

describe('redact', () => {
  it('masks credential-bearing keys at any depth', () => {
    const out = redact({
      user: 'a@icloud.com',
      password: 'abcd-efgh-ijkl-mnop',
      nested: { appPassword: 'secret', authorization: 'Bearer xyz', token: 't' },
    }) as Record<string, any>;
    expect(out.user).toBe('a@icloud.com');
    expect(out.password).toBe('***');
    expect(out.nested.appPassword).toBe('***');
    expect(out.nested.authorization).toBe('***');
    expect(out.nested.token).toBe('***');
  });

  it('leaves primitives untouched', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
  });
});

describe('createLogger', () => {
  it('suppresses levels below the configured one', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"level":"warn"');
    expect(lines[1]).toContain('"level":"error"');
  });

  it('redacts metadata before writing', () => {
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l));
    log.info('login', { user: 'a@icloud.com', password: 'abcd-efgh' });
    expect(lines[0]).toContain('a@icloud.com');
    expect(lines[0]).not.toContain('abcd-efgh');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/core/logger.test.ts`
Expected: FAIL，无法解析 `src/core/logger.js`

- [ ] **Step 3: 实现 `src/core/logger.ts`**

```ts
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_KEY = /pass|password|secret|token|authorization|credential|appPass/i;

/** 递归遮蔽敏感字段。凭据永远不进日志。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/** 默认写 stderr —— stdout 在 stdio 传输下属于 MCP 协议，绝不可占用。 */
const writeStderr = (line: string): void => {
  process.stderr.write(line + '\n');
};

export function createLogger(level: LogLevel, write: (line: string) => void = writeStderr): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] > threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
    };
    if (meta) record.meta = redact(meta);
    write(JSON.stringify(record));
  };

  return {
    error: (m, meta) => emit('error', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    info: (m, meta) => emit('info', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/core/logger.test.ts && npx tsc --noEmit`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/logger.ts tests/unit/core/logger.test.ts
git commit -m "feat(core): add stderr logger with credential redaction"
```

---

### Task 4: 配置解析

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/unit/core/config.test.ts`

**Interfaces:**
- Consumes: `AppError` (Task 2)、`LogLevel` (Task 3)
- Produces:
  - `interface Capabilities { mailRead; mailWrite; calendarRead; calendarWrite; remindersRead; remindersWrite; contactsRead; contactsWrite }`（全部 `boolean`）
  - `interface AccountConfig { id: string; email: string; sender: string; label: string; appPassword: string; capabilities: Capabilities }`
  - `interface AppConfig { accounts: AccountConfig[]; sessionTtlMs: number; imapIdleTimeoutMs: number; logLevel: LogLevel; deprecations: string[] }`
  - `function loadConfig(env: NodeJS.ProcessEnv): AppConfig`
  - `function findAccount(config: AppConfig, email?: string): AccountConfig`

`loadConfig` 显式接收 env（而非直接读 `process.env`），因此可纯函数式单测。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, findAccount } from '../../../src/core/config.js';
import { AppError } from '../../../src/core/errors.js';

const base = {
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
};

describe('loadConfig', () => {
  it('applies read-allowed / write-denied defaults', () => {
    const cfg = loadConfig({ ...base });
    const acc = cfg.accounts[0]!;
    expect(acc.capabilities.mailRead).toBe(true);
    expect(acc.capabilities.mailWrite).toBe(false);
    expect(acc.capabilities.calendarRead).toBe(true);
    expect(acc.capabilities.calendarWrite).toBe(false);
  });

  it('defaults sender and label to the account email', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.accounts[0]!.sender).toBe('me@icloud.com');
    expect(cfg.accounts[0]!.label).toBe('me@icloud.com');
  });

  it('keeps sender distinct when configured', () => {
    const cfg = loadConfig({ ...base, ICLOUD_SENDER_1: 'alias@icloud.com', ICLOUD_LABEL_1: 'personal' });
    expect(cfg.accounts[0]!.email).toBe('me@icloud.com');
    expect(cfg.accounts[0]!.sender).toBe('alias@icloud.com');
    expect(cfg.accounts[0]!.label).toBe('personal');
  });

  it('parses accounts 2..5 without any enable flag', () => {
    const cfg = loadConfig({
      ...base,
      ICLOUD_ACCOUNT_3: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_3: 'wxyz-wxyz-wxyz-wxyz',
    });
    expect(cfg.accounts.map((a) => a.email)).toEqual(['me@icloud.com', 'work@icloud.com']);
    expect(cfg.accounts[1]!.id).toBe('account_3');
  });

  it('strips surrounding whitespace but preserves inner characters', () => {
    const cfg = loadConfig({ ...base, ICLOUD_APP_PASSWORD_1: '  abcd-efgh-ijkl-mnop' });
    expect(cfg.accounts[0]!.appPassword).toBe('abcd-efgh-ijkl-mnop');
  });

  it('maps legacy lowercase names and records a deprecation', () => {
    const cfg = loadConfig({
      icloud_account: 'old@icloud.com',
      icloud_app_pass: 'abcd-efgh-ijkl-mnop',
      allow_mail_write: 'true',
    });
    expect(cfg.accounts[0]!.email).toBe('old@icloud.com');
    expect(cfg.accounts[0]!.capabilities.mailWrite).toBe(true);
    expect(cfg.deprecations.join(' ')).toContain('icloud_account');
  });

  it('rejects a password without an account', () => {
    expect(() => loadConfig({ ICLOUD_APP_PASSWORD_1: 'abcd' })).toThrowError(AppError);
  });

  it('rejects an empty configuration with an actionable hint', () => {
    try {
      loadConfig({});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('INVALID_INPUT');
      expect((e as AppError).hint).toContain('ICLOUD_ACCOUNT_1');
    }
  });

  it('rejects a non-numeric session TTL', () => {
    expect(() => loadConfig({ ...base, SESSION_TTL_MINUTES: 'soon' })).toThrowError(AppError);
  });

  it('rejects an unrecognised boolean', () => {
    expect(() => loadConfig({ ...base, ALLOW_MAIL_WRITE_1: 'maybe' })).toThrowError(AppError);
  });
});

describe('findAccount', () => {
  it('returns the only account when no email is given', () => {
    const cfg = loadConfig({ ...base });
    expect(findAccount(cfg).email).toBe('me@icloud.com');
  });

  it('requires an explicit email when several accounts exist', () => {
    const cfg = loadConfig({
      ...base,
      ICLOUD_ACCOUNT_2: 'work@icloud.com',
      ICLOUD_APP_PASSWORD_2: 'abcd-efgh-ijkl-mnop',
    });
    expect(() => findAccount(cfg)).toThrowError(AppError);
    expect(findAccount(cfg, 'work@icloud.com').id).toBe('account_2');
  });

  it('lists configured accounts when the email is unknown', () => {
    const cfg = loadConfig({ ...base });
    try {
      findAccount(cfg, 'nobody@icloud.com');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('NOT_FOUND');
      expect((e as AppError).hint).toContain('me@icloud.com');
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/core/config.test.ts`
Expected: FAIL，无法解析 `src/core/config.js`

- [ ] **Step 3: 实现 `src/core/config.ts`**

```ts
import { z } from 'zod';
import { AppError } from './errors.js';
import type { LogLevel } from './logger.js';

export interface Capabilities {
  mailRead: boolean;
  mailWrite: boolean;
  calendarRead: boolean;
  calendarWrite: boolean;
  remindersRead: boolean;
  remindersWrite: boolean;
  contactsRead: boolean;
  contactsWrite: boolean;
}

export interface AccountConfig {
  id: string;
  email: string;
  sender: string;
  label: string;
  appPassword: string;
  capabilities: Capabilities;
}

export interface AppConfig {
  accounts: AccountConfig[];
  sessionTtlMs: number;
  imapIdleTimeoutMs: number;
  logLevel: LogLevel;
  deprecations: string[];
}

/** 旧的小写变量名 → 新命名。命中即记一条弃用提示。 */
const LEGACY_MAP: Record<string, string> = {
  icloud_account: 'ICLOUD_ACCOUNT_1',
  icloud_app_pass: 'ICLOUD_APP_PASSWORD_1',
  icloud_sender: 'ICLOUD_SENDER_1',
  allow_mail_read: 'ALLOW_MAIL_READ_1',
  allow_mail_write: 'ALLOW_MAIL_WRITE_1',
  allow_calendar_read: 'ALLOW_CALENDAR_READ_1',
  allow_calendar_write: 'ALLOW_CALENDAR_WRITE_1',
};

const emailSchema = z.email();
const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);

function clean(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = clean(env[key]);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
  if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  throw new AppError('INVALID_INPUT', `环境变量 ${key} 的值无法识别：${raw}`, {
    hint: '只接受 true/false（或 1/0、yes/no）',
  });
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = clean(env[key]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('INVALID_INPUT', `环境变量 ${key} 必须是正整数，实际是：${raw}`);
  }
  return Math.floor(value);
}

function applyLegacy(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; deprecations: string[] } {
  const merged: NodeJS.ProcessEnv = { ...env };
  const deprecations: string[] = [];
  for (const [oldKey, newKey] of Object.entries(LEGACY_MAP)) {
    const value = env[oldKey];
    if (value !== undefined && merged[newKey] === undefined) {
      merged[newKey] = value;
      deprecations.push(`环境变量 ${oldKey} 已弃用，请改用 ${newKey}`);
    }
  }
  return { env: merged, deprecations };
}

function parseAccount(env: NodeJS.ProcessEnv, index: number): AccountConfig | undefined {
  const suffix = `_${index}`;
  const email = clean(env[`ICLOUD_ACCOUNT${suffix}`]);
  const appPassword = clean(env[`ICLOUD_APP_PASSWORD${suffix}`]);

  if (email === undefined && appPassword === undefined) return undefined;
  if (email === undefined) {
    throw new AppError('INVALID_INPUT', `配置了 ICLOUD_APP_PASSWORD${suffix} 却没有 ICLOUD_ACCOUNT${suffix}`);
  }
  if (appPassword === undefined) {
    throw new AppError('INVALID_INPUT', `配置了 ICLOUD_ACCOUNT${suffix} 却没有 ICLOUD_APP_PASSWORD${suffix}`, {
      hint: '在 https://appleid.apple.com 生成 App 专用密码',
    });
  }
  if (!emailSchema.safeParse(email).success) {
    throw new AppError('INVALID_INPUT', `ICLOUD_ACCOUNT${suffix} 不是合法邮箱：${email}`);
  }

  return {
    id: `account${suffix}`,
    email,
    sender: clean(env[`ICLOUD_SENDER${suffix}`]) ?? email,
    label: clean(env[`ICLOUD_LABEL${suffix}`]) ?? email,
    appPassword,
    capabilities: {
      mailRead: readBool(env, `ALLOW_MAIL_READ${suffix}`, true),
      mailWrite: readBool(env, `ALLOW_MAIL_WRITE${suffix}`, false),
      calendarRead: readBool(env, `ALLOW_CALENDAR_READ${suffix}`, true),
      calendarWrite: readBool(env, `ALLOW_CALENDAR_WRITE${suffix}`, false),
      remindersRead: readBool(env, `ALLOW_REMINDERS_READ${suffix}`, true),
      remindersWrite: readBool(env, `ALLOW_REMINDERS_WRITE${suffix}`, false),
      contactsRead: readBool(env, `ALLOW_CONTACTS_READ${suffix}`, true),
      contactsWrite: readBool(env, `ALLOW_CONTACTS_WRITE${suffix}`, false),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const { env: merged, deprecations } = applyLegacy(env);

  const accounts: AccountConfig[] = [];
  for (let i = 1; i <= 5; i++) {
    const account = parseAccount(merged, i);
    if (account) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new AppError('INVALID_INPUT', '没有配置任何 iCloud 账号', {
      hint: '至少设置 ICLOUD_ACCOUNT_1 与 ICLOUD_APP_PASSWORD_1，可参考仓库根目录的 .env.example',
    });
  }

  const rawLevel = clean(merged.LOG_LEVEL) ?? 'info';
  const level = logLevelSchema.safeParse(rawLevel);
  if (!level.success) {
    throw new AppError('INVALID_INPUT', `LOG_LEVEL 不合法：${rawLevel}`, {
      hint: '可选值：error / warn / info / debug',
    });
  }

  return {
    accounts,
    sessionTtlMs: readInt(merged, 'SESSION_TTL_MINUTES', 30) * 60_000,
    imapIdleTimeoutMs: readInt(merged, 'IMAP_IDLE_TIMEOUT_SECONDS', 300) * 1000,
    logLevel: level.data,
    deprecations,
  };
}

export function findAccount(config: AppConfig, email?: string): AccountConfig {
  if (email === undefined) {
    const only = config.accounts[0];
    if (config.accounts.length === 1 && only) return only;
    throw new AppError('INVALID_INPUT', '配置了多个账号，必须指定 account', {
      hint: `可用账号：${config.accounts.map((a) => a.email).join('、')}`,
    });
  }
  const found = config.accounts.find((a) => a.email === email || a.sender === email);
  if (!found) {
    throw new AppError('NOT_FOUND', `未配置账号 ${email}`, {
      hint: `已配置的账号：${config.accounts.map((a) => a.email).join('、')}`,
    });
  }
  return found;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/core/config.test.ts && npx tsc --noEmit`
Expected: 13 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/config.ts tests/unit/core/config.test.ts
git commit -m "feat(core): add validated config loader with legacy env mapping"
```

---

### Task 5: 不透明资源 ID

日历事件对模型只暴露一个不透明字符串。etag 刻意不进 ID —— 它随每次修改变化，编码进去必然过期。

**Files:**
- Create: `src/core/ids.ts`
- Test: `tests/unit/core/ids.test.ts`

**Interfaces:**
- Consumes: `AppError` (Task 2)
- Produces:
  - `interface ResourceRef { collectionUrl: string; resourceUrl: string }`
  - `function encodeRef(ref: ResourceRef): string`
  - `function decodeRef(id: string): ResourceRef`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { encodeRef, decodeRef } from '../../../src/core/ids.js';
import { AppError } from '../../../src/core/errors.js';

describe('resource refs', () => {
  const ref = {
    collectionUrl: 'https://p01-caldav.icloud.com/12345/calendars/home/',
    resourceUrl: 'https://p01-caldav.icloud.com/12345/calendars/home/ABC-123.ics',
  };

  it('round-trips a reference', () => {
    expect(decodeRef(encodeRef(ref))).toEqual(ref);
  });

  it('produces a URL-safe token without padding', () => {
    expect(encodeRef(ref)).not.toMatch(/[+/=]/);
  });

  it('rejects a malformed id', () => {
    expect(() => decodeRef('not-a-real-id')).toThrowError(AppError);
  });

  it('rejects an id missing the separator', () => {
    const bad = Buffer.from('https://example.com/only-one-part').toString('base64url');
    expect(() => decodeRef(bad)).toThrowError(AppError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/core/ids.test.ts`
Expected: FAIL，无法解析 `src/core/ids.js`

- [ ] **Step 3: 实现 `src/core/ids.ts`**

```ts
import { AppError } from './errors.js';

export interface ResourceRef {
  collectionUrl: string;
  resourceUrl: string;
}

const SEPARATOR = '|';

const MALFORMED_HINT = '请使用列表类工具返回的 id 原值，不要自行构造或截断';

export function encodeRef(ref: ResourceRef): string {
  return Buffer.from(`${ref.collectionUrl}${SEPARATOR}${ref.resourceUrl}`, 'utf8').toString('base64url');
}

export function decodeRef(id: string): ResourceRef {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const index = decoded.indexOf(SEPARATOR);
  if (index <= 0 || index === decoded.length - 1) {
    throw new AppError('INVALID_INPUT', '资源 ID 格式不正确', { hint: MALFORMED_HINT });
  }

  const collectionUrl = decoded.slice(0, index);
  const resourceUrl = decoded.slice(index + 1);
  if (!collectionUrl.startsWith('http') || !resourceUrl.startsWith('http')) {
    throw new AppError('INVALID_INPUT', '资源 ID 格式不正确', { hint: MALFORMED_HINT });
  }

  return { collectionUrl, resourceUrl };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/core/ids.test.ts && npx tsc --noEmit`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/ids.ts tests/unit/core/ids.test.ts
git commit -m "feat(core): add opaque resource id encoding"
```

---
### Task 6: MIME 解析

旧实现最大的坑：返回原始 header 与未解码 TEXT 段，导致中文乱码。这个任务是整个阶段一测试密度最高的地方。

**Files:**
- Create: `src/parsers/mime.ts`
- Create: `tests/fixtures/mail/chinese-base64.eml`
- Create: `tests/fixtures/mail/multipart-qp.eml`
- Test: `tests/unit/parsers/mime.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface EmailAddress { name?: string; address: string }`
  - `interface AttachmentInfo { filename: string; contentType: string; size: number }`
  - `interface ParsedEmail { messageId?: string; date?: string; from?: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; subject: string; text: string; html?: string; attachments: AttachmentInfo[]; inReplyTo?: string; references: string[] }`
  - `function parseEmail(source: Buffer | string): Promise<ParsedEmail>`
  - `function htmlToText(html: string): string`
  - `function makeSnippet(text: string, maxLength?: number): string`

- [ ] **Step 1: 创建 fixture `tests/fixtures/mail/chinese-base64.eml`**

主题与正文都是 UTF-8 base64 编码，主题解码后为 `测试邮件：中文主题`，正文解码后为 `你好，这是一封测试邮件。\r\n第二行。\r\n`。

```
From: =?UTF-8?B?5rWL6K+V?= <sender@icloud.com>
To: me@icloud.com
Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu277ya5Lit5paH5Li76aKY?=
Date: Mon, 17 Aug 2026 10:30:00 +0800
Message-ID: <abc123@icloud.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: base64

5L2g5aW977yM6L+Z5piv5LiA5bCB5rWL6K+V6YKu5Lu244CCDQrnrKzkuozooYzjgIINCg==
```

- [ ] **Step 2: 创建 fixture `tests/fixtures/mail/multipart-qp.eml`**

multipart/alternative：纯文本部分用 quoted-printable 编码的中文，HTML 部分带标签与实体。

```
From: Sender <sender@icloud.com>
To: me@icloud.com
Subject: =?UTF-8?Q?=E5=A4=9A=E9=83=A8=E5=88=86=E9=82=AE=E4=BB=B6?=
Date: Tue, 18 Aug 2026 09:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="BOUNDARY42"

--BOUNDARY42
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

=E7=BA=AF=E6=96=87=E6=9C=AC=E9=83=A8=E5=88=86
--BOUNDARY42
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

<html><body><p>=E7=AC=AC=E4=B8=80=E6=AE=B5</p><p>Second &amp; last</p></body=
></html>
--BOUNDARY42--
```

- [ ] **Step 3: 写失败测试 `tests/unit/parsers/mime.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEmail, htmlToText, makeSnippet } from '../../../src/parsers/mime.js';

const fixture = (name: string): Buffer =>
  readFileSync(join(process.cwd(), 'tests/fixtures/mail', name));

describe('parseEmail', () => {
  it('decodes an RFC 2047 encoded Chinese subject', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.subject).toBe('测试邮件：中文主题');
  });

  it('decodes a base64 Chinese body', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.text).toContain('你好，这是一封测试邮件。');
    expect(mail.text).toContain('第二行。');
  });

  it('decodes the display name and address of the sender', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.from).toEqual({ name: '测试', address: 'sender@icloud.com' });
  });

  it('normalises the date to an ISO string', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.date).toBe(new Date('2026-08-17T02:30:00.000Z').toISOString());
  });

  it('decodes quoted-printable text from a multipart message', async () => {
    const mail = await parseEmail(fixture('multipart-qp.eml'));
    expect(mail.subject).toBe('多部分邮件');
    expect(mail.text).toContain('纯文本部分');
  });

  it('keeps the html part available separately', async () => {
    const mail = await parseEmail(fixture('multipart-qp.eml'));
    expect(mail.html).toContain('第一段');
  });

  it('reports no attachments for a plain message', async () => {
    const mail = await parseEmail(fixture('chinese-base64.eml'));
    expect(mail.attachments).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('turns block elements into line breaks and decodes entities', () => {
    const out = htmlToText('<p>第一段</p><p>Second &amp; last</p>');
    expect(out).toBe('第一段\nSecond & last');
  });

  it('keeps link targets alongside the link text', () => {
    expect(htmlToText('<a href="https://example.com">点这里</a>')).toBe('点这里 (https://example.com)');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>正文</p><script>alert(1)</script>')).toBe('正文');
  });
});

describe('makeSnippet', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(makeSnippet('第一行\n\n  第二行  ', 6)).toBe('第一行 第二…');
  });

  it('leaves short text untouched', () => {
    expect(makeSnippet('短', 200)).toBe('短');
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run tests/unit/parsers/mime.test.ts`
Expected: FAIL，无法解析 `src/parsers/mime.js`

- [ ] **Step 5: 实现 `src/parsers/mime.ts`**

```ts
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  size: number;
}

export interface ParsedEmail {
  messageId?: string;
  date?: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  attachments: AttachmentInfo[];
  inReplyTo?: string;
  references: string[];
}

function toAddresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: EmailAddress[] = [];
  for (const group of list) {
    for (const entry of group.value) {
      if (!entry.address) continue;
      const address: EmailAddress = { address: entry.address };
      if (entry.name) address.name = entry.name;
      out.push(address);
    }
  }
  return out;
}

const BLOCK_TAG = /<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi;
const BREAK_TAG = /<br\s*\/?>/gi;
const DROPPED_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const LINK_TAG = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const ANY_TAG = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function decodeEntities(input: string): string {
  let out = input.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out;
}

/** HTML 转可读纯文本：保留段落结构与链接目标，丢弃脚本样式。 */
export function htmlToText(html: string): string {
  const withLinks = html
    .replace(DROPPED_BLOCK, '')
    .replace(LINK_TAG, (_, href: string, label: string) => `${label.trim()} (${href})`);

  const withBreaks = withLinks.replace(BREAK_TAG, '\n').replace(BLOCK_TAG, '\n');

  return decodeEntities(withBreaks.replace(ANY_TAG, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** 供搜索结果使用的正文预览。 */
export function makeSnippet(text: string, maxLength = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength) + '…';
}

export async function parseEmail(source: Buffer | string): Promise<ParsedEmail> {
  const parsed: ParsedMail = await simpleParser(source);

  const from = toAddresses(parsed.from)[0];
  const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '');

  const result: ParsedEmail = {
    to: toAddresses(parsed.to),
    cc: toAddresses(parsed.cc),
    subject: parsed.subject ?? '',
    text: text.trim(),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'unnamed',
      contentType: a.contentType,
      size: a.size,
    })),
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [],
  };

  if (parsed.messageId) result.messageId = parsed.messageId;
  if (parsed.date) result.date = parsed.date.toISOString();
  if (from) result.from = from;
  if (typeof parsed.html === 'string') result.html = parsed.html;
  if (parsed.inReplyTo) result.inReplyTo = parsed.inReplyTo;

  return result;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/unit/parsers/mime.test.ts && npx tsc --noEmit`
Expected: 12 passed

- [ ] **Step 7: 提交**

```bash
git add src/parsers/mime.ts tests/unit/parsers/mime.test.ts tests/fixtures/mail
git commit -m "feat(parsers): decode MIME messages server-side"
```

---

### Task 7: iCal 解析与生成

模型永远不接触 iCal 文本。这一层负责双向转换，含 RRULE 结构化互转、全天事件、时区与重复展开。

**Files:**
- Create: `src/parsers/ical.ts`
- Create: `tests/fixtures/calendar/timed-shanghai.ics`
- Create: `tests/fixtures/calendar/all-day.ics`
- Create: `tests/fixtures/calendar/weekly-with-exdate.ics`
- Create: `tests/fixtures/calendar/dst-newyork.ics`
- Test: `tests/unit/parsers/ical.test.ts`

**Interfaces:**
- Consumes: `encodeRef` / `ResourceRef` (Task 5)、`AppError` (Task 2)
- Produces:
  - `interface RecurrenceRule { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY'; interval?: number; count?: number; until?: string; byday?: string[]; bymonthday?: number[] }`
  - `interface AlarmSpec { minutes_before: number; action: 'display' | 'email' }`
  - `interface Attendee { email: string; name?: string; status?: string }`
  - `interface CalendarEvent { event_id: string; series_id: string; recurrence_id?: string; title: string; start: string; end: string; all_day: boolean; timezone?: string; location?: string; description?: string; url?: string; attendees: Attendee[]; recurrence?: RecurrenceRule; alarms: AlarmSpec[] }`
  - `interface EventInput { title: string; start: string; end: string; all_day?: boolean; timezone?: string; location?: string; description?: string; url?: string; recurrence?: RecurrenceRule; alarms?: AlarmSpec[] }`
  - `function parseCalendarObject(icsText: string, ref: ResourceRef, options?: { rangeStart?: Date; rangeEnd?: Date; expandRecurring?: boolean }): CalendarEvent[]`
  - `function buildCalendarObject(input: EventInput, existing?: { uid: string; sequence: number }): { ics: string; uid: string }`

- [ ] **Step 1: 创建四个 fixture**

`tests/fixtures/calendar/timed-shanghai.ics` —— 带 VTIMEZONE 的定时事件，本地时间 2026-08-17 14:00 Asia/Shanghai（= 06:00 UTC）：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:Asia/Shanghai
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0800
TZOFFSETTO:+0800
TZNAME:CST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:timed-001
DTSTAMP:20260810T000000Z
DTSTART;TZID=Asia/Shanghai:20260817T140000
DTEND;TZID=Asia/Shanghai:20260817T150000
SUMMARY:项目评审
LOCATION:会议室 A
DESCRIPTION:讨论重构方案
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:提醒
END:VALARM
END:VEVENT
END:VCALENDAR
```

`tests/fixtures/calendar/all-day.ics` —— 全天事件（DTEND 是排他的次日）：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:allday-001
DTSTAMP:20260810T000000Z
DTSTART;VALUE=DATE:20260901
DTEND;VALUE=DATE:20260902
SUMMARY:全天活动
END:VEVENT
END:VCALENDAR
```

`tests/fixtures/calendar/weekly-with-exdate.ics` —— 每周一 09:00 UTC，共 4 次，排除第二次：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:weekly-001
DTSTAMP:20260801T000000Z
DTSTART:20260803T090000Z
DTEND:20260803T093000Z
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
EXDATE:20260810T090000Z
SUMMARY:周会
END:VEVENT
END:VCALENDAR
```

`tests/fixtures/calendar/dst-newyork.ics` —— 跨美国夏令时切换（2026-11-01 回拨）的每周事件，本地固定 09:00，UTC 时刻会从 13:00 变成 14:00：

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:dst-001
DTSTAMP:20261001T000000Z
DTSTART;TZID=America/New_York:20261026T090000
DTEND;TZID=America/New_York:20261026T100000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
SUMMARY:Standup
END:VEVENT
END:VCALENDAR
```

- [ ] **Step 2: 写失败测试 `tests/unit/parsers/ical.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCalendarObject, buildCalendarObject } from '../../../src/parsers/ical.js';

const ref = {
  collectionUrl: 'https://caldav.icloud.com/1/calendars/home/',
  resourceUrl: 'https://caldav.icloud.com/1/calendars/home/x.ics',
};

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/calendar', name), 'utf8');

describe('parseCalendarObject', () => {
  it('resolves a TZID-qualified start time to the correct instant', () => {
    const [event] = parseCalendarObject(fixture('timed-shanghai.ics'), ref);
    expect(event!.start).toBe('2026-08-17T06:00:00.000Z');
    expect(event!.end).toBe('2026-08-17T07:00:00.000Z');
    expect(event!.all_day).toBe(false);
    expect(event!.timezone).toBe('Asia/Shanghai');
  });

  it('extracts title, location, description and alarms', () => {
    const [event] = parseCalendarObject(fixture('timed-shanghai.ics'), ref);
    expect(event!.title).toBe('项目评审');
    expect(event!.location).toBe('会议室 A');
    expect(event!.description).toBe('讨论重构方案');
    expect(event!.alarms).toEqual([{ minutes_before: 15, action: 'display' }]);
  });

  it('marks a DATE-valued event as all day', () => {
    const [event] = parseCalendarObject(fixture('all-day.ics'), ref);
    expect(event!.all_day).toBe(true);
    expect(event!.start.slice(0, 10)).toBe('2026-09-01');
  });

  it('returns the unexpanded series when expandRecurring is false', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      expandRecurring: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.recurrence).toEqual({ freq: 'WEEKLY', count: 4, byday: ['MO'] });
    expect(events[0]!.recurrence_id).toBeUndefined();
  });

  it('expands occurrences within the range and honours EXDATE', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    expect(events.map((e) => e.start)).toEqual([
      '2026-08-03T09:00:00.000Z',
      '2026-08-17T09:00:00.000Z',
      '2026-08-24T09:00:00.000Z',
    ]);
    expect(events.every((e) => e.series_id === 'weekly-001')).toBe(true);
    expect(events[1]!.recurrence_id).toBe('2026-08-17T09:00:00.000Z');
  });

  it('clips expansion to the requested range', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      rangeStart: new Date('2026-08-16T00:00:00Z'),
      rangeEnd: new Date('2026-08-20T00:00:00Z'),
      expandRecurring: true,
    });
    expect(events.map((e) => e.start)).toEqual(['2026-08-17T09:00:00.000Z']);
  });

  it('keeps the local wall-clock time across a DST transition', () => {
    const events = parseCalendarObject(fixture('dst-newyork.ics'), ref, {
      rangeStart: new Date('2026-10-01T00:00:00Z'),
      rangeEnd: new Date('2026-12-01T00:00:00Z'),
      expandRecurring: true,
    });
    // 本地时间都是 09:00，但 11 月 1 日回拨后 UTC 时刻要晚一小时
    expect(events.map((e) => e.start)).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-09T14:00:00.000Z',
    ]);
  });

  it('gives every event the same opaque id derived from its ref', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    const ids = new Set(events.map((e) => e.event_id));
    expect(ids.size).toBe(1);
  });
});

describe('buildCalendarObject', () => {
  it('produces a parseable VEVENT with UTC timestamps', () => {
    const { ics, uid } = buildCalendarObject({
      title: '新会议',
      start: '2026-09-10T02:00:00.000Z',
      end: '2026-09-10T03:00:00.000Z',
    });
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:新会议');
    expect(ics).toContain('DTSTART:20260910T020000Z');
    expect(uid).toMatch(/.+/);

    const [parsed] = parseCalendarObject(ics, ref);
    expect(parsed!.start).toBe('2026-09-10T02:00:00.000Z');
    expect(parsed!.title).toBe('新会议');
  });

  it('writes all-day events as DATE values', () => {
    const { ics } = buildCalendarObject({
      title: '休假',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
      all_day: true,
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260901');
  });

  it('serialises a structured recurrence rule', () => {
    const { ics } = buildCalendarObject({
      title: '周会',
      start: '2026-09-07T09:00:00.000Z',
      end: '2026-09-07T09:30:00.000Z',
      recurrence: { freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'] },
    });
    expect(ics).toMatch(/RRULE:.*FREQ=WEEKLY/);
    expect(ics).toMatch(/RRULE:.*INTERVAL=2/);
    expect(ics).toMatch(/RRULE:.*BYDAY=MO,WE/);
  });

  it('serialises alarms as relative triggers', () => {
    const { ics } = buildCalendarObject({
      title: '提醒测试',
      start: '2026-09-07T09:00:00.000Z',
      end: '2026-09-07T09:30:00.000Z',
      alarms: [{ minutes_before: 30, action: 'display' }],
    });
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT30M');
  });

  it('keeps the uid and bumps the sequence when updating', () => {
    const { ics, uid } = buildCalendarObject(
      { title: '改过的会议', start: '2026-09-10T02:00:00.000Z', end: '2026-09-10T03:00:00.000Z' },
      { uid: 'existing-uid', sequence: 2 },
    );
    expect(uid).toBe('existing-uid');
    expect(ics).toContain('UID:existing-uid');
    expect(ics).toContain('SEQUENCE:3');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/unit/parsers/ical.test.ts`
Expected: FAIL，无法解析 `src/parsers/ical.js`

- [ ] **Step 4: 实现 `src/parsers/ical.ts`**

```ts
import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';
import { encodeRef, type ResourceRef } from '../core/ids.js';

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number;
  count?: number;
  until?: string;
  byday?: string[];
  bymonthday?: number[];
}

export interface AlarmSpec {
  minutes_before: number;
  action: 'display' | 'email';
}

export interface Attendee {
  email: string;
  name?: string;
  status?: string;
}

export interface CalendarEvent {
  event_id: string;
  series_id: string;
  recurrence_id?: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  url?: string;
  attendees: Attendee[];
  recurrence?: RecurrenceRule;
  alarms: AlarmSpec[];
}

export interface EventInput {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  url?: string;
  recurrence?: RecurrenceRule;
  alarms?: AlarmSpec[];
}

export interface ParseOptions {
  rangeStart?: Date;
  rangeEnd?: Date;
  expandRecurring?: boolean;
}

const MAX_OCCURRENCES = 500;
const PRODID = '-//apple-icloud-mcp//EN';

function parseRoot(icsText: string): ICAL.Component {
  try {
    return new ICAL.Component(ICAL.parse(icsText));
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', '日历数据解析失败', { cause });
  }
}

/** iCloud 下发的 VTIMEZONE 必须先注册，TZID 才能解析成正确的瞬时时间。 */
function registerTimezones(root: ICAL.Component): void {
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtimezone.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || ICAL.TimezoneService.has(tzid)) continue;
    ICAL.TimezoneService.register(tzid, new ICAL.Timezone(vtimezone));
  }
}

function recurrenceFromEvent(vevent: ICAL.Component): RecurrenceRule | undefined {
  const raw = vevent.getFirstPropertyValue('rrule');
  if (!raw) return undefined;
  const recur = raw as ICAL.Recur;
  const rule: RecurrenceRule = { freq: recur.freq as RecurrenceRule['freq'] };
  if (recur.interval && recur.interval > 1) rule.interval = recur.interval;
  if (recur.count) rule.count = recur.count;
  if (recur.until) rule.until = recur.until.toJSDate().toISOString();

  const parts = recur.parts as Record<string, unknown> | undefined;
  const byday = parts?.BYDAY;
  if (Array.isArray(byday) && byday.length > 0) rule.byday = byday.map(String);
  const bymonthday = parts?.BYMONTHDAY;
  if (Array.isArray(bymonthday) && bymonthday.length > 0) {
    rule.bymonthday = bymonthday.map(Number);
  }
  return rule;
}

function alarmsFromEvent(vevent: ICAL.Component): AlarmSpec[] {
  const alarms: AlarmSpec[] = [];
  for (const valarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = valarm.getFirstPropertyValue('trigger');
    if (!trigger || typeof trigger === 'string') continue;
    const duration = trigger as ICAL.Duration;
    const minutes = Math.round(Math.abs(duration.toSeconds()) / 60);
    const rawAction = valarm.getFirstPropertyValue('action');
    const action = String(rawAction ?? 'DISPLAY').toUpperCase() === 'EMAIL' ? 'email' : 'display';
    alarms.push({ minutes_before: minutes, action });
  }
  return alarms;
}

function attendeesFromEvent(vevent: ICAL.Component): Attendee[] {
  const out: Attendee[] = [];
  for (const property of vevent.getAllProperties('attendee')) {
    const value = String(property.getFirstValue() ?? '');
    const email = value.replace(/^mailto:/i, '');
    if (!email) continue;
    const attendee: Attendee = { email };
    const name = property.getParameter('cn');
    if (typeof name === 'string') attendee.name = name;
    const status = property.getParameter('partstat');
    if (typeof status === 'string') attendee.status = status;
    out.push(attendee);
  }
  return out;
}

function timezoneOf(vevent: ICAL.Component): string | undefined {
  const dtstart = vevent.getFirstProperty('dtstart');
  const tzid = dtstart?.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : undefined;
}

function baseEvent(vevent: ICAL.Component, ref: ResourceRef): Omit<CalendarEvent, 'start' | 'end'> {
  const event = new ICAL.Event(vevent);
  const result: Omit<CalendarEvent, 'start' | 'end'> = {
    event_id: encodeRef(ref),
    series_id: event.uid,
    title: event.summary ?? '',
    all_day: event.startDate.isDate,
    attendees: attendeesFromEvent(vevent),
    alarms: alarmsFromEvent(vevent),
  };

  const tz = timezoneOf(vevent);
  if (tz) result.timezone = tz;
  if (event.location) result.location = event.location;
  if (event.description) result.description = event.description;

  const url = vevent.getFirstPropertyValue('url');
  if (typeof url === 'string' && url) result.url = url;

  const recurrence = recurrenceFromEvent(vevent);
  if (recurrence) result.recurrence = recurrence;

  return result;
}

export function parseCalendarObject(
  icsText: string,
  ref: ResourceRef,
  options: ParseOptions = {},
): CalendarEvent[] {
  const root = parseRoot(icsText);
  registerTimezones(root);

  const vevents = root.getAllSubcomponents('vevent');
  const master = vevents.find((c) => !c.hasProperty('recurrence-id'));
  if (!master) return [];

  const event = new ICAL.Event(master);
  for (const exception of vevents) {
    if (exception === master) continue;
    event.relateException(new ICAL.Event(exception));
  }

  const template = baseEvent(master, ref);

  if (!options.expandRecurring || !event.isRecurring()) {
    return [
      {
        ...template,
        start: event.startDate.toJSDate().toISOString(),
        end: event.endDate.toJSDate().toISOString(),
      },
    ];
  }

  const rangeStart = options.rangeStart ?? event.startDate.toJSDate();
  const rangeEnd = options.rangeEnd;
  const iterator = event.iterator(ICAL.Time.fromJSDate(rangeStart, true));

  const occurrences: CalendarEvent[] = [];
  let next = iterator.next();
  while (next && occurrences.length < MAX_OCCURRENCES) {
    const startsAt = next.toJSDate();
    if (rangeEnd && startsAt >= rangeEnd) break;

    if (startsAt >= rangeStart) {
      const details = event.getOccurrenceDetails(next);
      occurrences.push({
        ...template,
        title: details.item.summary ?? template.title,
        recurrence_id: details.startDate.toJSDate().toISOString(),
        start: details.startDate.toJSDate().toISOString(),
        end: details.endDate.toJSDate().toISOString(),
      });
    }
    next = iterator.next();
  }

  return occurrences;
}

function toIcalTime(iso: string, allDay: boolean): ICAL.Time {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('INVALID_INPUT', `时间格式不正确：${iso}`, {
      hint: '请使用 ISO 8601 格式，例如 2026-09-10T14:00:00+08:00',
    });
  }
  const time = ICAL.Time.fromJSDate(date, true);
  if (allDay) {
    return ICAL.Time.fromData({
      year: time.year,
      month: time.month,
      day: time.day,
      isDate: true,
    });
  }
  return time;
}

function recurrenceToString(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const until = ICAL.Time.fromJSDate(new Date(rule.until), true);
    parts.push(`UNTIL=${until.toICALString()}`);
  }
  if (rule.byday && rule.byday.length > 0) parts.push(`BYDAY=${rule.byday.join(',')}`);
  if (rule.bymonthday && rule.bymonthday.length > 0) {
    parts.push(`BYMONTHDAY=${rule.bymonthday.join(',')}`);
  }
  return parts.join(';');
}

export function buildCalendarObject(
  input: EventInput,
  existing?: { uid: string; sequence: number },
): { ics: string; uid: string } {
  const uid = existing?.uid ?? randomUUID();
  const allDay = input.all_day === true;

  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);

  const vevent = new ICAL.Component(['vevent', [], []]);
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue('sequence', String((existing?.sequence ?? -1) + 1));
  vevent.addPropertyWithValue('summary', input.title);
  vevent.addPropertyWithValue('dtstart', toIcalTime(input.start, allDay));
  vevent.addPropertyWithValue('dtend', toIcalTime(input.end, allDay));

  if (input.location) vevent.addPropertyWithValue('location', input.location);
  if (input.description) vevent.addPropertyWithValue('description', input.description);
  if (input.url) vevent.addPropertyWithValue('url', input.url);
  if (input.recurrence) {
    vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(recurrenceToString(input.recurrence)));
  }

  for (const alarm of input.alarms ?? []) {
    const valarm = new ICAL.Component(['valarm', [], []]);
    valarm.addPropertyWithValue('action', alarm.action === 'email' ? 'EMAIL' : 'DISPLAY');
    valarm.addPropertyWithValue('description', input.title);
    valarm.addPropertyWithValue(
      'trigger',
      ICAL.Duration.fromSeconds(-Math.abs(alarm.minutes_before) * 60),
    );
    vevent.addSubcomponent(valarm);
  }

  calendar.addSubcomponent(vevent);
  return { ics: calendar.toString(), uid };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/unit/parsers/ical.test.ts && npx tsc --noEmit`
Expected: 13 passed。若 `ical.js` 的类型声明与 `ICAL.Recur.parts` 等成员不完全匹配，在该处使用局部 `as` 断言收窄，**不要**给整个模块加 `any`。

- [ ] **Step 6: 提交**

```bash
git add src/parsers/ical.ts tests/unit/parsers/ical.test.ts tests/fixtures/calendar
git commit -m "feat(parsers): translate between iCal and structured events"
```

---

### Task 8: IMAP Provider

provider 只负责连接与原始收发，且必须把上游异常映射成 `AppError`。接口是 service 层测试的替换点。

**Files:**
- Create: `src/providers/icloud/imap.ts`
- Test: `tests/unit/providers/imap.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` (Task 4)、`AppError` (Task 2)
- Produces:
  - `interface FolderInfo { path: string; name: string; specialUse?: string; total: number; unseen: number }`
  - `interface RawMessage { uid: number; date: Date; flags: string[]; source: Buffer }`
  - `interface SearchCriteria { from?: string; to?: string; subject?: string; text?: string; since?: Date; before?: Date; unseen?: boolean; flagged?: boolean }`
  - `interface ImapProvider { verify(): Promise<void>; listFolders(): Promise<FolderInfo[]>; searchUids(folder: string, criteria: SearchCriteria): Promise<number[]>; fetchMessages(folder: string, uids: number[]): Promise<RawMessage[]>; setFlags(folder: string, uids: number[], flags: string[], add: boolean): Promise<void>; moveMessages(folder: string, uids: number[], target: string): Promise<void>; expunge(folder: string, uids: number[]): Promise<void>; close(): Promise<void> }`
  - `function mapImapError(err: unknown): AppError`
  - `function createImapProvider(account: AccountConfig): ImapProvider`

- [ ] **Step 1: 写失败测试（只测纯函数部分，不连网络）**

```ts
import { describe, it, expect } from 'vitest';
import { mapImapError } from '../../../src/providers/icloud/imap.js';
import { AppError } from '../../../src/core/errors.js';

describe('mapImapError', () => {
  it('maps authentication failures to AUTH_FAILED with an actionable hint', () => {
    const mapped = mapImapError(Object.assign(new Error('Invalid credentials'), {
      authenticationFailed: true,
    }));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.retryable).toBe(false);
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps network errors to a retryable UPSTREAM_ERROR', () => {
    const mapped = mapImapError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a missing mailbox to NOT_FOUND', () => {
    const mapped = mapImapError(new Error('Mailbox does not exist'));
    expect(mapped.code).toBe('NOT_FOUND');
  });

  it('never leaks the original message for unknown failures', () => {
    const mapped = mapImapError(new Error('LOGIN user pass=abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/providers/imap.test.ts`
Expected: FAIL，无法解析 `src/providers/icloud/imap.js`

- [ ] **Step 3: 实现 `src/providers/icloud/imap.ts`**

```ts
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';

const HOST = 'imap.mail.me.com';
const PORT = 993;

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  total: number;
  unseen: number;
}

export interface RawMessage {
  uid: number;
  date: Date;
  flags: string[];
  source: Buffer;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unseen?: boolean;
  flagged?: boolean;
}

export interface ImapProvider {
  verify(): Promise<void>;
  listFolders(): Promise<FolderInfo[]>;
  searchUids(folder: string, criteria: SearchCriteria): Promise<number[]>;
  fetchMessages(folder: string, uids: number[]): Promise<RawMessage[]>;
  setFlags(folder: string, uids: number[], flags: string[], add: boolean): Promise<void>;
  moveMessages(folder: string, uids: number[], target: string): Promise<void>;
  expunge(folder: string, uids: number[]): Promise<void>;
  close(): Promise<void>;
}

const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE']);

/** 上游异常一律在此收口。原始 message 只进 cause，不外泄（可能含凭据）。 */
export function mapImapError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const error = err as { code?: string; authenticationFailed?: boolean; message?: string };
  const message = error.message ?? '';

  if (error.authenticationFailed || /invalid credentials|authentication failed/i.test(message)) {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了这组凭据', {
      hint: '确认 App 专用密码未被吊销，且 Apple ID 已开启双重认证',
      cause: err,
    });
  }

  if (error.code && NETWORK_CODES.has(error.code)) {
    return new AppError('UPSTREAM_ERROR', '无法连接 iCloud 邮件服务器', { retryable: true, cause: err });
  }

  if (/mailbox does not exist|no such mailbox|nonexistent/i.test(message)) {
    return new AppError('NOT_FOUND', '指定的邮件文件夹不存在', {
      hint: '先调用 mail_folders 查看实际的文件夹路径',
      cause: err,
    });
  }

  if (/over quota|too many|rate/i.test(message)) {
    return new AppError('RATE_LIMITED', 'iCloud 暂时限制了请求频率', { retryable: true, cause: err });
  }

  return new AppError('UPSTREAM_ERROR', 'iCloud 邮件操作失败', { retryable: true, cause: err });
}

function buildOptions(account: AccountConfig): ImapFlowOptions {
  return {
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: account.sender, pass: account.appPassword },
    logger: false,
  };
}

function toImapQuery(criteria: SearchCriteria): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.text) query.body = criteria.text;
  if (criteria.since) query.since = criteria.since;
  if (criteria.before) query.before = criteria.before;
  if (criteria.unseen) query.seen = false;
  if (criteria.flagged) query.flagged = true;
  return Object.keys(query).length > 0 ? query : { all: true };
}

/**
 * IMAP 认证用 account.sender（iCloud 邮箱或别名），不是 account.email。
 * 这两者的混用是旧版本反复修过的 bug，改动此处务必确认。
 */
export function createImapProvider(account: AccountConfig): ImapProvider {
  let client: ImapFlow | undefined;

  const connect = async (): Promise<ImapFlow> => {
    if (client?.usable) return client;
    const next = new ImapFlow(buildOptions(account));
    try {
      await next.connect();
    } catch (err) {
      throw mapImapError(err);
    }
    client = next;
    return next;
  };

  const withMailbox = async <T>(folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> => {
    const connection = await connect();
    let lock;
    try {
      lock = await connection.getMailboxLock(folder);
      return await fn(connection);
    } catch (err) {
      throw mapImapError(err);
    } finally {
      lock?.release();
    }
  };

  return {
    async verify() {
      const connection = await connect();
      try {
        await connection.noop();
      } catch (err) {
        throw mapImapError(err);
      }
    },

    async listFolders() {
      const connection = await connect();
      try {
        const list = await connection.list();
        const folders: FolderInfo[] = [];
        for (const box of list) {
          const status = await connection.status(box.path, { messages: true, unseen: true });
          const info: FolderInfo = {
            path: box.path,
            name: box.name,
            total: status.messages ?? 0,
            unseen: status.unseen ?? 0,
          };
          if (box.specialUse) info.specialUse = box.specialUse.replace('\\', '').toLowerCase();
          folders.push(info);
        }
        return folders;
      } catch (err) {
        throw mapImapError(err);
      }
    },

    async searchUids(folder, criteria) {
      return withMailbox(folder, async (connection) => {
        const uids = await connection.search(toImapQuery(criteria), { uid: true });
        return uids ? [...uids].sort((a, b) => b - a) : [];
      });
    },

    async fetchMessages(folder, uids) {
      if (uids.length === 0) return [];
      return withMailbox(folder, async (connection) => {
        const messages: RawMessage[] = [];
        for await (const message of connection.fetch(
          uids.join(','),
          { uid: true, flags: true, envelope: true, source: true },
          { uid: true },
        )) {
          messages.push({
            uid: message.uid,
            date: message.envelope?.date ?? new Date(0),
            flags: message.flags ? [...message.flags] : [],
            source: message.source,
          });
        }
        return messages;
      });
    },

    async setFlags(folder, uids, flags, add) {
      if (uids.length === 0) return;
      await withMailbox(folder, async (connection) => {
        const range = uids.join(',');
        if (add) await connection.messageFlagsAdd(range, flags, { uid: true });
        else await connection.messageFlagsRemove(range, flags, { uid: true });
      });
    },

    async moveMessages(folder, uids, target) {
      if (uids.length === 0) return;
      await withMailbox(folder, async (connection) => {
        await connection.messageMove(uids.join(','), target, { uid: true });
      });
    },

    async expunge(folder, uids) {
      if (uids.length === 0) return;
      await withMailbox(folder, async (connection) => {
        await connection.messageDelete(uids.join(','), { uid: true });
      });
    },

    async close() {
      if (!client) return;
      try {
        await client.logout();
      } catch {
        client.close();
      } finally {
        client = undefined;
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/providers/imap.test.ts && npx tsc --noEmit`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/providers/icloud/imap.ts tests/unit/providers/imap.test.ts
git commit -m "feat(providers): add ImapFlow-backed IMAP provider"
```

---

### Task 9: SMTP Provider

**Files:**
- Create: `src/providers/icloud/smtp.ts`
- Test: `tests/unit/providers/smtp.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` (Task 4)、`AppError` (Task 2)
- Produces:
  - `interface OutgoingMessage { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text?: string; html?: string; inReplyTo?: string }`
  - `interface SmtpProvider { send(message: OutgoingMessage): Promise<{ messageId: string; accepted: string[]; rejected: string[] }>; verify(): Promise<void> }`
  - `function mapSmtpError(err: unknown): AppError`
  - `function createSmtpProvider(account: AccountConfig): SmtpProvider`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { mapSmtpError } from '../../../src/providers/icloud/smtp.js';

describe('mapSmtpError', () => {
  it('maps a 535 authentication rejection to AUTH_FAILED', () => {
    const mapped = mapSmtpError(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
    expect(mapped.code).toBe('AUTH_FAILED');
    expect(mapped.hint).toContain('App 专用密码');
  });

  it('maps a 421/450 throttle to a retryable RATE_LIMITED', () => {
    const mapped = mapSmtpError(Object.assign(new Error('too many messages'), { responseCode: 421 }));
    expect(mapped.code).toBe('RATE_LIMITED');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a 550 rejection to INVALID_INPUT', () => {
    const mapped = mapSmtpError(Object.assign(new Error('no such user'), { responseCode: 550 }));
    expect(mapped.code).toBe('INVALID_INPUT');
    expect(mapped.retryable).toBe(false);
  });

  it('falls back to a retryable UPSTREAM_ERROR without leaking details', () => {
    const mapped = mapSmtpError(new Error('AUTH PLAIN abcd-efgh'));
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.message).not.toContain('abcd-efgh');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/providers/smtp.test.ts`
Expected: FAIL，无法解析 `src/providers/icloud/smtp.js`

- [ ] **Step 3: 实现 `src/providers/icloud/smtp.ts`**

```ts
import nodemailer, { type Transporter } from 'nodemailer';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';

const HOST = 'smtp.mail.me.com';
const PORT = 587;

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface SmtpProvider {
  send(message: OutgoingMessage): Promise<SendResult>;
  verify(): Promise<void>;
}

export function mapSmtpError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const error = err as { responseCode?: number; code?: string };
  const code = error.responseCode;

  if (code === 535 || code === 534 || error.code === 'EAUTH') {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了发信认证', {
      hint: '确认 App 专用密码有效，且 ICLOUD_SENDER 与该密码属于同一账号',
      cause: err,
    });
  }
  if (code === 421 || code === 450 || code === 451 || code === 452) {
    return new AppError('RATE_LIMITED', 'iCloud 暂时限制了发信', { retryable: true, cause: err });
  }
  if (code !== undefined && code >= 500 && code < 600) {
    return new AppError('INVALID_INPUT', '收件人或邮件内容被服务器拒绝', {
      hint: '检查收件人地址是否正确',
      cause: err,
    });
  }
  return new AppError('UPSTREAM_ERROR', '发信失败', { retryable: true, cause: err });
}

/** SMTP 与 IMAP 一样使用 account.sender 认证，且发件人必须是该地址。 */
export function createSmtpProvider(account: AccountConfig): SmtpProvider {
  let transporter: Transporter | undefined;

  const get = (): Transporter => {
    transporter ??= nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: false,
      requireTLS: true,
      auth: { user: account.sender, pass: account.appPassword },
    });
    return transporter;
  };

  return {
    async verify() {
      try {
        await get().verify();
      } catch (err) {
        throw mapSmtpError(err);
      }
    },

    async send(message) {
      try {
        const info = await get().sendMail({
          from: account.sender,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
          html: message.html,
          inReplyTo: message.inReplyTo,
          references: message.inReplyTo ? [message.inReplyTo] : undefined,
        });
        return {
          messageId: info.messageId,
          accepted: info.accepted.map(String),
          rejected: info.rejected.map(String),
        };
      } catch (err) {
        throw mapSmtpError(err);
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/providers/smtp.test.ts && npx tsc --noEmit`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/providers/icloud/smtp.ts tests/unit/providers/smtp.test.ts
git commit -m "feat(providers): add SMTP provider with error mapping"
```

---

### Task 10: CalDAV Provider

**Files:**
- Create: `src/providers/icloud/caldav.ts`
- Test: `tests/unit/providers/caldav.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` (Task 4)、`AppError` (Task 2)
- Produces:
  - `interface CalendarInfo { url: string; name: string; color?: string; readOnly: boolean; components: string[] }`
  - `interface CalendarObject { collectionUrl: string; url: string; etag: string; data: string }`
  - `interface CalDavProvider { verify(): Promise<void>; listCalendars(): Promise<CalendarInfo[]>; fetchObjects(calendarUrl: string, range?: { start: Date; end: Date }): Promise<CalendarObject[]>; fetchOne(collectionUrl: string, resourceUrl: string): Promise<CalendarObject>; create(calendarUrl: string, filename: string, ics: string): Promise<CalendarObject>; update(object: { collectionUrl: string; url: string; etag: string; data: string }): Promise<void>; remove(object: { url: string; etag: string }): Promise<void> }`
  - `function mapCalDavError(err: unknown): AppError`
  - `function createCalDavProvider(account: AccountConfig): CalDavProvider`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { mapCalDavError } from '../../../src/providers/icloud/caldav.js';

describe('mapCalDavError', () => {
  it('maps 401 to AUTH_FAILED', () => {
    const mapped = mapCalDavError({ status: 401, message: 'Unauthorized' });
    expect(mapped.code).toBe('AUTH_FAILED');
  });

  it('maps 403 to PERMISSION_DENIED', () => {
    expect(mapCalDavError({ status: 403 }).code).toBe('PERMISSION_DENIED');
  });

  it('maps 404 to NOT_FOUND with a recovery hint', () => {
    const mapped = mapCalDavError({ status: 404 });
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.hint).toContain('calendar_list_events');
  });

  it('maps 412 precondition failure to CONFLICT', () => {
    const mapped = mapCalDavError({ status: 412 });
    expect(mapped.code).toBe('CONFLICT');
    expect(mapped.hint).toContain('重新读取');
  });

  it('maps 5xx to a retryable UPSTREAM_ERROR', () => {
    const mapped = mapCalDavError({ status: 503 });
    expect(mapped.code).toBe('UPSTREAM_ERROR');
    expect(mapped.retryable).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/providers/caldav.test.ts`
Expected: FAIL，无法解析 `src/providers/icloud/caldav.js`

- [ ] **Step 3: 实现 `src/providers/icloud/caldav.ts`**

```ts
import { createDAVClient } from 'tsdav';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';

const SERVER_URL = 'https://caldav.icloud.com/';

export interface CalendarInfo {
  url: string;
  name: string;
  color?: string;
  readOnly: boolean;
  components: string[];
}

export interface CalendarObject {
  collectionUrl: string;
  url: string;
  etag: string;
  data: string;
}

export interface CalDavProvider {
  verify(): Promise<void>;
  listCalendars(): Promise<CalendarInfo[]>;
  fetchObjects(calendarUrl: string, range?: { start: Date; end: Date }): Promise<CalendarObject[]>;
  fetchOne(collectionUrl: string, resourceUrl: string): Promise<CalendarObject>;
  create(calendarUrl: string, filename: string, ics: string): Promise<CalendarObject>;
  update(object: CalendarObject): Promise<void>;
  remove(object: { url: string; etag: string }): Promise<void>;
}

export function mapCalDavError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const status = (err as { status?: number }).status;

  if (status === 401) {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了日历访问凭据', {
      hint: '确认 App 专用密码有效，且 ICLOUD_ACCOUNT 是 Apple ID 邮箱',
      cause: err,
    });
  }
  if (status === 403) {
    return new AppError('PERMISSION_DENIED', '没有该日历的写入权限', { cause: err });
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', '日历资源不存在或已被删除', {
      hint: '重新调用 calendar_list_events 获取最新的 event_id',
      cause: err,
    });
  }
  if (status === 412) {
    return new AppError('CONFLICT', '该事件已被其他客户端修改', {
      hint: '重新读取事件后再提交修改',
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new AppError('UPSTREAM_ERROR', 'iCloud 日历服务暂时不可用', { retryable: true, cause: err });
  }
  return new AppError('UPSTREAM_ERROR', '日历操作失败', { retryable: true, cause: err });
}

/** CalDAV 认证用 account.email（Apple ID），与 IMAP 使用的 sender 不同。 */
export function createCalDavProvider(account: AccountConfig): CalDavProvider {
  type DavClient = Awaited<ReturnType<typeof createDAVClient>>;
  let clientPromise: Promise<DavClient> | undefined;

  const getClient = async (): Promise<DavClient> => {
    clientPromise ??= createDAVClient({
      serverUrl: SERVER_URL,
      credentials: { username: account.email, password: account.appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    }).catch((err: unknown) => {
      clientPromise = undefined;
      throw mapCalDavError(err);
    });
    return clientPromise;
  };

  const toObject = (collectionUrl: string, raw: { url: string; etag?: string; data?: unknown }): CalendarObject => ({
    collectionUrl,
    url: raw.url,
    etag: raw.etag ?? '',
    data: typeof raw.data === 'string' ? raw.data : '',
  });

  return {
    async verify() {
      const client = await getClient();
      try {
        await client.fetchCalendars();
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async listCalendars() {
      const client = await getClient();
      try {
        const calendars = await client.fetchCalendars();
        return calendars.map((cal) => {
          const components = (cal.components ?? []).map(String);
          const info: CalendarInfo = {
            url: cal.url,
            name: typeof cal.displayName === 'string' ? cal.displayName : cal.url,
            readOnly: !(cal.privilege ?? []).some((p) => String(p).includes('write')),
            components,
          };
          if (typeof cal.calendarColor === 'string') info.color = cal.calendarColor;
          return info;
        });
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async fetchObjects(calendarUrl, range) {
      const client = await getClient();
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: { url: calendarUrl },
          timeRange: range
            ? { start: range.start.toISOString(), end: range.end.toISOString() }
            : undefined,
        });
        return objects.map((o) => toObject(calendarUrl, o));
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async fetchOne(collectionUrl, resourceUrl) {
      const client = await getClient();
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: { url: collectionUrl },
          objectUrls: [resourceUrl],
        });
        const found = objects[0];
        if (!found) {
          throw new AppError('NOT_FOUND', '日历事件不存在或已被删除', {
            hint: '重新调用 calendar_list_events 获取最新的 event_id',
          });
        }
        return toObject(collectionUrl, found);
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async create(calendarUrl, filename, ics) {
      const client = await getClient();
      try {
        const response = await client.createCalendarObject({
          calendar: { url: calendarUrl },
          filename: filename.endsWith('.ics') ? filename : `${filename}.ics`,
          iCalString: ics,
        });
        if (!response.ok) throw { status: response.status };
        return {
          collectionUrl: calendarUrl,
          url: response.url ?? `${calendarUrl}${filename}`,
          etag: response.headers?.get?.('etag') ?? '',
          data: ics,
        };
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async update(object) {
      const client = await getClient();
      try {
        const response = await client.updateCalendarObject({
          calendarObject: { url: object.url, etag: object.etag, data: object.data },
        });
        if (!response.ok) throw { status: response.status };
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async remove(object) {
      const client = await getClient();
      try {
        const response = await client.deleteCalendarObject({
          calendarObject: { url: object.url, etag: object.etag, data: '' },
        });
        if (!response.ok) throw { status: response.status };
      } catch (err) {
        throw mapCalDavError(err);
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/providers/caldav.test.ts && npx tsc --noEmit`
Expected: 5 passed。tsdav 的返回类型若与上述解构不完全一致，按其 `.d.ts` 调整字段读取方式，保持 `CalendarObject` 的形状不变。

- [ ] **Step 5: 提交**

```bash
git add src/providers/icloud/caldav.ts tests/unit/providers/caldav.test.ts
git commit -m "feat(providers): add CalDAV provider with status-code error mapping"
```

---
### Task 11: 会话存储

会话持有连接，因此销毁会话必须关闭连接。时钟通过注入提供，测试不依赖真实时间。

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/unit/core/session.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` (Task 4)、`AppError` (Task 2)、`ImapProvider` (Task 8)、`SmtpProvider` (Task 9)、`CalDavProvider` (Task 10)
- Produces:
  - `interface SessionProviders { imap: ImapProvider; smtp: SmtpProvider; caldav: CalDavProvider }`
  - `type ProviderFactory = (account: AccountConfig) => SessionProviders`
  - `interface Session { id: string; account: AccountConfig; createdAt: number; lastActiveAt: number; providers: SessionProviders }`
  - `interface SessionStore { create(account: AccountConfig): Session; get(id: string): Session; destroy(id: string): Promise<boolean>; destroyAll(): Promise<void>; sweep(): Promise<number>; size(): number }`
  - `function createSessionStore(options: { ttlMs: number; providerFactory: ProviderFactory; now?: () => number }): SessionStore`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSessionStore, type SessionProviders } from '../../../src/core/session.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';

const account: AccountConfig = {
  id: 'account_1',
  email: 'me@icloud.com',
  sender: 'me@icloud.com',
  label: 'me@icloud.com',
  appPassword: 'abcd-efgh-ijkl-mnop',
  capabilities: {
    mailRead: true,
    mailWrite: true,
    calendarRead: true,
    calendarWrite: true,
    remindersRead: true,
    remindersWrite: true,
    contactsRead: true,
    contactsWrite: true,
  },
};

function makeProviders(): SessionProviders & { closed: () => number } {
  let closeCount = 0;
  const providers = {
    imap: {
      close: async () => {
        closeCount += 1;
      },
    },
    smtp: {},
    caldav: {},
  } as unknown as SessionProviders;
  return Object.assign(providers, { closed: () => closeCount });
}

describe('SessionStore', () => {
  it('creates a session with a random id and returns it on get', () => {
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => makeProviders() });
    const session = store.create(account);
    expect(session.id).toHaveLength(36);
    expect(store.get(session.id).account.email).toBe('me@icloud.com');
  });

  it('throws SESSION_EXPIRED for an unknown id', () => {
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => makeProviders() });
    try {
      store.get('00000000-0000-0000-0000-000000000000');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('SESSION_EXPIRED');
      expect((e as AppError).hint).toContain('apple_login');
    }
  });

  it('expires a session once the ttl elapses', () => {
    let now = 1_000_000;
    const store = createSessionStore({
      ttlMs: 5_000,
      providerFactory: () => makeProviders(),
      now: () => now,
    });
    const session = store.create(account);
    now += 4_999;
    expect(store.get(session.id).id).toBe(session.id);
    now += 2;
    expect(() => store.get(session.id)).toThrowError(AppError);
  });

  it('refreshes lastActiveAt on each get', () => {
    let now = 1_000_000;
    const store = createSessionStore({
      ttlMs: 5_000,
      providerFactory: () => makeProviders(),
      now: () => now,
    });
    const session = store.create(account);
    now += 4_000;
    store.get(session.id);
    now += 4_000;
    expect(store.get(session.id).id).toBe(session.id);
  });

  it('closes the imap connection when destroyed', async () => {
    const providers = makeProviders();
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => providers });
    const session = store.create(account);
    await store.destroy(session.id);
    expect(providers.closed()).toBe(1);
    expect(store.size()).toBe(0);
  });

  it('returns false when destroying an unknown session', async () => {
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => makeProviders() });
    expect(await store.destroy('missing')).toBe(false);
  });

  it('sweeps expired sessions and reports how many were removed', async () => {
    let now = 0;
    const providers = makeProviders();
    const store = createSessionStore({
      ttlMs: 1_000,
      providerFactory: () => providers,
      now: () => now,
    });
    store.create(account);
    store.create(account);
    now = 2_000;
    expect(await store.sweep()).toBe(2);
    expect(store.size()).toBe(0);
    expect(providers.closed()).toBe(2);
  });

  it('closes every session on destroyAll', async () => {
    const providers = makeProviders();
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => providers });
    store.create(account);
    store.create(account);
    await store.destroyAll();
    expect(store.size()).toBe(0);
    expect(providers.closed()).toBe(2);
  });

  it('survives a provider that throws while closing', async () => {
    const providers = {
      imap: { close: vi.fn().mockRejectedValue(new Error('socket already gone')) },
      smtp: {},
      caldav: {},
    } as unknown as SessionProviders;
    const store = createSessionStore({ ttlMs: 1000, providerFactory: () => providers });
    const session = store.create(account);
    await expect(store.destroy(session.id)).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/core/session.test.ts`
Expected: FAIL，无法解析 `src/core/session.js`

- [ ] **Step 3: 实现 `src/core/session.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import type { AccountConfig } from './config.js';
import type { ImapProvider } from '../providers/icloud/imap.js';
import type { SmtpProvider } from '../providers/icloud/smtp.js';
import type { CalDavProvider } from '../providers/icloud/caldav.js';

export interface SessionProviders {
  imap: ImapProvider;
  smtp: SmtpProvider;
  caldav: CalDavProvider;
}

export type ProviderFactory = (account: AccountConfig) => SessionProviders;

export interface Session {
  id: string;
  account: AccountConfig;
  createdAt: number;
  lastActiveAt: number;
  providers: SessionProviders;
}

export interface SessionStore {
  create(account: AccountConfig): Session;
  get(id: string): Session;
  destroy(id: string): Promise<boolean>;
  destroyAll(): Promise<void>;
  sweep(): Promise<number>;
  size(): number;
}

export interface SessionStoreOptions {
  ttlMs: number;
  providerFactory: ProviderFactory;
  now?: () => number;
}

const EXPIRED_HINT = '会话已失效，请调用 apple_login 重新获取 session_id 后重试本次操作';

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => Date.now());

  const closeQuietly = async (session: Session): Promise<void> => {
    try {
      await session.providers.imap.close();
    } catch {
      // 连接可能已被对端关闭，销毁流程不因此失败
    }
  };

  return {
    create(account) {
      const timestamp = now();
      const session: Session = {
        id: randomUUID(),
        account,
        createdAt: timestamp,
        lastActiveAt: timestamp,
        providers: options.providerFactory(account),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(id) {
      const session = sessions.get(id);
      if (!session) {
        throw new AppError('SESSION_EXPIRED', '无效的 session_id', { hint: EXPIRED_HINT });
      }
      const timestamp = now();
      if (timestamp - session.lastActiveAt > options.ttlMs) {
        sessions.delete(id);
        void closeQuietly(session);
        throw new AppError('SESSION_EXPIRED', '会话已超时', { hint: EXPIRED_HINT });
      }
      session.lastActiveAt = timestamp;
      return session;
    },

    async destroy(id) {
      const session = sessions.get(id);
      if (!session) return false;
      sessions.delete(id);
      await closeQuietly(session);
      return true;
    },

    async destroyAll() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map(closeQuietly));
    },

    async sweep() {
      const timestamp = now();
      const expired = [...sessions.values()].filter((s) => timestamp - s.lastActiveAt > options.ttlMs);
      for (const session of expired) sessions.delete(session.id);
      await Promise.all(expired.map(closeQuietly));
      return expired.length;
    },

    size() {
      return sessions.size;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/core/session.test.ts && npx tsc --noEmit`
Expected: 9 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/session.ts tests/unit/core/session.test.ts
git commit -m "feat(core): add session store with ttl and connection cleanup"
```

---

### Task 12: 邮件服务层

权限闸门在这一层执行，不依赖工具层。所有测试用假 provider，不连网络。

**Files:**
- Create: `src/modules/mail/types.ts`
- Create: `src/modules/mail/service.ts`
- Test: `tests/unit/modules/mail-service.test.ts`

**Interfaces:**
- Consumes: `AccountConfig`、`AppError`、`ImapProvider`、`SmtpProvider`、`parseEmail`/`makeSnippet`/`htmlToText`
- Produces（`src/modules/mail/types.ts`）:
  - `interface MessageSummary { uid: number; date: string; from?: EmailAddress; to: EmailAddress[]; subject: string; snippet: string; seen: boolean; flagged: boolean; hasAttachments: boolean }`
  - `interface SearchResult { messages: MessageSummary[]; nextCursor?: string }`
  - `interface SearchParams { folder?: string; query?: SearchCriteria; limit?: number; cursor?: string }`
- Produces（`src/modules/mail/service.ts`）:
  - `interface MailService { listFolders(): Promise<FolderInfo[]>; search(params: SearchParams): Promise<SearchResult>; read(uid: number, folder?: string, format?: 'text'|'html'|'both'): Promise<ParsedEmail & { uid: number }>; send(message: OutgoingMessage): Promise<SendResult>; mark(uids: number[], flags: { seen?: boolean; flagged?: boolean }, folder?: string): Promise<{ updated: number }>; move(uids: number[], from: string, to: string): Promise<{ moved: number }>; remove(uids: number[], folder?: string, permanent?: boolean): Promise<{ deleted: number; permanent: boolean }> }`
  - `function createMailService(deps: { account: AccountConfig; imap: ImapProvider; smtp: SmtpProvider }): MailService`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMailService } from '../../../src/modules/mail/service.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { ImapProvider } from '../../../src/providers/icloud/imap.js';
import type { SmtpProvider } from '../../../src/providers/icloud/smtp.js';

const source = readFileSync(join(process.cwd(), 'tests/fixtures/mail/chinese-base64.eml'));

function makeAccount(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
    email: 'me@icloud.com',
    sender: 'me@icloud.com',
    label: 'me@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    capabilities: {
      mailRead: true,
      mailWrite: true,
      calendarRead: true,
      calendarWrite: true,
      remindersRead: true,
      remindersWrite: true,
      contactsRead: true,
      contactsWrite: true,
      ...overrides,
    },
  };
}

function makeImap(overrides: Partial<ImapProvider> = {}): ImapProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listFolders: vi.fn().mockResolvedValue([
      { path: 'INBOX', name: 'INBOX', specialUse: 'inbox', total: 3, unseen: 1 },
      { path: 'Deleted Messages', name: 'Deleted Messages', specialUse: 'trash', total: 0, unseen: 0 },
    ]),
    searchUids: vi.fn().mockResolvedValue([30, 20, 10]),
    fetchMessages: vi.fn().mockResolvedValue([
      { uid: 30, date: new Date('2026-08-17T02:30:00Z'), flags: ['\\Seen'], source },
    ]),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveMessages: vi.fn().mockResolvedValue(undefined),
    expunge: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSmtp(): SmtpProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({
      messageId: '<sent@icloud.com>',
      accepted: ['friend@example.com'],
      rejected: [],
    }),
  };
}

describe('MailService permissions', () => {
  it('refuses to search when mail read is disabled', async () => {
    const service = createMailService({
      account: makeAccount({ mailRead: false }),
      imap: makeImap(),
      smtp: makeSmtp(),
    });
    await expect(service.search({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to send when mail write is disabled', async () => {
    const service = createMailService({
      account: makeAccount({ mailWrite: false }),
      imap: makeImap(),
      smtp: makeSmtp(),
    });
    await expect(
      service.send({ to: ['friend@example.com'], subject: 'hi', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('names the environment variable to flip in the hint', async () => {
    const service = createMailService({
      account: makeAccount({ mailWrite: false }),
      imap: makeImap(),
      smtp: makeSmtp(),
    });
    try {
      await service.remove([1]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).hint).toContain('ALLOW_MAIL_WRITE');
    }
  });
});

describe('MailService.search', () => {
  it('returns decoded summaries with a snippet', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    const result = await service.search({ limit: 1 });
    expect(result.messages[0]!.subject).toBe('测试邮件：中文主题');
    expect(result.messages[0]!.snippet).toContain('你好');
    expect(result.messages[0]!.seen).toBe(true);
  });

  it('defaults to INBOX and fetches only the requested page', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await service.search({ limit: 1 });
    expect(imap.searchUids).toHaveBeenCalledWith('INBOX', {});
    expect(imap.fetchMessages).toHaveBeenCalledWith('INBOX', [30]);
  });

  it('emits a cursor when more results remain', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const result = await service.search({ limit: 1 });
    expect(result.nextCursor).toBe('1');
  });

  it('omits the cursor on the last page', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const result = await service.search({ limit: 10 });
    expect(result.nextCursor).toBeUndefined();
  });

  it('continues from a cursor', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await service.search({ limit: 1, cursor: '2' });
    expect(imap.fetchMessages).toHaveBeenCalledWith('INBOX', [10]);
  });

  it('rejects a limit above the cap', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.search({ limit: 500 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('MailService.read', () => {
  it('returns the decoded body and drops html unless requested', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    const mail = await service.read(30);
    expect(mail.uid).toBe(30);
    expect(mail.text).toContain('第二行。');
    expect(mail.html).toBeUndefined();
  });

  it('raises NOT_FOUND when the uid is absent', async () => {
    const imap = makeImap({ fetchMessages: vi.fn().mockResolvedValue([]) });
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await expect(service.read(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('MailService.mark / move / remove', () => {
  it('adds and removes flags in separate calls', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await service.mark([1, 2], { seen: true, flagged: false });
    expect(imap.setFlags).toHaveBeenCalledWith('INBOX', [1, 2], ['\\Seen'], true);
    expect(imap.setFlags).toHaveBeenCalledWith('INBOX', [1, 2], ['\\Flagged'], false);
  });

  it('moves messages to the trash folder by default', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    const result = await service.remove([5]);
    expect(imap.moveMessages).toHaveBeenCalledWith('INBOX', [5], 'Deleted Messages');
    expect(imap.expunge).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 1, permanent: false });
  });

  it('expunges instead when permanent deletion is requested', async () => {
    const imap = makeImap();
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    const result = await service.remove([5], 'INBOX', true);
    expect(imap.expunge).toHaveBeenCalledWith('INBOX', [5]);
    expect(imap.moveMessages).not.toHaveBeenCalled();
    expect(result.permanent).toBe(true);
  });

  it('fails clearly when no trash folder can be discovered', async () => {
    const imap = makeImap({
      listFolders: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX', total: 0, unseen: 0 }]),
    });
    const service = createMailService({ account: makeAccount(), imap, smtp: makeSmtp() });
    await expect(service.remove([5])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an empty uid list', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.mark([], { seen: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('MailService.send', () => {
  it('requires at least one body part', async () => {
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp: makeSmtp() });
    await expect(service.send({ to: ['a@b.com'], subject: 's' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('passes the message through to the smtp provider', async () => {
    const smtp = makeSmtp();
    const service = createMailService({ account: makeAccount(), imap: makeImap(), smtp });
    const result = await service.send({ to: ['friend@example.com'], subject: 'hi', text: 'hi' });
    expect(smtp.send).toHaveBeenCalled();
    expect(result.accepted).toEqual(['friend@example.com']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/modules/mail-service.test.ts`
Expected: FAIL，无法解析 `src/modules/mail/service.js`

- [ ] **Step 3: 实现 `src/modules/mail/types.ts`**

```ts
import type { EmailAddress } from '../../parsers/mime.js';
import type { SearchCriteria } from '../../providers/icloud/imap.js';

export interface MessageSummary {
  uid: number;
  date: string;
  from?: EmailAddress;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface SearchResult {
  messages: MessageSummary[];
  nextCursor?: string;
}

export interface SearchParams {
  folder?: string;
  query?: SearchCriteria;
  limit?: number;
  cursor?: string;
}
```

- [ ] **Step 4: 实现 `src/modules/mail/service.ts`**

```ts
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';
import { makeSnippet, parseEmail, type ParsedEmail } from '../../parsers/mime.js';
import type { FolderInfo, ImapProvider } from '../../providers/icloud/imap.js';
import type { OutgoingMessage, SendResult, SmtpProvider } from '../../providers/icloud/smtp.js';
import type { SearchParams, SearchResult } from './types.js';

const DEFAULT_FOLDER = 'INBOX';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface MailService {
  listFolders(): Promise<FolderInfo[]>;
  search(params: SearchParams): Promise<SearchResult>;
  read(uid: number, folder?: string, format?: 'text' | 'html' | 'both'): Promise<ParsedEmail & { uid: number }>;
  send(message: OutgoingMessage): Promise<SendResult>;
  mark(uids: number[], flags: { seen?: boolean; flagged?: boolean }, folder?: string): Promise<{ updated: number }>;
  move(uids: number[], from: string, to: string): Promise<{ moved: number }>;
  remove(uids: number[], folder?: string, permanent?: boolean): Promise<{ deleted: number; permanent: boolean }>;
}

export interface MailServiceDeps {
  account: AccountConfig;
  imap: ImapProvider;
  smtp: SmtpProvider;
}

export function createMailService(deps: MailServiceDeps): MailService {
  const { account, imap, smtp } = deps;

  const requireRead = (): void => {
    if (!account.capabilities.mailRead) {
      throw new AppError('PERMISSION_DENIED', '该账号的邮件读取权限未开启', {
        hint: `设置环境变量 ALLOW_MAIL_READ_${account.id.split('_')[1]}=true 后重启服务`,
      });
    }
  };

  const requireWrite = (): void => {
    if (!account.capabilities.mailWrite) {
      throw new AppError('PERMISSION_DENIED', '该账号的邮件写入权限未开启', {
        hint: `设置环境变量 ALLOW_MAIL_WRITE_${account.id.split('_')[1]}=true 后重启服务`,
      });
    }
  };

  const requireUids = (uids: number[]): void => {
    if (uids.length === 0) {
      throw new AppError('INVALID_INPUT', 'uid 列表不能为空');
    }
  };

  const findTrash = async (): Promise<string> => {
    const folders = await imap.listFolders();
    const trash = folders.find((f) => f.specialUse === 'trash');
    if (!trash) {
      throw new AppError('NOT_FOUND', '找不到废纸篓文件夹', {
        hint: '调用 mail_folders 查看可用文件夹，或使用 permanent: true 直接删除',
      });
    }
    return trash.path;
  };

  return {
    async listFolders() {
      requireRead();
      return imap.listFolders();
    },

    async search(params) {
      requireRead();
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (limit < 1 || limit > MAX_LIMIT) {
        throw new AppError('INVALID_INPUT', `limit 必须在 1 到 ${MAX_LIMIT} 之间`);
      }

      const folder = params.folder ?? DEFAULT_FOLDER;
      const offset = params.cursor ? Number(params.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new AppError('INVALID_INPUT', 'cursor 不合法', {
          hint: '请原样使用上一次返回的 nextCursor',
        });
      }

      const allUids = await imap.searchUids(folder, params.query ?? {});
      const page = allUids.slice(offset, offset + limit);
      const raw = await imap.fetchMessages(folder, page);

      const messages = await Promise.all(
        raw.map(async (message) => {
          const parsed = await parseEmail(message.source);
          return {
            uid: message.uid,
            date: parsed.date ?? message.date.toISOString(),
            from: parsed.from,
            to: parsed.to,
            subject: parsed.subject,
            snippet: makeSnippet(parsed.text),
            seen: message.flags.includes('\\Seen'),
            flagged: message.flags.includes('\\Flagged'),
            hasAttachments: parsed.attachments.length > 0,
          };
        }),
      );

      const result: SearchResult = { messages };
      if (offset + page.length < allUids.length) {
        result.nextCursor = String(offset + page.length);
      }
      return result;
    },

    async read(uid, folder = DEFAULT_FOLDER, format = 'text') {
      requireRead();
      const [message] = await imap.fetchMessages(folder, [uid]);
      if (!message) {
        throw new AppError('NOT_FOUND', `文件夹 ${folder} 中不存在 uid 为 ${uid} 的邮件`, {
          hint: '先用 mail_search 获取有效的 uid',
        });
      }

      const parsed = await parseEmail(message.source);
      const result = { ...parsed, uid: message.uid };
      if (format === 'text') delete result.html;
      if (format === 'html' && parsed.html) result.text = '';
      return result;
    },

    async send(message) {
      requireWrite();
      if (!message.text && !message.html) {
        throw new AppError('INVALID_INPUT', '邮件必须包含 text 或 html 之一');
      }
      if (message.to.length === 0) {
        throw new AppError('INVALID_INPUT', '收件人不能为空');
      }
      return smtp.send(message);
    },

    async mark(uids, flags, folder = DEFAULT_FOLDER) {
      requireWrite();
      requireUids(uids);
      if (flags.seen !== undefined) await imap.setFlags(folder, uids, ['\\Seen'], flags.seen);
      if (flags.flagged !== undefined) await imap.setFlags(folder, uids, ['\\Flagged'], flags.flagged);
      return { updated: uids.length };
    },

    async move(uids, from, to) {
      requireWrite();
      requireUids(uids);
      await imap.moveMessages(from, uids, to);
      return { moved: uids.length };
    },

    async remove(uids, folder = DEFAULT_FOLDER, permanent = false) {
      requireWrite();
      requireUids(uids);
      if (permanent) {
        await imap.expunge(folder, uids);
      } else {
        await imap.moveMessages(folder, uids, await findTrash());
      }
      return { deleted: uids.length, permanent };
    },
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/unit/modules/mail-service.test.ts && npx tsc --noEmit`
Expected: 18 passed

- [ ] **Step 6: 提交**

```bash
git add src/modules/mail tests/unit/modules/mail-service.test.ts
git commit -m "feat(mail): add mail service with permission gates and pagination"
```

---

### Task 13: 邮件工具层

工具层是唯一认识 MCP 的地方。为了可测，模块依赖一个最小的 `ToolRegistrar` 接口而非具体的 `McpServer`。

**Files:**
- Create: `src/server/types.ts`
- Create: `src/server/wrap.ts`
- Create: `src/modules/mail/tools.ts`
- Test: `tests/unit/modules/mail-tools.test.ts`

**Interfaces:**
- Consumes: `MailService` (Task 12)、`SessionStore` (Task 11)、`toErrorPayload` (Task 2)、`Logger` (Task 3)
- Produces（`src/server/types.ts`）:
  - `interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }`
  - `interface ToolConfig { title?: string; description: string; inputSchema: ZodRawShape; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } }`
  - `interface ToolRegistrar { registerTool(name: string, config: ToolConfig, handler: (args: any) => Promise<ToolResult>): unknown }`
  - `interface ToolDeps { sessions: SessionStore; logger: Logger }`
- Produces（`src/server/wrap.ts`）:
  - `function wrapTool<T>(logger: Logger, name: string, handler: (args: T) => Promise<unknown>): (args: T) => Promise<ToolResult>`
- Produces（`src/modules/mail/tools.ts`）:
  - `interface MailToolDeps extends ToolDeps { mailFor: (session: Session) => MailService }`
  - `function registerMailTools(server: ToolRegistrar, deps: MailToolDeps): void`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerMailTools } from '../../../src/modules/mail/tools.js';
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
  get: vi.fn().mockReturnValue({
    id: 's1',
    account: { id: 'account_1', email: 'me@icloud.com' },
    providers: {},
  }),
} as unknown as SessionStore;

/** 工具层通过注入的工厂拿到 service，因此这里可以直接塞一个假的。 */
function depsWith(service: Record<string, unknown>) {
  return {
    sessions: fakeSessions,
    logger: silentLogger,
    mailFor: () => service as never,
  };
}

describe('registerMailTools', () => {
  it('registers every mail tool', () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'mail_delete',
      'mail_folders',
      'mail_mark',
      'mail_move',
      'mail_read',
      'mail_search',
      'mail_send',
    ]);
  });

  it('marks read-only tools and destructive tools with the right annotations', () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({}));
    expect(tools.get('mail_search')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('mail_delete')!.config.annotations?.destructiveHint).toBe(true);
    expect(tools.get('mail_send')!.config.annotations?.destructiveHint).toBe(false);
  });

  it('requires session_id in every schema', () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({}));
    for (const [name, tool] of tools) {
      const shape = tool.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.session_id, `${name} 缺少 session_id`).toBeDefined();
    }
  });

  it('returns the service result as JSON text', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockResolvedValue({ messages: [{ uid: 1 }] });
    registerMailTools(server, depsWith({ search }));

    const result = await tools.get('mail_search')!.handler({ session_id: 's1', limit: 5 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ messages: [{ uid: 1 }] });
    expect(search).toHaveBeenCalledWith({ folder: undefined, query: undefined, limit: 5, cursor: undefined });
  });

  it('converts an AppError into a structured error payload', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockRejectedValue(
      new AppError('PERMISSION_DENIED', '读权限未开启', { hint: '设置 ALLOW_MAIL_READ_1=true' }),
    );
    registerMailTools(server, depsWith({ search }));

    const result = await tools.get('mail_search')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_MAIL_READ_1');
  });

  it('hides internal failures behind a generic message', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockRejectedValue(new Error('imap socket died: pass=abcd-efgh'));
    registerMailTools(server, depsWith({ search }));

    const result = await tools.get('mail_search')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('abcd-efgh');
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('INTERNAL');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/modules/mail-tools.test.ts`
Expected: FAIL，无法解析 `src/modules/mail/tools.js`

- [ ] **Step 3: 实现 `src/server/types.ts`**

```ts
import type { ZodRawShape } from 'zod';
import type { SessionStore } from '../core/session.js';
import type { Logger } from '../core/logger.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolConfig {
  title?: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations?: ToolAnnotations;
}

/**
 * McpServer 满足这个接口。模块依赖它而非具体实现，
 * 使工具层可以在不启动 MCP server 的情况下被测试。
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: ToolConfig,
    handler: (args: any) => Promise<ToolResult>,
  ): unknown;
}

export interface ToolDeps {
  sessions: SessionStore;
  logger: Logger;
}
```

- [ ] **Step 4: 实现 `src/server/wrap.ts`**

```ts
import { AppError, toErrorPayload } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ToolResult } from './types.js';

const asText = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** 统一的工具边界：序列化成功结果，把任何异常转成结构化错误载荷。 */
export function wrapTool<T>(
  logger: Logger,
  name: string,
  handler: (args: T) => Promise<unknown>,
): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      logger.debug('tool ok', { tool: name, ms: Date.now() - startedAt });
      return asText(result);
    } catch (err) {
      const payload = toErrorPayload(err);
      logger.warn('tool failed', {
        tool: name,
        ms: Date.now() - startedAt,
        code: payload.error.code,
        detail: err instanceof AppError ? err.message : String(err),
      });
      return { ...asText(payload), isError: true };
    }
  };
}
```

- [ ] **Step 5: 实现 `src/modules/mail/tools.ts`**

```ts
import { z } from 'zod';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';
import type { Session } from '../../core/session.js';
import type { MailService } from './service.js';

export interface MailToolDeps extends ToolDeps {
  /** 由 createServer 注入：从会话持有的 provider 构造 MailService。 */
  mailFor: (session: Session) => MailService;
}

const sessionId = z.string().describe('apple_login 返回的 session_id');
const folder = z.string().optional().describe('文件夹路径，默认 INBOX');

const querySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    since: z.string().optional().describe('ISO 8601 时间，只看该时刻之后的邮件'),
    before: z.string().optional(),
    unseen: z.boolean().optional(),
    flagged: z.boolean().optional(),
  })
  .optional();

function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

export function registerMailTools(server: ToolRegistrar, deps: MailToolDeps): void {
  const { sessions, logger, mailFor } = deps;

  /** 每次调用先校验会话（过期即抛 SESSION_EXPIRED），再取该会话的 service。 */
  const serviceOf = (sessionId: string): MailService => mailFor(sessions.get(sessionId));

  server.registerTool(
    'mail_folders',
    {
      title: '列出邮件文件夹',
      description: '返回所有邮件文件夹及其未读数。specialUse 标出收件箱、已发送、废纸篓等特殊用途。',
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'mail_folders', async (args: { session_id: string }) =>
      serviceOf(args.session_id).listFolders(),
    ),
  );

  server.registerTool(
    'mail_search',
    {
      title: '搜索邮件',
      description:
        '按条件搜索邮件，返回解码后的摘要列表（不含完整正文）。用 nextCursor 翻页，用 mail_read 读取正文。',
      inputSchema: {
        session_id: sessionId,
        folder,
        query: querySchema,
        limit: z.number().int().min(1).max(100).optional().describe('默认 20'),
        cursor: z.string().optional().describe('上一次返回的 nextCursor'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'mail_search',
      async (args: {
        session_id: string;
        folder?: string;
        query?: Record<string, unknown>;
        limit?: number;
        cursor?: string;
      }) => {
        const query = args.query
          ? {
              ...args.query,
              since: toDate(args.query.since as string | undefined),
              before: toDate(args.query.before as string | undefined),
            }
          : undefined;
        return serviceOf(args.session_id).search({
          folder: args.folder,
          query: query as never,
          limit: args.limit,
          cursor: args.cursor,
        });
      },
    ),
  );

  server.registerTool(
    'mail_read',
    {
      title: '读取邮件正文',
      description: '按 uid 读取单封邮件，返回已解码的正文、收发件人与附件元信息。',
      inputSchema: {
        session_id: sessionId,
        uid: z.number().int().describe('mail_search 返回的 uid'),
        folder,
        format: z.enum(['text', 'html', 'both']).optional().describe('默认 text'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'mail_read',
      async (args: { session_id: string; uid: number; folder?: string; format?: 'text' | 'html' | 'both' }) =>
        serviceOf(args.session_id).read(args.uid, args.folder, args.format),
    ),
  );

  server.registerTool(
    'mail_send',
    {
      title: '发送邮件',
      description: '以配置的发信身份发送一封新邮件。text 与 html 至少提供一个。',
      inputSchema: {
        session_id: sessionId,
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        in_reply_to: z.string().optional().describe('被回复邮件的 messageId'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'mail_send',
      async (args: {
        session_id: string;
        to: string[];
        cc?: string[];
        bcc?: string[];
        subject: string;
        text?: string;
        html?: string;
        in_reply_to?: string;
      }) =>
        serviceOf(args.session_id).send({
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          inReplyTo: args.in_reply_to,
        }),
    ),
  );

  server.registerTool(
    'mail_mark',
    {
      title: '标记邮件',
      description: '批量设置或清除已读、加星标记。',
      inputSchema: {
        session_id: sessionId,
        uid: z.array(z.number().int()).min(1),
        folder,
        flags: z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() }),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapTool(
      logger,
      'mail_mark',
      async (args: {
        session_id: string;
        uid: number[];
        folder?: string;
        flags: { seen?: boolean; flagged?: boolean };
      }) => serviceOf(args.session_id).mark(args.uid, args.flags, args.folder),
    ),
  );

  server.registerTool(
    'mail_move',
    {
      title: '移动邮件',
      description: '把邮件批量移动到另一个文件夹。文件夹路径用 mail_folders 获取。',
      inputSchema: {
        session_id: sessionId,
        uid: z.array(z.number().int()).min(1),
        from_folder: z.string(),
        to_folder: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'mail_move',
      async (args: { session_id: string; uid: number[]; from_folder: string; to_folder: string }) =>
        serviceOf(args.session_id).move(args.uid, args.from_folder, args.to_folder),
    ),
  );

  server.registerTool(
    'mail_delete',
    {
      title: '删除邮件',
      description:
        '默认把邮件移入废纸篓（可恢复）。permanent 为 true 时直接永久删除，无法撤销。',
      inputSchema: {
        session_id: sessionId,
        uid: z.array(z.number().int()).min(1),
        folder,
        permanent: z.boolean().optional().describe('默认 false，即移入废纸篓'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(
      logger,
      'mail_delete',
      async (args: { session_id: string; uid: number[]; folder?: string; permanent?: boolean }) =>
        serviceOf(args.session_id).remove(args.uid, args.folder, args.permanent),
    ),
  );
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/unit/modules/mail-tools.test.ts && npx tsc --noEmit`
Expected: 6 passed

- [ ] **Step 7: 提交**

```bash
git add src/server/types.ts src/server/wrap.ts src/modules/mail/tools.ts tests/unit/modules/mail-tools.test.ts
git commit -m "feat(mail): expose mail tools with annotations and error wrapping"
```

---
### Task 14: 日历服务层（整条序列的读写）

先做整条序列的增删改查；重复事件的"只改这一次"在 Task 15 单独处理。

**Files:**
- Modify: `src/core/ids.ts`（新增 `encodeUrl` / `decodeUrl`）
- Modify: `src/parsers/ical.ts`（新增 `readEventMeta`）
- Modify: `tests/unit/core/ids.test.ts`
- Create: `src/modules/calendar/service.ts`
- Test: `tests/unit/modules/calendar-service.test.ts`

**Interfaces:**
- Consumes: `CalDavProvider` (Task 10)、`parseCalendarObject`/`buildCalendarObject`/`CalendarEvent`/`EventInput` (Task 7)、`encodeRef`/`decodeRef` (Task 5)、`AccountConfig` (Task 4)
- Produces（`src/core/ids.ts` 追加）:
  - `function encodeUrl(url: string): string`
  - `function decodeUrl(id: string): string`
- Produces（`src/parsers/ical.ts` 追加）:
  - `function readEventMeta(icsText: string): { uid: string; sequence: number }`
- Produces（`src/modules/calendar/service.ts`）:
  - `interface CalendarSummary { calendar_id: string; name: string; color?: string; writable: boolean }`
  - `interface ListEventsParams { start: string; end: string; calendar_ids?: string[]; expand_recurring?: boolean }`
  - `interface UpdateOptions { expected_etag?: string }`
  - `interface CalendarService { listCalendars(): Promise<CalendarSummary[]>; listEvents(params: ListEventsParams): Promise<CalendarEvent[]>; createEvent(input: EventInput, calendarId?: string): Promise<CalendarEvent>; updateEvent(eventId: string, patch: Partial<EventInput>, options?: UpdateOptions): Promise<CalendarEvent>; deleteEvent(eventId: string, options?: UpdateOptions): Promise<{ deleted: true }> }`
  - `function createCalendarService(deps: { account: AccountConfig; caldav: CalDavProvider }): CalendarService`

- [ ] **Step 1: 给 `tests/unit/core/ids.test.ts` 追加 URL 编解码测试**

```ts
import { encodeUrl, decodeUrl } from '../../../src/core/ids.js';

describe('calendar url ids', () => {
  const url = 'https://p01-caldav.icloud.com/12345/calendars/home/';

  it('round-trips a calendar url', () => {
    expect(decodeUrl(encodeUrl(url))).toBe(url);
  });

  it('rejects an id that does not decode to a url', () => {
    expect(() => decodeUrl(Buffer.from('nope').toString('base64url'))).toThrowError(AppError);
  });
});
```

- [ ] **Step 2: 在 `src/core/ids.ts` 追加实现**

```ts
export function encodeUrl(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeUrl(id: string): string {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  if (!decoded.startsWith('http')) {
    throw new AppError('INVALID_INPUT', 'calendar_id 格式不正确', {
      hint: '请使用 calendar_list 返回的 calendar_id 原值',
    });
  }
  return decoded;
}
```

- [ ] **Step 3: 给 `tests/unit/parsers/ical.test.ts` 追加元信息读取测试**

```ts
import { readEventMeta } from '../../../src/parsers/ical.js';

describe('readEventMeta', () => {
  it('reads the uid and defaults the sequence to zero', () => {
    expect(readEventMeta(fixture('all-day.ics'))).toEqual({ uid: 'allday-001', sequence: 0 });
  });

  it('reads an explicit sequence', () => {
    const { ics } = buildCalendarObject(
      { title: 'x', start: '2026-09-10T02:00:00.000Z', end: '2026-09-10T03:00:00.000Z' },
      { uid: 'u1', sequence: 4 },
    );
    expect(readEventMeta(ics)).toEqual({ uid: 'u1', sequence: 5 });
  });
});
```

- [ ] **Step 4: 在 `src/parsers/ical.ts` 追加实现**

```ts
export function readEventMeta(icsText: string): { uid: string; sequence: number } {
  const root = parseRoot(icsText);
  const vevent = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
  if (!vevent) {
    throw new AppError('UPSTREAM_ERROR', '日历数据中没有可识别的事件');
  }
  const uid = vevent.getFirstPropertyValue('uid');
  const sequence = vevent.getFirstPropertyValue('sequence');
  return {
    uid: String(uid ?? ''),
    sequence: Number(sequence ?? 0),
  };
}
```

- [ ] **Step 5: 写失败测试 `tests/unit/modules/calendar-service.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCalendarService } from '../../../src/modules/calendar/service.js';
import { encodeRef, encodeUrl } from '../../../src/core/ids.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { CalDavProvider } from '../../../src/providers/icloud/caldav.js';

const HOME = 'https://caldav.icloud.com/1/calendars/home/';
const WORK = 'https://caldav.icloud.com/1/calendars/work/';
const EVENT_URL = `${HOME}timed-001.ics`;

const timedIcs = readFileSync(join(process.cwd(), 'tests/fixtures/calendar/timed-shanghai.ics'), 'utf8');

function makeAccount(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
    email: 'me@icloud.com',
    sender: 'me@icloud.com',
    label: 'me@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    capabilities: {
      mailRead: true,
      mailWrite: true,
      calendarRead: true,
      calendarWrite: true,
      remindersRead: true,
      remindersWrite: true,
      contactsRead: true,
      contactsWrite: true,
      ...overrides,
    },
  };
}

function makeCalDav(overrides: Partial<CalDavProvider> = {}): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi.fn().mockResolvedValue([
      { url: HOME, name: '个人', color: '#FF0000', readOnly: false, components: ['VEVENT'] },
      { url: WORK, name: '工作', readOnly: true, components: ['VEVENT'] },
      { url: `${HOME}todo/`, name: '提醒', readOnly: false, components: ['VTODO'] },
    ]),
    fetchObjects: vi.fn().mockResolvedValue([
      { collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: timedIcs },
    ]),
    fetchOne: vi.fn().mockResolvedValue({
      collectionUrl: HOME,
      url: EVENT_URL,
      etag: 'etag-1',
      data: timedIcs,
    }),
    create: vi.fn().mockImplementation(async (calendarUrl: string, filename: string, ics: string) => ({
      collectionUrl: calendarUrl,
      url: `${calendarUrl}${filename}`,
      etag: 'etag-new',
      data: ics,
    })),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const range = { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' };

describe('CalendarService permissions', () => {
  it('refuses to list events when calendar read is off', async () => {
    const service = createCalendarService({
      account: makeAccount({ calendarRead: false }),
      caldav: makeCalDav(),
    });
    await expect(service.listEvents(range)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to create when calendar write is off', async () => {
    const service = createCalendarService({
      account: makeAccount({ calendarWrite: false }),
      caldav: makeCalDav(),
    });
    await expect(
      service.createEvent({ title: 'x', start: range.start, end: range.end }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('CalendarService.listCalendars', () => {
  it('returns only VEVENT calendars with opaque ids', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    const calendars = await service.listCalendars();
    expect(calendars).toHaveLength(2);
    expect(calendars[0]).toEqual({
      calendar_id: encodeUrl(HOME),
      name: '个人',
      color: '#FF0000',
      writable: true,
    });
    expect(calendars[1]!.writable).toBe(false);
  });
});

describe('CalendarService.listEvents', () => {
  it('queries every VEVENT calendar within the range', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.listEvents(range);
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(2);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(HOME, {
      start: new Date(range.start),
      end: new Date(range.end),
    });
  });

  it('restricts the query when calendar_ids is given', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.listEvents({ ...range, calendar_ids: [encodeUrl(WORK)] });
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(1);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(WORK, expect.anything());
  });

  it('returns parsed events sorted by start time', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    const events = await service.listEvents(range);
    expect(events[0]!.title).toBe('项目评审');
    expect(events[0]!.start).toBe('2026-08-17T06:00:00.000Z');
    expect(events[0]!.event_id).toBe(encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL }));
  });

  it('rejects a range whose end precedes its start', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(
      service.listEvents({ start: range.end, end: range.start }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('CalendarService.createEvent', () => {
  it('writes to the first writable VEVENT calendar by default', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    const event = await service.createEvent({
      title: '新会议',
      start: '2026-09-10T02:00:00Z',
      end: '2026-09-10T03:00:00Z',
    });
    expect(caldav.create).toHaveBeenCalledWith(HOME, expect.stringMatching(/\.ics$/), expect.stringContaining('SUMMARY:新会议'));
    expect(event.title).toBe('新会议');
  });

  it('honours an explicit calendar_id', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.createEvent(
      { title: 'x', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
      encodeUrl(WORK),
    );
    expect(caldav.create).toHaveBeenCalledWith(WORK, expect.anything(), expect.anything());
  });

  it('rejects an end that is not after the start', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(
      service.createEvent({ title: 'x', start: '2026-09-10T03:00:00Z', end: '2026-09-10T02:00:00Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('CalendarService.updateEvent', () => {
  const eventId = encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL });

  it('merges the patch onto the existing event and bumps the sequence', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.updateEvent(eventId, { title: '改期后的评审' });

    const call = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.url).toBe(EVENT_URL);
    expect(call.etag).toBe('etag-1');
    expect(call.data).toContain('SUMMARY:改期后的评审');
    expect(call.data).toContain('UID:timed-001');
    expect(call.data).toContain('SEQUENCE:1');
  });

  it('keeps untouched fields intact', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.updateEvent(eventId, { location: '会议室 B' });
    const call = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.data).toContain('SUMMARY:项目评审');
    expect(call.data).toContain('LOCATION:会议室 B');
  });

  it('raises CONFLICT when expected_etag does not match', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(
      service.updateEvent(eventId, { title: 'x' }, { expected_etag: 'stale' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a malformed event_id before touching the network', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await expect(service.updateEvent('garbage', { title: 'x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(caldav.fetchOne).not.toHaveBeenCalled();
  });
});

describe('CalendarService.deleteEvent', () => {
  it('deletes with the current etag', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    const result = await service.deleteEvent(encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL }));
    expect(caldav.remove).toHaveBeenCalledWith({ url: EVENT_URL, etag: 'etag-1' });
    expect(result).toEqual({ deleted: true });
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/unit/modules/calendar-service.test.ts`
Expected: FAIL，无法解析 `src/modules/calendar/service.js`

- [ ] **Step 7: 实现 `src/modules/calendar/service.ts`**

```ts
import { AppError } from '../../core/errors.js';
import { decodeRef, decodeUrl, encodeRef, encodeUrl } from '../../core/ids.js';
import type { AccountConfig } from '../../core/config.js';
import {
  buildCalendarObject,
  parseCalendarObject,
  readEventMeta,
  type CalendarEvent,
  type EventInput,
} from '../../parsers/ical.js';
import type { CalDavProvider } from '../../providers/icloud/caldav.js';

const MAX_EVENTS = 1000;

export interface CalendarSummary {
  calendar_id: string;
  name: string;
  color?: string;
  writable: boolean;
}

export interface ListEventsParams {
  start: string;
  end: string;
  calendar_ids?: string[];
  expand_recurring?: boolean;
}

export interface UpdateOptions {
  expected_etag?: string;
}

export interface CalendarService {
  listCalendars(): Promise<CalendarSummary[]>;
  listEvents(params: ListEventsParams): Promise<CalendarEvent[]>;
  createEvent(input: EventInput, calendarId?: string): Promise<CalendarEvent>;
  updateEvent(eventId: string, patch: Partial<EventInput>, options?: UpdateOptions): Promise<CalendarEvent>;
  deleteEvent(eventId: string, options?: UpdateOptions): Promise<{ deleted: true }>;
}

export interface CalendarServiceDeps {
  account: AccountConfig;
  caldav: CalDavProvider;
}

function parseRange(start: string, end: string): { start: Date; end: Date } {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('INVALID_INPUT', 'start / end 必须是 ISO 8601 时间', {
      hint: '例如 2026-09-01T00:00:00Z',
    });
  }
  if (to <= from) {
    throw new AppError('INVALID_INPUT', 'end 必须晚于 start');
  }
  return { start: from, end: to };
}

/** CalendarEvent → EventInput，用于把补丁合并到既有事件上。 */
function toInput(event: CalendarEvent): EventInput {
  const input: EventInput = {
    title: event.title,
    start: event.start,
    end: event.end,
    all_day: event.all_day,
  };
  if (event.timezone) input.timezone = event.timezone;
  if (event.location) input.location = event.location;
  if (event.description) input.description = event.description;
  if (event.url) input.url = event.url;
  if (event.recurrence) input.recurrence = event.recurrence;
  if (event.alarms.length > 0) input.alarms = event.alarms;
  return input;
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const { account, caldav } = deps;
  const suffix = account.id.split('_')[1];

  const requireRead = (): void => {
    if (!account.capabilities.calendarRead) {
      throw new AppError('PERMISSION_DENIED', '该账号的日历读取权限未开启', {
        hint: `设置环境变量 ALLOW_CALENDAR_READ_${suffix}=true 后重启服务`,
      });
    }
  };

  const requireWrite = (): void => {
    if (!account.capabilities.calendarWrite) {
      throw new AppError('PERMISSION_DENIED', '该账号的日历写入权限未开启', {
        hint: `设置环境变量 ALLOW_CALENDAR_WRITE_${suffix}=true 后重启服务`,
      });
    }
  };

  const eventCalendars = async () => {
    const calendars = await caldav.listCalendars();
    return calendars.filter((c) => c.components.length === 0 || c.components.includes('VEVENT'));
  };

  /** 读回当前状态并校验乐观锁，写操作前统一走这里。 */
  const loadForWrite = async (eventId: string, expectedEtag?: string) => {
    const ref = decodeRef(eventId);
    const current = await caldav.fetchOne(ref.collectionUrl, ref.resourceUrl);
    if (expectedEtag !== undefined && current.etag !== expectedEtag) {
      throw new AppError('CONFLICT', '该事件已被其他客户端修改', {
        hint: '重新调用 calendar_list_events 读取最新状态后再提交',
      });
    }
    return { ref, current };
  };

  return {
    async listCalendars() {
      requireRead();
      const calendars = await eventCalendars();
      return calendars.map((cal) => {
        const summary: CalendarSummary = {
          calendar_id: encodeUrl(cal.url),
          name: cal.name,
          writable: !cal.readOnly,
        };
        if (cal.color) summary.color = cal.color;
        return summary;
      });
    },

    async listEvents(params) {
      requireRead();
      const range = parseRange(params.start, params.end);
      const wanted = params.calendar_ids?.map(decodeUrl);
      const calendars = (await eventCalendars()).filter(
        (cal) => !wanted || wanted.includes(cal.url),
      );

      const events: CalendarEvent[] = [];
      for (const calendar of calendars) {
        const objects = await caldav.fetchObjects(calendar.url, range);
        for (const object of objects) {
          events.push(
            ...parseCalendarObject(
              object.data,
              { collectionUrl: object.collectionUrl, resourceUrl: object.url },
              {
                rangeStart: range.start,
                rangeEnd: range.end,
                expandRecurring: params.expand_recurring !== false,
              },
            ),
          );
        }
      }

      return events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_EVENTS);
    },

    async createEvent(input, calendarId) {
      requireWrite();
      parseRange(input.start, input.end);

      const calendars = await eventCalendars();
      const target = calendarId
        ? calendars.find((c) => c.url === decodeUrl(calendarId))
        : calendars.find((c) => !c.readOnly);

      if (!target) {
        throw new AppError('NOT_FOUND', '找不到可写入的日历', {
          hint: '调用 calendar_list 查看可用日历及其 writable 状态',
        });
      }

      const { ics, uid } = buildCalendarObject(input);
      const created = await caldav.create(target.url, `${uid}.ics`, ics);
      const [event] = parseCalendarObject(ics, {
        collectionUrl: created.collectionUrl,
        resourceUrl: created.url,
      });
      if (!event) throw new AppError('INTERNAL', '事件创建后无法回读');
      return event;
    },

    async updateEvent(eventId, patch, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(eventId, options.expected_etag);

      const [existing] = parseCalendarObject(current.data, ref);
      if (!existing) {
        throw new AppError('NOT_FOUND', '该事件已不存在');
      }

      const merged: EventInput = { ...toInput(existing), ...patch };
      parseRange(merged.start, merged.end);

      const meta = readEventMeta(current.data);
      const { ics } = buildCalendarObject(merged, meta);
      await caldav.update({
        collectionUrl: ref.collectionUrl,
        url: ref.resourceUrl,
        etag: current.etag,
        data: ics,
      });

      const [updated] = parseCalendarObject(ics, ref);
      if (!updated) throw new AppError('INTERNAL', '事件更新后无法回读');
      return updated;
    },

    async deleteEvent(eventId, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(eventId, options.expected_etag);
      await caldav.remove({ url: ref.resourceUrl, etag: current.etag });
      return { deleted: true };
    },
  };
}
```

- [ ] **Step 8: 运行全部测试确认通过**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（含 Task 14 新增的 15 个用例）

- [ ] **Step 9: 提交**

```bash
git add src/core/ids.ts src/parsers/ical.ts src/modules/calendar/service.ts tests/unit
git commit -m "feat(calendar): add calendar service with optimistic locking"
```

---

### Task 15: 重复事件的单次修改

`scope: 'this'` 需要在 iCal 层做两件事：删除单次 = 加 `EXDATE`；修改单次 = 追加带 `RECURRENCE-ID` 的覆盖 VEVENT。

**Files:**
- Modify: `src/parsers/ical.ts`
- Modify: `src/modules/calendar/service.ts`
- Test: `tests/unit/parsers/ical-scope.test.ts`
- Test: `tests/unit/modules/calendar-scope.test.ts`

**Interfaces:**
- Consumes: Task 14 的全部产出
- Produces（`src/parsers/ical.ts` 追加）:
  - `function addExdate(icsText: string, recurrenceId: string): string`
  - `function upsertOverride(icsText: string, recurrenceId: string, input: EventInput): string`
- Produces（`src/modules/calendar/service.ts` 变更）:
  - `interface UpdateOptions { expected_etag?: string; scope?: 'this' | 'all'; recurrence_id?: string }`
  - `updateEvent` 与 `deleteEvent` 接受上述 options

- [ ] **Step 1: 写失败测试 `tests/unit/parsers/ical-scope.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addExdate, upsertOverride, parseCalendarObject } from '../../../src/parsers/ical.js';

const ref = {
  collectionUrl: 'https://caldav.icloud.com/1/calendars/home/',
  resourceUrl: 'https://caldav.icloud.com/1/calendars/home/weekly-001.ics',
};

const weekly = readFileSync(
  join(process.cwd(), 'tests/fixtures/calendar/weekly-with-exdate.ics'),
  'utf8',
);

const range = {
  rangeStart: new Date('2026-08-01T00:00:00Z'),
  rangeEnd: new Date('2026-09-01T00:00:00Z'),
  expandRecurring: true,
};

describe('addExdate', () => {
  it('removes one occurrence from the expanded series', () => {
    const updated = addExdate(weekly, '2026-08-17T09:00:00.000Z');
    const starts = parseCalendarObject(updated, ref, range).map((e) => e.start);
    expect(starts).toEqual(['2026-08-03T09:00:00.000Z', '2026-08-24T09:00:00.000Z']);
  });

  it('keeps the pre-existing EXDATE', () => {
    const updated = addExdate(weekly, '2026-08-17T09:00:00.000Z');
    expect(updated).toContain('20260810T090000Z');
  });

  it('is idempotent for the same occurrence', () => {
    const once = addExdate(weekly, '2026-08-17T09:00:00.000Z');
    const twice = addExdate(once, '2026-08-17T09:00:00.000Z');
    const starts = parseCalendarObject(twice, ref, range).map((e) => e.start);
    expect(starts).toHaveLength(2);
  });
});

describe('upsertOverride', () => {
  it('changes only the targeted occurrence', () => {
    const updated = upsertOverride(weekly, '2026-08-17T09:00:00.000Z', {
      title: '临时改到下午',
      start: '2026-08-17T14:00:00.000Z',
      end: '2026-08-17T15:00:00.000Z',
    });
    const events = parseCalendarObject(updated, ref, range);
    const changed = events.find((e) => e.start === '2026-08-17T14:00:00.000Z');
    expect(changed?.title).toBe('临时改到下午');
    expect(events.find((e) => e.start === '2026-08-03T09:00:00.000Z')?.title).toBe('周会');
  });

  it('reuses the series uid for the override', () => {
    const updated = upsertOverride(weekly, '2026-08-17T09:00:00.000Z', {
      title: 'x',
      start: '2026-08-17T14:00:00.000Z',
      end: '2026-08-17T15:00:00.000Z',
    });
    expect(updated.match(/UID:weekly-001/g)).toHaveLength(2);
    expect(updated).toContain('RECURRENCE-ID');
  });

  it('replaces an existing override instead of appending a second one', () => {
    const once = upsertOverride(weekly, '2026-08-17T09:00:00.000Z', {
      title: '第一次改',
      start: '2026-08-17T14:00:00.000Z',
      end: '2026-08-17T15:00:00.000Z',
    });
    const twice = upsertOverride(once, '2026-08-17T09:00:00.000Z', {
      title: '第二次改',
      start: '2026-08-17T16:00:00.000Z',
      end: '2026-08-17T17:00:00.000Z',
    });
    expect(twice.match(/RECURRENCE-ID/g)).toHaveLength(1);
    expect(twice).toContain('第二次改');
    expect(twice).not.toContain('第一次改');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/parsers/ical-scope.test.ts`
Expected: FAIL，`addExdate is not a function`

- [ ] **Step 3: 在 `src/parsers/ical.ts` 追加实现**

```ts
function findMaster(root: ICAL.Component): ICAL.Component {
  const master = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
  if (!master) throw new AppError('UPSTREAM_ERROR', '日历数据中没有可识别的重复事件');
  return master;
}

function sameInstant(a: ICAL.Time, isoTime: string): boolean {
  return a.toJSDate().getTime() === new Date(isoTime).getTime();
}

/** 从重复序列中排除单次发生。 */
export function addExdate(icsText: string, recurrenceId: string): string {
  const root = parseRoot(icsText);
  registerTimezones(root);
  const master = findMaster(root);

  const target = ICAL.Time.fromJSDate(new Date(recurrenceId), true);
  const already = master
    .getAllProperties('exdate')
    .some((p) => sameInstant(p.getFirstValue() as ICAL.Time, recurrenceId));
  if (already) return root.toString();

  master.addPropertyWithValue('exdate', target);
  return root.toString();
}

/** 新增或替换某次发生的覆盖事件（RECURRENCE-ID）。 */
export function upsertOverride(icsText: string, recurrenceId: string, input: EventInput): string {
  const root = parseRoot(icsText);
  registerTimezones(root);
  const master = findMaster(root);
  const uid = String(master.getFirstPropertyValue('uid') ?? '');

  for (const candidate of root.getAllSubcomponents('vevent')) {
    const rid = candidate.getFirstPropertyValue('recurrence-id');
    if (rid && sameInstant(rid as ICAL.Time, recurrenceId)) {
      root.removeSubcomponent(candidate);
    }
  }

  const allDay = input.all_day === true;
  const override = new ICAL.Component(['vevent', [], []]);
  override.addPropertyWithValue('uid', uid);
  override.addPropertyWithValue('recurrence-id', ICAL.Time.fromJSDate(new Date(recurrenceId), true));
  override.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  override.addPropertyWithValue('sequence', '0');
  override.addPropertyWithValue('summary', input.title);
  override.addPropertyWithValue('dtstart', toIcalTime(input.start, allDay));
  override.addPropertyWithValue('dtend', toIcalTime(input.end, allDay));
  if (input.location) override.addPropertyWithValue('location', input.location);
  if (input.description) override.addPropertyWithValue('description', input.description);

  root.addSubcomponent(override);
  return root.toString();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/parsers/ical-scope.test.ts`
Expected: 6 passed

- [ ] **Step 5: 写服务层失败测试 `tests/unit/modules/calendar-scope.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCalendarService } from '../../../src/modules/calendar/service.js';
import { encodeRef } from '../../../src/core/ids.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { CalDavProvider } from '../../../src/providers/icloud/caldav.js';

const HOME = 'https://caldav.icloud.com/1/calendars/home/';
const EVENT_URL = `${HOME}weekly-001.ics`;
const eventId = encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL });

const weekly = readFileSync(
  join(process.cwd(), 'tests/fixtures/calendar/weekly-with-exdate.ics'),
  'utf8',
);

const account: AccountConfig = {
  id: 'account_1',
  email: 'me@icloud.com',
  sender: 'me@icloud.com',
  label: 'me@icloud.com',
  appPassword: 'abcd-efgh-ijkl-mnop',
  capabilities: {
    mailRead: true,
    mailWrite: true,
    calendarRead: true,
    calendarWrite: true,
    remindersRead: true,
    remindersWrite: true,
    contactsRead: true,
    contactsWrite: true,
  },
};

function makeCalDav(): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi
      .fn()
      .mockResolvedValue([{ url: HOME, name: '个人', readOnly: false, components: ['VEVENT'] }]),
    fetchObjects: vi.fn().mockResolvedValue([]),
    fetchOne: vi
      .fn()
      .mockResolvedValue({ collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: weekly }),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('single-occurrence scope', () => {
  it('adds an EXDATE instead of deleting the series', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    await service.deleteEvent(eventId, { scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' });

    expect(caldav.remove).not.toHaveBeenCalled();
    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('20260817T090000Z');
    expect(written).toContain('RRULE');
  });

  it('writes an override when updating a single occurrence', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    await service.updateEvent(
      eventId,
      { title: '这次改到下午', start: '2026-08-17T14:00:00.000Z', end: '2026-08-17T15:00:00.000Z' },
      { scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' },
    );

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('RECURRENCE-ID');
    expect(written).toContain('这次改到下午');
  });

  it('requires recurrence_id when scope is this', async () => {
    const service = createCalendarService({ account, caldav: makeCalDav() });
    await expect(
      service.updateEvent(eventId, { title: 'x' }, { scope: 'this' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('still deletes the whole series when scope is all', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    await service.deleteEvent(eventId);
    expect(caldav.remove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/unit/modules/calendar-scope.test.ts`
Expected: FAIL，`scope: 'this'` 时仍然走整条序列的路径

- [ ] **Step 7: 修改 `src/modules/calendar/service.ts`**

在 import 中加入 `addExdate` 与 `upsertOverride`，扩展 `UpdateOptions`，并在两个写方法开头分流：

```ts
export interface UpdateOptions {
  expected_etag?: string;
  scope?: 'this' | 'all';
  recurrence_id?: string;
}

// createCalendarService 内部新增：
  const requireRecurrenceId = (options: UpdateOptions): string => {
    if (!options.recurrence_id) {
      throw new AppError('INVALID_INPUT', 'scope 为 this 时必须提供 recurrence_id', {
        hint: 'recurrence_id 取自 calendar_list_events 展开后的事件对象',
      });
    }
    return options.recurrence_id;
  };

// updateEvent 内，loadForWrite 之后、合并补丁之前：
      if (options.scope === 'this') {
        const recurrenceId = requireRecurrenceId(options);
        const [existingSeries] = parseCalendarObject(current.data, ref);
        if (!existingSeries) throw new AppError('NOT_FOUND', '该事件已不存在');
        const overrideInput: EventInput = {
          ...toInput(existingSeries),
          start: recurrenceId,
          end: existingSeries.end,
          ...patch,
        };
        const data = upsertOverride(current.data, recurrenceId, overrideInput);
        await caldav.update({
          collectionUrl: ref.collectionUrl,
          url: ref.resourceUrl,
          etag: current.etag,
          data,
        });
        const [updated] = parseCalendarObject(data, ref);
        if (!updated) throw new AppError('INTERNAL', '事件更新后无法回读');
        return updated;
      }

// deleteEvent 内，loadForWrite 之后：
      if (options.scope === 'this') {
        const recurrenceId = requireRecurrenceId(options);
        const data = addExdate(current.data, recurrenceId);
        await caldav.update({
          collectionUrl: ref.collectionUrl,
          url: ref.resourceUrl,
          etag: current.etag,
          data,
        });
        return { deleted: true };
      }
```

- [ ] **Step 8: 运行全部测试确认通过**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿

- [ ] **Step 9: 提交**

```bash
git add src/parsers/ical.ts src/modules/calendar/service.ts tests/unit
git commit -m "feat(calendar): support single-occurrence edits and deletions"
```

---

### Task 16: 日历工具层

**Files:**
- Create: `src/modules/calendar/tools.ts`
- Test: `tests/unit/modules/calendar-tools.test.ts`

**Interfaces:**
- Consumes: `CalendarService` (Task 14/15)、`ToolRegistrar`/`ToolDeps` (Task 13)、`wrapTool` (Task 13)、`Session` (Task 11)
- Produces:
  - `interface CalendarToolDeps extends ToolDeps { calendarFor: (session: Session) => CalendarService }`
  - `function registerCalendarTools(server: ToolRegistrar, deps: CalendarToolDeps): void`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerCalendarTools } from '../../../src/modules/calendar/tools.js';
import { createLogger } from '../../../src/core/logger.js';
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
  return { sessions: fakeSessions, logger: silentLogger, calendarFor: () => service as never };
}

describe('registerCalendarTools', () => {
  it('registers every calendar tool', () => {
    const { server, tools } = collect();
    registerCalendarTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'calendar_create_event',
      'calendar_delete_event',
      'calendar_list',
      'calendar_list_events',
      'calendar_update_event',
    ]);
  });

  it('marks deletion as destructive and listing as read-only', () => {
    const { server, tools } = collect();
    registerCalendarTools(server, depsWith({}));
    expect(tools.get('calendar_delete_event')!.config.annotations?.destructiveHint).toBe(true);
    expect(tools.get('calendar_list_events')!.config.annotations?.readOnlyHint).toBe(true);
  });

  it('does not expose calendar_url or etag as required inputs', () => {
    const { server, tools } = collect();
    registerCalendarTools(server, depsWith({}));
    const shape = tools.get('calendar_update_event')!.config.inputSchema as Record<string, z.ZodTypeAny>;
    expect(shape.calendar_url).toBeUndefined();
    expect(shape.event_id).toBeDefined();
    expect(shape.expected_etag!.isOptional()).toBe(true);
  });

  it('passes the structured event object straight through', async () => {
    const { server, tools } = collect();
    const createEvent = vi.fn().mockResolvedValue({ event_id: 'e1', title: '新会议' });
    registerCalendarTools(server, depsWith({ createEvent }));

    const result = await tools.get('calendar_create_event')!.handler({
      session_id: 's1',
      event: { title: '新会议', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
    });

    expect(createEvent).toHaveBeenCalledWith(
      { title: '新会议', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
      undefined,
    );
    expect(JSON.parse(result.content[0]!.text).title).toBe('新会议');
  });

  it('forwards scope and recurrence_id when updating', async () => {
    const { server, tools } = collect();
    const updateEvent = vi.fn().mockResolvedValue({ event_id: 'e1' });
    registerCalendarTools(server, depsWith({ updateEvent }));

    await tools.get('calendar_update_event')!.handler({
      session_id: 's1',
      event_id: 'e1',
      patch: { title: '改了' },
      scope: 'this',
      recurrence_id: '2026-08-17T09:00:00.000Z',
    });

    expect(updateEvent).toHaveBeenCalledWith(
      'e1',
      { title: '改了' },
      { expected_etag: undefined, scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' },
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/modules/calendar-tools.test.ts`
Expected: FAIL，无法解析 `src/modules/calendar/tools.js`

- [ ] **Step 3: 实现 `src/modules/calendar/tools.ts`**

```ts
import { z } from 'zod';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';
import type { Session } from '../../core/session.js';
import type { CalendarService } from './service.js';

export interface CalendarToolDeps extends ToolDeps {
  calendarFor: (session: Session) => CalendarService;
}

const sessionId = z.string().describe('apple_login 返回的 session_id');

const recurrenceSchema = z
  .object({
    freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).optional(),
    count: z.number().int().min(1).optional(),
    until: z.string().optional().describe('ISO 8601 时间'),
    byday: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
    bymonthday: z.array(z.number().int().min(1).max(31)).optional(),
  })
  .optional();

const alarmsSchema = z
  .array(
    z.object({
      minutes_before: z.number().int().min(0),
      action: z.enum(['display', 'email']),
    }),
  )
  .optional();

const eventShape = {
  title: z.string(),
  start: z.string().describe('ISO 8601 时间，例如 2026-09-10T14:00:00+08:00'),
  end: z.string().describe('ISO 8601 时间，必须晚于 start'),
  all_day: z.boolean().optional(),
  timezone: z.string().optional().describe('IANA 时区名，例如 Asia/Shanghai'),
  location: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  recurrence: recurrenceSchema,
  alarms: alarmsSchema,
};

const eventSchema = z.object(eventShape);
const patchSchema = z.object(eventShape).partial();

export function registerCalendarTools(server: ToolRegistrar, deps: CalendarToolDeps): void {
  const { sessions, logger, calendarFor } = deps;
  const serviceOf = (sessionId_: string): CalendarService => calendarFor(sessions.get(sessionId_));

  server.registerTool(
    'calendar_list',
    {
      title: '列出日历',
      description: '返回所有可用日历及其是否可写。calendar_id 是不透明字符串，供其他日历工具使用。',
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'calendar_list', async (args: { session_id: string }) =>
      serviceOf(args.session_id).listCalendars(),
    ),
  );

  server.registerTool(
    'calendar_list_events',
    {
      title: '查询日程',
      description:
        '按时间范围查询日程，返回结构化事件。重复事件默认展开为具体发生实例，每个实例带 recurrence_id。',
      inputSchema: {
        session_id: sessionId,
        start: z.string().describe('范围起点，ISO 8601'),
        end: z.string().describe('范围终点，ISO 8601'),
        calendar_ids: z.array(z.string()).optional().describe('留空则查询全部日历'),
        expand_recurring: z.boolean().optional().describe('默认 true'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'calendar_list_events',
      async (args: {
        session_id: string;
        start: string;
        end: string;
        calendar_ids?: string[];
        expand_recurring?: boolean;
      }) =>
        serviceOf(args.session_id).listEvents({
          start: args.start,
          end: args.end,
          calendar_ids: args.calendar_ids,
          expand_recurring: args.expand_recurring,
        }),
    ),
  );

  server.registerTool(
    'calendar_create_event',
    {
      title: '创建日程',
      description: '用结构化字段创建日程，无需手写 iCal。calendar_id 留空则写入第一个可写日历。',
      inputSchema: {
        session_id: sessionId,
        calendar_id: z.string().optional(),
        event: eventSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'calendar_create_event',
      async (args: { session_id: string; calendar_id?: string; event: z.infer<typeof eventSchema> }) =>
        serviceOf(args.session_id).createEvent(args.event, args.calendar_id),
    ),
  );

  server.registerTool(
    'calendar_update_event',
    {
      title: '修改日程',
      description:
        '按 event_id 修改日程，patch 中只写需要变更的字段。重复事件默认改整条序列；scope 为 this 时只改 recurrence_id 指定的那一次。',
      inputSchema: {
        session_id: sessionId,
        event_id: z.string().describe('calendar_list_events 返回的 event_id'),
        patch: patchSchema,
        scope: z.enum(['this', 'all']).optional().describe('默认 all'),
        recurrence_id: z.string().optional().describe('scope 为 this 时必填'),
        expected_etag: z.string().optional().describe('乐观锁，可留空'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'calendar_update_event',
      async (args: {
        session_id: string;
        event_id: string;
        patch: z.infer<typeof patchSchema>;
        scope?: 'this' | 'all';
        recurrence_id?: string;
        expected_etag?: string;
      }) =>
        serviceOf(args.session_id).updateEvent(args.event_id, args.patch, {
          expected_etag: args.expected_etag,
          scope: args.scope,
          recurrence_id: args.recurrence_id,
        }),
    ),
  );

  server.registerTool(
    'calendar_delete_event',
    {
      title: '删除日程',
      description:
        '删除日程，无法撤销。重复事件默认删除整条序列；scope 为 this 时只删除 recurrence_id 指定的那一次。',
      inputSchema: {
        session_id: sessionId,
        event_id: z.string(),
        scope: z.enum(['this', 'all']).optional().describe('默认 all'),
        recurrence_id: z.string().optional().describe('scope 为 this 时必填'),
        expected_etag: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(
      logger,
      'calendar_delete_event',
      async (args: {
        session_id: string;
        event_id: string;
        scope?: 'this' | 'all';
        recurrence_id?: string;
        expected_etag?: string;
      }) =>
        serviceOf(args.session_id).deleteEvent(args.event_id, {
          expected_etag: args.expected_etag,
          scope: args.scope,
          recurrence_id: args.recurrence_id,
        }),
    ),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/modules/calendar-tools.test.ts && npx tsc --noEmit`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/modules/calendar/tools.ts tests/unit/modules/calendar-tools.test.ts
git commit -m "feat(calendar): expose calendar tools with structured schemas"
```

---
### Task 17: 会话工具（真正验证凭据）

旧版 `apple_login` 只查配置里有没有这个邮箱就发 sessionId，凭据是错的也要等到第一次真正调用工具才暴露。新版必须真连一次。

**Files:**
- Create: `src/modules/session/tools.ts`
- Test: `tests/unit/modules/session-tools.test.ts`

**Interfaces:**
- Consumes: `AppConfig`/`findAccount` (Task 4)、`SessionStore` (Task 11)、`ToolRegistrar`/`ToolDeps`/`wrapTool` (Task 13)
- Produces:
  - `interface SessionToolDeps extends ToolDeps { config: AppConfig }`
  - `function registerSessionTools(server: ToolRegistrar, deps: SessionToolDeps): void`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerSessionTools } from '../../../src/modules/session/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { loadConfig } from '../../../src/core/config.js';
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

const config = loadConfig({
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
  ICLOUD_LABEL_1: 'personal',
  ALLOW_MAIL_WRITE_1: 'true',
});

function makeSessions(providers: Record<string, unknown>) {
  const destroy = vi.fn().mockResolvedValue(true);
  const store = {
    create: vi.fn().mockReturnValue({
      id: 'session-abc',
      account: config.accounts[0],
      providers,
    }),
    get: vi.fn(),
    destroy,
    destroyAll: vi.fn(),
    sweep: vi.fn(),
    size: vi.fn().mockReturnValue(1),
  } as unknown as SessionStore;
  return { store, destroy };
}

function healthyProviders() {
  return {
    imap: { verify: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) },
    caldav: { verify: vi.fn().mockResolvedValue(undefined) },
    smtp: {},
  };
}

describe('apple_accounts', () => {
  it('lists configured accounts without requiring a session', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const shape = tools.get('apple_accounts')!.config.inputSchema;
    expect(Object.keys(shape)).toHaveLength(0);

    const result = await tools.get('apple_accounts')!.handler({});
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      {
        email: 'me@icloud.com',
        label: 'personal',
        capabilities: config.accounts[0]!.capabilities,
      },
    ]);
  });

  it('never exposes the app password', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });
    const result = await tools.get('apple_accounts')!.handler({});
    expect(result.content[0]!.text).not.toContain('abcd-efgh');
  });
});

describe('apple_login', () => {
  it('verifies imap and caldav before handing out a session id', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    const { store } = makeSessions(providers);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('apple_login')!.handler({});
    expect(providers.imap.verify).toHaveBeenCalled();
    expect(providers.caldav.verify).toHaveBeenCalled();

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.session_id).toBe('session-abc');
    expect(payload.account).toBe('me@icloud.com');
    expect(payload.label).toBe('personal');
    expect(payload.capabilities.mailWrite).toBe(true);
  });

  it('destroys the session and reports AUTH_FAILED when verification fails', async () => {
    const { server, tools } = collect();
    const providers = healthyProviders();
    providers.imap.verify = vi
      .fn()
      .mockRejectedValue(new AppError('AUTH_FAILED', 'iCloud 拒绝了这组凭据'));
    const { store, destroy } = makeSessions(providers);
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('apple_login')!.handler({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('AUTH_FAILED');
    expect(destroy).toHaveBeenCalledWith('session-abc');
  });

  it('reports NOT_FOUND for an unconfigured account', async () => {
    const { server, tools } = collect();
    const { store } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('apple_login')!.handler({ account: 'other@icloud.com' });
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('NOT_FOUND');
  });
});

describe('work_done', () => {
  it('destroys the session', async () => {
    const { server, tools } = collect();
    const { store, destroy } = makeSessions(healthyProviders());
    registerSessionTools(server, { sessions: store, logger: silentLogger, config });

    const result = await tools.get('work_done')!.handler({ session_id: 'session-abc' });
    expect(destroy).toHaveBeenCalledWith('session-abc');
    expect(JSON.parse(result.content[0]!.text)).toEqual({ success: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/modules/session-tools.test.ts`
Expected: FAIL，无法解析 `src/modules/session/tools.js`

- [ ] **Step 3: 实现 `src/modules/session/tools.ts`**

```ts
import { z } from 'zod';
import { findAccount, type AppConfig } from '../../core/config.js';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';

export interface SessionToolDeps extends ToolDeps {
  config: AppConfig;
}

export function registerSessionTools(server: ToolRegistrar, deps: SessionToolDeps): void {
  const { sessions, logger, config } = deps;

  server.registerTool(
    'apple_accounts',
    {
      title: '列出已配置的 iCloud 账号',
      description:
        '返回服务端配置的账号及其读写权限。无需登录即可调用，用于在多账号时确定 apple_login 的 account 参数。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'apple_accounts', async () =>
      config.accounts.map((account) => ({
        email: account.email,
        label: account.label,
        capabilities: account.capabilities,
      })),
    ),
  );

  server.registerTool(
    'apple_login',
    {
      title: '登录 iCloud',
      description:
        '建立会话并返回 session_id，后续所有工具都需要它。会真正连接一次 IMAP 与 CalDAV 验证凭据，因此凭据错误会在这一步立即暴露。单账号时 account 可省略。',
      inputSchema: {
        account: z.string().optional().describe('要登录的 iCloud 邮箱，单账号时可省略'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(logger, 'apple_login', async (args: { account?: string }) => {
      const account = findAccount(config, args.account);
      const session = sessions.create(account);

      try {
        await session.providers.imap.verify();
        await session.providers.caldav.verify();
      } catch (err) {
        await sessions.destroy(session.id);
        throw err;
      }

      logger.info('login ok', { account: account.email, session: session.id });
      return {
        session_id: session.id,
        account: account.email,
        label: account.label,
        capabilities: account.capabilities,
      };
    }),
  );

  server.registerTool(
    'work_done',
    {
      title: '结束会话',
      description:
        '销毁会话、关闭连接并清除内存中的凭据。完成全部 iCloud 相关任务后必须调用。',
      inputSchema: { session_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapTool(logger, 'work_done', async (args: { session_id: string }) => ({
      success: await sessions.destroy(args.session_id),
    })),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/modules/session-tools.test.ts && npx tsc --noEmit`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add src/modules/session tests/unit/modules/session-tools.test.ts
git commit -m "feat(session): verify credentials during apple_login"
```

---

### Task 18: 装配与 stdio 入口

**Files:**
- Create: `src/providers/icloud/index.ts`
- Create: `src/server/createServer.ts`
- Create: `src/bin/stdio.ts`
- Test: `tests/unit/server/register.test.ts`

**Interfaces:**
- Consumes: 前面所有任务的产出
- Produces:
  - `function createProviders(account: AccountConfig): SessionProviders`
  - `function registerAllTools(server: ToolRegistrar, deps: { config: AppConfig; sessions: SessionStore; logger: Logger }): void`
  - `function createServer(deps: { config: AppConfig; sessions: SessionStore; logger: Logger }): McpServer`

能力开关决定注册哪些工具：只要有任一账号开了邮件读或写，就注册邮件工具；日历同理。

- [ ] **Step 1: 写失败测试 `tests/unit/server/register.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerAllTools } from '../../../src/server/createServer.js';
import { loadConfig } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';
import type { SessionStore } from '../../../src/core/session.js';

function collect() {
  const names: string[] = [];
  const server = {
    registerTool(name: string, _config: ToolConfig, _handler: (args: any) => Promise<ToolResult>) {
      names.push(name);
    },
  };
  return { server, names };
}

const logger = createLogger('error', () => {});
const sessions = { get: vi.fn(), create: vi.fn(), destroy: vi.fn() } as unknown as SessionStore;

const base = {
  ICLOUD_ACCOUNT_1: 'me@icloud.com',
  ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop',
};

describe('registerAllTools', () => {
  it('always registers the session tools', () => {
    const { server, names } = collect();
    registerAllTools(server, { config: loadConfig(base), sessions, logger });
    expect(names).toContain('apple_login');
    expect(names).toContain('apple_accounts');
    expect(names).toContain('work_done');
  });

  it('registers mail and calendar tools when both are readable', () => {
    const { server, names } = collect();
    registerAllTools(server, { config: loadConfig(base), sessions, logger });
    expect(names).toContain('mail_search');
    expect(names).toContain('calendar_list_events');
  });

  it('omits mail tools entirely when every account has mail disabled', () => {
    const { server, names } = collect();
    const config = loadConfig({ ...base, ALLOW_MAIL_READ_1: 'false', ALLOW_MAIL_WRITE_1: 'false' });
    registerAllTools(server, { config, sessions, logger });
    expect(names.some((n) => n.startsWith('mail_'))).toBe(false);
    expect(names).toContain('calendar_list_events');
  });

  it('registers no duplicate tool names', () => {
    const { server, names } = collect();
    registerAllTools(server, { config: loadConfig(base), sessions, logger });
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/server/register.test.ts`
Expected: FAIL，无法解析 `src/server/createServer.js`

- [ ] **Step 3: 实现 `src/providers/icloud/index.ts`**

```ts
import { createImapProvider } from './imap.js';
import { createSmtpProvider } from './smtp.js';
import { createCalDavProvider } from './caldav.js';
import type { AccountConfig } from '../../core/config.js';
import type { SessionProviders } from '../../core/session.js';

/** 真实 provider 组装点。测试通过替换 providerFactory 绕开它。 */
export function createProviders(account: AccountConfig): SessionProviders {
  return {
    imap: createImapProvider(account),
    smtp: createSmtpProvider(account),
    caldav: createCalDavProvider(account),
  };
}
```

- [ ] **Step 4: 实现 `src/server/createServer.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMailService } from '../modules/mail/service.js';
import { createCalendarService } from '../modules/calendar/service.js';
import { registerMailTools } from '../modules/mail/tools.js';
import { registerCalendarTools } from '../modules/calendar/tools.js';
import { registerSessionTools } from '../modules/session/tools.js';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { Session, SessionStore } from '../core/session.js';
import type { ToolRegistrar } from './types.js';

export interface ServerDeps {
  config: AppConfig;
  sessions: SessionStore;
  logger: Logger;
}

export function registerAllTools(server: ToolRegistrar, deps: ServerDeps): void {
  const { config, sessions, logger } = deps;

  registerSessionTools(server, { sessions, logger, config });

  const anyMail = config.accounts.some(
    (a) => a.capabilities.mailRead || a.capabilities.mailWrite,
  );
  const anyCalendar = config.accounts.some(
    (a) => a.capabilities.calendarRead || a.capabilities.calendarWrite,
  );

  if (anyMail) {
    registerMailTools(server, {
      sessions,
      logger,
      mailFor: (session: Session) =>
        createMailService({
          account: session.account,
          imap: session.providers.imap,
          smtp: session.providers.smtp,
        }),
    });
  }

  if (anyCalendar) {
    registerCalendarTools(server, {
      sessions,
      logger,
      calendarFor: (session: Session) =>
        createCalendarService({ account: session.account, caldav: session.providers.caldav }),
    });
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'apple-icloud-mcp', version: '2.0.0' });
  registerAllTools(server as unknown as ToolRegistrar, deps);
  return server;
}
```

- [ ] **Step 5: 实现 `src/bin/stdio.ts`**

```ts
#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { createServer } from '../server/createServer.js';
import { AppError } from '../core/errors.js';

const SWEEP_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  for (const notice of config.deprecations) logger.warn(notice);

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: createProviders,
  });

  // unref 让定时器不阻止进程退出
  const sweeper = setInterval(() => {
    void sessions.sweep().then((removed) => {
      if (removed > 0) logger.debug('swept expired sessions', { removed });
    });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = createServer({ config, sessions, logger });
  await server.connect(new StdioServerTransport());

  logger.info('apple-icloud-mcp ready', {
    transport: 'stdio',
    accounts: config.accounts.length,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    clearInterval(sweeper);
    await sessions.destroyAll();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // 启动期失败必须写 stderr：stdout 属于 MCP 协议
  const message = err instanceof AppError ? `${err.message}${err.hint ? `\n提示：${err.hint}` : ''}` : String(err);
  process.stderr.write(`apple-icloud-mcp 启动失败：${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 全部测试通过，`dist/` 构建成功

- [ ] **Step 7: 手动冒烟：无配置时应给出可操作的报错**

```bash
node -e "delete process.env.ICLOUD_ACCOUNT_1" 
env -u ICLOUD_ACCOUNT_1 -u ICLOUD_APP_PASSWORD_1 node dist/bin/stdio.js
```
Expected: 进程以 1 退出，stderr 打印"没有配置任何 iCloud 账号"及 `.env.example` 提示，stdout 无任何输出。

- [ ] **Step 8: 手动冒烟：正常启动并响应 tools/list**

在 `.env` 中填入真实账号后运行：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/bin/stdio.js
```
Expected: stdout 返回两条 JSON-RPC 响应，第二条列出 15 个工具（3 会话 + 7 邮件 + 5 日历）；日志只出现在 stderr。

- [ ] **Step 9: 提交**

```bash
git add src/providers/icloud/index.ts src/server/createServer.ts src/bin/stdio.ts tests/unit/server
git commit -m "feat(server): wire modules into a stdio MCP server"
```

---

### Task 19: 集成测试与文档

**Files:**
- Create: `vitest.integration.config.ts`
- Create: `tests/integration/live.test.ts`
- Create: `.env.test.example`
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `CLAUDE.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 全部
- Produces: 可选运行的真实账号测试与更新后的文档

- [ ] **Step 1: 在 `.gitignore` 追加测试凭据**

```
.env.test
```

- [ ] **Step 2: 创建 `.env.test.example`**

```bash
# 复制为 .env.test 后填入真实凭据，才会运行集成测试。
# 集成测试只操作下面指定的专用资源，不会碰你的日常邮件与日历。
ICLOUD_ACCOUNT_1=your-name@icloud.com
ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop
ALLOW_MAIL_READ_1=true
ALLOW_MAIL_WRITE_1=false
ALLOW_CALENDAR_READ_1=true
ALLOW_CALENDAR_WRITE_1=true
# 写操作只允许发生在这个日历上，必须先在 iCloud 中手动创建
INTEGRATION_CALENDAR_NAME=MCP-Test
```

- [ ] **Step 3: 创建 `vitest.integration.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
  },
});
```

- [ ] **Step 4: 创建 `tests/integration/live.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createProviders } from '../../src/providers/icloud/index.js';
import { createMailService } from '../../src/modules/mail/service.js';
import { createCalendarService } from '../../src/modules/calendar/service.js';
import type { SessionProviders } from '../../src/core/session.js';

const envPath = join(process.cwd(), '.env.test');
const hasCredentials = existsSync(envPath);

/** 只解析 .env.test，不污染 process.env。 */
function readTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line.trim());
    if (match && !line.trim().startsWith('#')) env[match[1]!] = match[2]!.trim();
  }
  return env;
}

describe.skipIf(!hasCredentials)('live iCloud integration', () => {
  let providers: SessionProviders;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    env = readTestEnv();
    const config = loadConfig(env);
    providers = createProviders(config.accounts[0]!);
  });

  afterAll(async () => {
    await providers?.imap.close();
  });

  it('authenticates against IMAP and CalDAV', async () => {
    await expect(providers.imap.verify()).resolves.toBeUndefined();
    await expect(providers.caldav.verify()).resolves.toBeUndefined();
  });

  it('discovers a trash folder and an inbox', async () => {
    const folders = await providers.imap.listFolders();
    expect(folders.some((f) => f.specialUse === 'inbox')).toBe(true);
    expect(folders.some((f) => f.specialUse === 'trash')).toBe(true);
  });

  it('reads real inbox messages without mojibake', async () => {
    const config = loadConfig(env);
    const service = createMailService({
      account: config.accounts[0]!,
      imap: providers.imap,
      smtp: providers.smtp,
    });
    const result = await service.search({ limit: 3 });
    for (const message of result.messages) {
      expect(message.subject).not.toContain('=?');
      expect(message.subject).not.toContain('�');
    }
  });

  it('creates, updates and deletes an event in the dedicated test calendar', async () => {
    const config = loadConfig(env);
    const service = createCalendarService({
      account: config.accounts[0]!,
      caldav: providers.caldav,
    });

    const calendars = await service.listCalendars();
    const target = calendars.find((c) => c.name === env.INTEGRATION_CALENDAR_NAME);
    if (!target) {
      throw new Error(
        `未找到测试日历 ${env.INTEGRATION_CALENDAR_NAME}，请先在 iCloud 中手动创建它`,
      );
    }

    const created = await service.createEvent(
      {
        title: 'MCP 集成测试事件',
        start: '2030-01-01T02:00:00.000Z',
        end: '2030-01-01T03:00:00.000Z',
      },
      target.calendar_id,
    );
    expect(created.title).toBe('MCP 集成测试事件');

    const updated = await service.updateEvent(created.event_id, { location: '测试地点' });
    expect(updated.location).toBe('测试地点');

    await expect(service.deleteEvent(created.event_id)).resolves.toEqual({ deleted: true });
  });
});
```

- [ ] **Step 5: 运行集成测试确认在无凭据时被跳过**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: 全部 skipped（本机没有 `.env.test` 时）

- [ ] **Step 6: 重写 `README.md`**

替换掉旧的部署与环境变量章节，内容需覆盖：

1. 项目简介与能力范围（邮件、日历；说明备忘录不支持及原因）。
2. 前置条件：Node 20+、Apple ID、App 专用密码生成入口。
3. 环境变量完整表格（与 `.env.example` 一致，标明读缺省开、写缺省关）。
4. 安装与运行：`npm install` → `npm run build` → `npm run serve`；开发用 `npm start`。
5. **在 Claude Code 中注册为 stdio MCP server 的具体配置**：

```json
{
  "mcpServers": {
    "apple-icloud": {
      "command": "node",
      "args": ["/绝对路径/apple_mcp/dist/bin/stdio.js"],
      "env": {
        "ICLOUD_ACCOUNT_1": "your-name@icloud.com",
        "ICLOUD_APP_PASSWORD_1": "abcd-efgh-ijkl-mnop",
        "ALLOW_CALENDAR_WRITE_1": "true"
      }
    }
  }
}
```

6. 工具清单表格（15 个工具，一行一句说明）。
7. 测试：`npm test` 与 `npm run test:integration` 的区别与前提。
8. 说明远程 HTTP + OAuth 部署属于阶段三，尚未提供。

- [ ] **Step 7: 重写 `SKILL.md`**

面向 AI 客户端的使用契约，需覆盖：登录 → 带 `session_id` 调用 → `work_done` 的流程；15 个工具的签名与用途；三条关键约定（不透明 id、结构化事件对象、时间一律 ISO 8601）；错误码表与对应的恢复动作（尤其 `SESSION_EXPIRED` → 重新 `apple_login`、`PERMISSION_DENIED` → 告知用户开启对应环境变量）；说明重复事件的 `scope` 语义与 `recurrence_id` 来源。

- [ ] **Step 8: 更新 `CLAUDE.md`**

把架构章节替换为新的分层说明（`bin → server → modules → providers`，`parsers` 为纯函数层），命令部分补上 `npm run typecheck` 与两套测试命令，"关键约定与坑"改为：ESM 相对导入必须带 `.js`、stdout 归 MCP 协议、IMAP/SMTP 用 `sender` 而 CalDAV 用 `email`、写权限缺省关闭、etag 不进 ID。删除所有关于旧实现的描述（全局 transport、dist 已提交等）。

- [ ] **Step 9: 全量验证**

```bash
npx tsc --noEmit
npx vitest run
npm run build
npm audit --omit=dev
```
Expected: 类型检查无输出；测试全绿；构建成功；audit 无高危漏洞。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "docs: rewrite README, SKILL and CLAUDE for v2; add integration harness"
```

---

## 完成标准

阶段一在以下条件全部满足时结束：

1. `npx vitest run` 全绿，`npx tsc --noEmit` 无输出，`npm run build` 成功。
2. `npm audit --omit=dev` 无高危漏洞。
3. 在 Claude Code 中以 stdio 方式注册后，能完成两条真实链路：
   - 「搜索本周未读邮件并读取其中一封的正文」——中文主题与正文均无乱码；
   - 「查看下周日程，创建一个带 15 分钟提醒的事件，再把它改期，最后删掉」。
4. 关闭 `ALLOW_CALENDAR_WRITE_1` 后，创建事件的调用返回 `PERMISSION_DENIED` 且 hint 指明要设置哪个环境变量。
5. 传入无效 `session_id` 时返回 `SESSION_EXPIRED`，且模型据 hint 能自行重新登录。
6. 仓库中不存在任何真实凭据，`git status` 干净。

## 后续阶段

- **阶段二**：`providers/icloud/carddav.ts` + `parsers/vcard.ts` + `modules/reminders` + `modules/contacts`。提醒复用本阶段的 CalDAV provider 与 iCal 解析层，仅需处理 VTODO 字段映射。
- **阶段三**：`bin/http.ts`（Streamable HTTP，每客户端独立 transport 实例）+ `auth/*`（自建 OAuth 2.1 授权服务器）+ Docker/Caddy 部署产物与文档。

两个阶段各自单独出计划，不在本计划范围内。
