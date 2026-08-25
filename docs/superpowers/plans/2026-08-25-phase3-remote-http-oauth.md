# 阶段三：远程 HTTP 传输与自建 OAuth 2.1 授权服务器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让这台 MCP 服务器能作为远程连接器被 claude.ai 添加并完成 OAuth 授权，与现有 stdio 入口共用同一套业务代码。

**Architecture:** 新增 `bin/http.ts` 作为第二个入口，用 SDK 的 `StreamableHTTPServerTransport`，**每个客户端一个 transport 实例**（v1 的模块级单例正是第二个客户端顶掉第一个的根因）。授权走 SDK 的 `mcpAuthRouter` 承担协议层，我们只实现 `OAuthServerProvider` 的六个方法与加密落盘存储。业务层（`server/`、`modules/`、`providers/`、`parsers/`）一行不改。

**Tech Stack:** TypeScript ESM（NodeNext）、`@modelcontextprotocol/sdk` 1.30.0（含 express 5、cors、express-rate-limit、jose、pkce-challenge）、Node 内置 `crypto`（scrypt / AES-256-GCM / timingSafeEqual）、`vitest` 4.1.11。

**Spec:** `docs/superpowers/specs/2026-08-22-apple-icloud-mcp-refactor-design.md` §4、§5.1、§7 与「阶段三 —— 远程上线」

---

## Scope 检查

spec 的阶段三含三块：HTTP 传输、OAuth 授权服务器、部署产物。**它们不是可以各自成篇的独立子系统**，因此不拆计划：

- HTTP 入口必须挂载授权路由与 Bearer 中间件，两者在同一个文件里交汇。
- 先交付「能跑但没有认证的远程 MCP 服务器」是安全隐患——任何人照着 README 部署一次，iCloud 数据就对公网裸奔。

所以做成一个计划，但**任务顺序保证认证能力先于任何对外绑定就位**：存储与令牌逻辑（Task 2–4）在 HTTP 入口（Task 5）之前，且 Task 5 的服务器在缺少任一 HTTP 必填环境变量时拒绝启动。

---

## 计划前裁定（五条，均已实测核对）

### 裁定一：管理员口令用 `crypto.scrypt`，不用 spec 点名的 argon2

spec §5.1 的环境变量表写 `ADMIN_PASSWORD_HASH`「管理员登录口令的 argon2 哈希」。改用 Node 内置的 `scrypt`。

实测（Node v24.14.1）：`crypto.scryptSync` 可用，`crypto.timingSafeEqual` 可用。

理由：argon2 的 npm 实现需要 node-gyp 原生编译。这在多阶段 Dockerfile 里意味着构建阶段要装 python3 + build-essential，镜像变大、构建变慢、跨架构（arm64 / amd64）还容易翻车——而本阶段的交付物**正是一个 Docker 镜像**。scrypt 是 RFC 7914 的标准 KDF、Node 原生内置、零依赖、零编译。对「一个部署者的一个口令」这个场景，它的强度绰绰有余。

### 裁定二：令牌存储用加密 JSON 文件 + 原子写，不用 SQLite

spec 的 `TOKEN_STORE_PATH` 默认值写作 `./data/tokens.db`，暗示 SQLite。

实测：`node:sqlite` 在 Node 24 可用，但启动时打印 `ExperimentalWarning: SQLite is an experimental feature and might change at any time`。

理由：这台服务器要长期在线，而「随时可能变」的 API 不适合放在它的持久化路径上；引入 `better-sqlite3` 则又回到裁定一的原生编译问题。本阶段的数据量是**一个部署者的若干个 OAuth 客户端与令牌**——量级在几十到几百条记录，一个整体读写的加密 JSON 文件完全够用，且没有实验性表面、没有新依赖。

**默认路径改为 `./data/tokens.json.enc`**，避免 `.db` 后缀误导后来者以为里面是 SQLite。

写入必须原子：写临时文件 → `fsync` → `rename`。直接覆写会在断电或 OOM 时留下半截文件，而那个文件是**唯一**能证明谁被授权过的东西。

### 裁定三：不新增运行时依赖

SDK 1.30.0 已经带来 `express@5`、`cors`、`express-rate-limit`、`jose`、`pkce-challenge`。

**但 `express` 必须提升为直接依赖**并钉在 SDK 使用的同一大版本上。理由：我们的代码会直接 `import express`，而依赖一个传递依赖是脆的——SDK 哪天换掉 express 我们就断。声明你 import 的东西，是最低限度的诚实。这不会给依赖树新增任何东西，`npm audit` 应保持 0。

其余全部用 Node 内置 `crypto`。

### 裁定四：OAuth 认证的是「客户端」，不是「用户」——账号选择仍归工具层

这台服务器的 iCloud 凭据来自环境变量，只有一个人：部署者。所以授权流程的语义是：

- **谁在授权** —— 部署者本人，通过管理员口令登录页证明身份。
- **授权给谁** —— 发起连接的 MCP 客户端（如 claude.ai），经动态客户端注册取得 client_id。
- **授权了什么** —— 访问这台服务器；**具体用哪个 iCloud 账号仍由 `apple_login` 工具的 `account` 参数决定**，与 stdio 完全一致。

**不要**把令牌绑定到某个 iCloud 账号。两个入口的行为模型必须一致，否则同一套 `modules/` 代码在两种传输下语义分叉——那正是本次重构要消灭的东西。

### 裁定五：会话与令牌是两层，不得合并

MCP 会话（`core/session.ts`，持有 IMAP 连接与 provider）和 OAuth 令牌是不同生命周期的东西：令牌可以活很多天，IMAP 连接空闲几分钟就该断。

- OAuth 令牌 → 证明「这个客户端可以调用工具」
- MCP 会话（`apple_login` 返回的 `session_id`）→ 持有 iCloud 连接，按 `SESSION_TTL_MINUTES` 过期

一个令牌在其生命周期内可以对应零到多个先后建立的 MCP 会话。**令牌被吊销时，必须同时销毁该令牌名下所有存活的 MCP 会话**——否则吊销只是拿走了门票，人还在屋里。这一条容易漏，Task 3 有专门的测试。

---

## Global Constraints

以下每条适用于每个任务，不再逐任务重复：

- **ESM 相对导入必须带 `.js` 后缀**（NodeNext），即使源文件是 `.ts`。
- `strict` 与 `noUncheckedIndexedAccess` 均开启。
- **stdio 入口的 stdout 完全属于 MCP 协议**；`src/` 下禁止 `console.log`，日志一律走 `core/logger.ts` 到 stderr。HTTP 入口同样遵守——它与 stdio 共用 logger。
- **验证用 `npm run typecheck`，不要用裸 `npx tsc --noEmit`**。后者只覆盖 `src/**/*`；`npm run typecheck` 会再跑一遍 `tsconfig.test.json`（include 为 `['src/**/*', 'tests/**/*']`）。vitest 用 esbuild 转译，**从不做类型检查**。
- `npx vitest run` 必须全绿（当前 452 个测试 / 30 个文件）。
- **单元测试不得触网、不得监听端口**：HTTP 相关测试用 `app` 对象直接调用 handler，或用随机端口并在测试结束时关闭。
- **除把 `express` 提升为直接依赖外，不新增依赖**；`npm audit` 保持 0 漏洞。
- 时间在工具边界一律是带偏移量的 ISO 8601。
- 提交信息末尾附 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- **不要运行集成测试套件**——它会写用户的真实 iCloud 账号，由控制者决定何时运行。
- **生成代码里一律避免反斜杠转义序列**。本项目已因此栽过六次，其中一次让某条强制的变异实验变成空转。需要反斜杠时用 `String.fromCharCode(92)`；需要 CRLF 时用 `String.fromCharCode(13, 10)`。

## 安全要求（每个任务都要照着核对自己那部分）

这个阶段的产出会**暴露在公网上**，写错一处的后果是别人能读用户的邮件与通讯录。以下每条都要有测试守着：

1. **授权码一次性且短时效。** TTL 60 秒。兑换成功后**从存储中删除**，不是标记为已用——删除让重放连记录都找不到。
2. **授权码绑定三要素**：`client_id`、`redirect_uri`、`code_challenge`。兑换时三者任一不匹配即失败。
3. **PKCE 强制 S256**，不接受 `plain`。`skipLocalPkceValidation` 保持默认 `false`，由 SDK 做校验。
4. **刷新令牌轮换**：每次兑换作废旧的、签发新的。**检测到已轮换的旧刷新令牌被再次使用，视为令牌泄露，吊销整个令牌家族**（该客户端该次授权下的全部令牌）。这是防令牌窃取的标准做法。
5. **访问令牌与刷新令牌在存储中只保存哈希**（SHA-256 即可，它们本身是高熵随机串，不需要 KDF）。存储文件泄露时，里面的东西不能直接拿去用。
6. **落盘加密**：AES-256-GCM，每条记录独立随机 IV，密钥来自 `TOKEN_ENCRYPTION_KEY`（32 字节 base64）。
7. **`redirect_uri` 必须与注册时完全一致**，不做前缀匹配、不做通配。
8. **口令比较用 `crypto.timingSafeEqual`**，不用 `===`。
9. **令牌、`Authorization` 头、口令一律不进日志**，任何级别都不行。`core/logger.ts` 已有脱敏，HTTP 层新增的字段要确认被覆盖。
10. **授权端点与令牌端点必须限流**（`express-rate-limit` 随 SDK 而来）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/auth/crypto.ts` | 纯函数：scrypt 口令哈希与校验、AES-256-GCM 加解密、令牌生成与哈希。无 I/O、无状态。 |
| `src/auth/store.ts` | 客户端与令牌的加密持久化：原子写、内存索引、过期清理、吊销。不知道 OAuth 协议的存在。 |
| `src/auth/provider.ts` | `OAuthServerProvider` 的六个方法。协议语义集中在这里。 |
| `src/auth/login.ts` | 管理员登录页（HTML）与凭据校验，授权码在此签发。 |
| `src/bin/http.ts` | HTTP 入口：express 应用、每客户端 transport、挂载授权路由与 Bearer 中间件、`/health`、优雅关闭。 |
| `src/core/config.ts`（改） | 新增 HTTP 入口专属环境变量，且**只在 HTTP 入口校验其必填性**。 |
| `Dockerfile`、`docker-compose.yml`、`Caddyfile` | 部署产物。 |

---

## Task 1: 密码学原语与 HTTP 配置

**Files:**
- Create: `src/auth/crypto.ts`
- Modify: `src/core/config.ts`
- Test: `tests/unit/auth/crypto.test.ts`、`tests/unit/core/config-http.test.ts`

**Interfaces:**
- Consumes: `AppError`（`src/core/errors.js`）
- Produces:

```ts
// src/auth/crypto.ts —— 纯函数，无 I/O、无状态
export function hashPassword(plain: string): string;           // 返回 "scrypt$N$r$p$salt$hash"，全部 base64url
export function verifyPassword(plain: string, stored: string): boolean;
export function generateToken(): string;                        // 32 字节随机，base64url
export function hashToken(token: string): string;               // SHA-256，hex
export function encryptJson(value: unknown, key: Buffer): string;   // "iv.tag.ciphertext"，全部 base64
export function decryptJson<T>(blob: string, key: Buffer): T;
export function parseEncryptionKey(raw: string): Buffer;        // 校验 base64 且恰好 32 字节
```

```ts
// src/core/config.ts 新增导出
export interface HttpConfig {
  port: number;
  publicUrl: URL;
  adminPasswordHash: string;
  tokenStorePath: string;
  encryptionKey: Buffer;
}
/** 只有 HTTP 入口调用；缺少任一必填项即抛 AppError，绝不使用默认值兜底。 */
export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig;
```

`AppConfig` 现有形状（不要改动它，`loadHttpConfig` 是并列的第二个入口）：

```ts
export interface AppConfig {
  accounts: AccountConfig[];
  sessionTtlMs: number;
  imapIdleTimeoutMs: number;
  logLevel: LogLevel;
  deprecations: string[];
  notices: string[];
}
```

### 为什么口令用 scrypt 而不是 argon2

见裁定一。实测 Node v24.14.1 下 `crypto.scryptSync` 与 `crypto.timingSafeEqual` 均可用。argon2 需要 node-gyp 原生编译，而本阶段的交付物正是一个 Docker 镜像——构建阶段要装 python3 与 build-essential，跨架构还容易翻车。

参数取 `N=2**15, r=8, p=1, keylen=32`，salt 16 字节随机。**参数必须编进哈希串本身**（形如 `scrypt$32768$8$1$<salt>$<hash>`），否则将来调参就无法校验旧口令。

### 三处安全细节，写错就是洞

1. **`verifyPassword` 必须用 `crypto.timingSafeEqual`。** 用 `===` 比较哈希会泄露前缀匹配长度。两个 Buffer 长度不同时 `timingSafeEqual` 会抛，所以先比长度、长度不等直接返回 false——这一步不构成时序泄露，因为哈希长度是公开的固定值。
2. **`encryptJson` 每次调用生成新的随机 IV。** AES-GCM 在同一密钥下重用 IV 会直接泄露明文异或值，这是 GCM 最致命的误用。输出格式 `iv.tag.ciphertext`，三段 base64 用点号分隔。
3. **`decryptJson` 必须校验 GCM 认证标签**（`decipher.final()` 会在标签不匹配时抛）。捕获后转成 `AppError`，**不要把原始异常信息透出去**——它可能暗示密钥是否正确。

- [ ] **Step 1: 写失败测试 `tests/unit/auth/crypto.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  encryptJson,
  decryptJson,
  parseEncryptionKey,
} from '../../../src/auth/crypto.js';
import { AppError } from '../../../src/core/errors.js';
import { randomBytes } from 'node:crypto';

const key = randomBytes(32);

describe('password hashing', () => {
  it('round-trips a password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery stapler', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash, so the same password hashes differently', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('embeds the parameters so a future tuning change can still verify old hashes', () => {
    const stored = hashPassword('x');
    const [scheme, n, r, p] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('returns false rather than throwing on a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$32768$8$1$onlyfourfields')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
});

describe('token generation', () => {
  it('produces high-entropy, url-safe, non-repeating tokens', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const t = generateToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.length).toBeGreaterThanOrEqual(40);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it('hashes a token deterministically and irreversibly', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encryption at rest', () => {
  it('round-trips an object', () => {
    const value = { clients: [{ id: 'abc', secret: 'shh' }], n: 42 };
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value);
  });

  it('uses a fresh IV every time, so identical plaintext gives different ciphertext', () => {
    const a = encryptJson({ same: true }, key);
    const b = encryptJson({ same: true }, key);
    expect(a).not.toBe(b);
    // 头一段是 IV，必须不同 —— GCM 下同密钥重用 IV 会直接泄露明文
    expect(a.split('.')[0]).not.toBe(b.split('.')[0]);
  });

  it('refuses to decrypt with the wrong key', () => {
    const blob = encryptJson({ secret: 'x' }, key);
    expect(() => decryptJson(blob, randomBytes(32))).toThrow(AppError);
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const blob = encryptJson({ secret: 'x' }, key);
    const [iv, tag, ct] = blob.split('.');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [iv, tag, flipped.toString('base64')].join('.');
    expect(() => decryptJson(tampered, key)).toThrow(AppError);
  });

  it('does not leak the underlying crypto error message', () => {
    const err = (() => {
      try {
        decryptJson('bad.blob.here', key);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err!.message.toLowerCase()).not.toContain('unsupported state');
    expect(err!.message.toLowerCase()).not.toContain('auth tag');
  });
});

describe('parseEncryptionKey', () => {
  it('accepts exactly 32 bytes of base64', () => {
    const raw = randomBytes(32).toString('base64');
    expect(parseEncryptionKey(raw)).toHaveLength(32);
  });

  it('rejects a key of the wrong length with an actionable hint', () => {
    const err = (() => {
      try {
        parseEncryptionKey(randomBytes(16).toString('base64'));
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
    expect(err!.hint ?? '').toMatch(/32/);
  });

  it('rejects text that is not base64', () => {
    expect(() => parseEncryptionKey('!!! not base64 !!!')).toThrow(AppError);
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把 `encryptJson` 的 IV 改成固定常量（例如 `Buffer.alloc(12)`），确认 `uses a fresh IV every time` 转红而其余照旧；改回。这条守的是 GCM 最致命的一种误用。

- [ ] **Step 2: 写失败测试 `tests/unit/core/config-http.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadHttpConfig } from '../../../src/core/config.js';
import { AppError } from '../../../src/core/errors.js';
import { randomBytes } from 'node:crypto';

const goodKey = randomBytes(32).toString('base64');
const base = {
  PUBLIC_URL: 'https://mcp.example.com',
  ADMIN_PASSWORD_HASH: 'scrypt$32768$8$1$c2FsdA$aGFzaA',
  TOKEN_ENCRYPTION_KEY: goodKey,
};

describe('loadHttpConfig', () => {
  it('defaults the port and the store path', () => {
    const cfg = loadHttpConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(17733);
    expect(cfg.tokenStorePath).toContain('tokens.json.enc');
    expect(cfg.publicUrl.origin).toBe('https://mcp.example.com');
  });

  it('requires PUBLIC_URL, and names it in the hint', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, PUBLIC_URL: undefined } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
    expect(err!.message + (err!.hint ?? '')).toContain('PUBLIC_URL');
  });

  it('requires ADMIN_PASSWORD_HASH', () => {
    expect(() =>
      loadHttpConfig({ ...base, ADMIN_PASSWORD_HASH: undefined } as NodeJS.ProcessEnv),
    ).toThrow(AppError);
  });

  it('requires TOKEN_ENCRYPTION_KEY and validates its length', () => {
    expect(() =>
      loadHttpConfig({ ...base, TOKEN_ENCRYPTION_KEY: undefined } as NodeJS.ProcessEnv),
    ).toThrow(AppError);
    expect(() =>
      loadHttpConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' } as NodeJS.ProcessEnv),
    ).toThrow(AppError);
  });

  it('rejects a PUBLIC_URL that is not https, since OAuth metadata requires it', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, PUBLIC_URL: 'http://mcp.example.com' } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err!.code).toBe('INVALID_INPUT');
    expect(err!.hint ?? '').toMatch(/https/i);
  });

  it('allows http on localhost, so a developer can try it without a certificate', () => {
    expect(() =>
      loadHttpConfig({ ...base, PUBLIC_URL: 'http://localhost:17733' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => loadHttpConfig({ ...base, PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(AppError);
    expect(() => loadHttpConfig({ ...base, PORT: '0' } as NodeJS.ProcessEnv)).toThrow(AppError);
    expect(() => loadHttpConfig({ ...base, PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(AppError);
  });

  it('never puts the encryption key or the password hash into an error message', () => {
    const err = (() => {
      try {
        loadHttpConfig({ ...base, PUBLIC_URL: 'not a url' } as NodeJS.ProcessEnv);
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    const blob = JSON.stringify(err);
    expect(blob).not.toContain(goodKey);
    expect(blob).not.toContain('scrypt$');
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把 https 校验去掉，确认 `rejects a PUBLIC_URL that is not https` 转红、而 `allows http on localhost` 仍绿；改回。两条一起才说明这个校验既生效又没有把本地开发挡死。

- [ ] **Step 3: 运行确认两个文件都失败**

Run: `npx vitest run tests/unit/auth/crypto.test.ts tests/unit/core/config-http.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现**

`crypto.ts` 要点：

- `hashPassword` 用 `scryptSync(plain, salt, 32, { N: 32768, r: 8, p: 1 })`，salt 取 `randomBytes(16)`。输出 `scrypt$32768$8$1$<salt base64url>$<hash base64url>`。
- `verifyPassword` 解析出参数与 salt 后重算，用 `timingSafeEqual` 比较。**任何解析失败都返回 `false`，不要抛**——调用方是登录端点，抛异常和返回 false 在那里的语义天差地别。
- `generateToken` 用 `randomBytes(32).toString('base64url')`。
- `encryptJson`：`randomBytes(12)` 作 IV，`createCipheriv('aes-256-gcm', key, iv)`，输出 `[iv, authTag, ciphertext].map(b => b.toString('base64')).join('.')`。
- `decryptJson`：整段包在 `try/catch` 里，任何失败都抛 `AppError('INTERNAL', '令牌存储无法解密')`，**不带原始异常信息**。

`loadHttpConfig` 要点：

- 缺失必填项时，`hint` 里点名那个变量，并给出生成办法（口令哈希与密钥各有一条命令，见 Task 7 的文档）。
- `PUBLIC_URL` 必须能被 `new URL()` 解析；协议必须是 https，**除非主机名是 `localhost` 或 `127.0.0.1`**。
- 校验失败的错误对象里**绝不能包含密钥或哈希本身**——最后一条测试守的就是这个。

- [ ] **Step 5: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/auth/crypto.ts src/core/config.ts tests/unit/auth/crypto.test.ts tests/unit/core/config-http.test.ts
git commit -m "feat(auth): add password, token and encryption primitives with HTTP config"
```

---

## Task 2: 加密令牌存储

**Files:**
- Create: `src/auth/store.ts`
- Test: `tests/unit/auth/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `encryptJson`/`decryptJson`/`hashToken`/`generateToken`、`AppError`、`Logger`
- Produces:

```ts
export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

/** 一次授权产生的一族令牌。刷新令牌轮换时 family_id 不变，用于泄露时整族吊销。 */
export interface StoredToken {
  family_id: string;
  client_id: string;
  /** 只存哈希；原始令牌离开本进程后就再也拿不回来。 */
  access_token_hash: string;
  refresh_token_hash: string;
  scopes: string[];
  access_expires_at: number;
  refresh_expires_at: number;
  /** 该刷新令牌是否已被轮换掉。已轮换的令牌再次出现 = 泄露信号。 */
  rotated: boolean;
}

export interface AuthStore {
  registerClient(client: Omit<StoredClient, 'created_at'>): Promise<StoredClient>;
  getClient(clientId: string): Promise<StoredClient | undefined>;

  saveTokens(record: StoredToken): Promise<void>;
  findByAccessToken(token: string): Promise<StoredToken | undefined>;
  findByRefreshToken(token: string): Promise<StoredToken | undefined>;

  /** 轮换：把旧记录标记 rotated 并写入新记录，同一个 family_id。 */
  rotateRefresh(oldRefreshToken: string, next: StoredToken): Promise<void>;
  /** 吊销一族的全部令牌，返回被吊销的 family_id（不存在则返回 undefined）。 */
  revokeFamily(familyId: string): Promise<string | undefined>;
  revokeByToken(token: string): Promise<string | undefined>;

  /** 清掉已过期的记录，返回清理条数。 */
  sweep(now?: number): Promise<number>;
  /** 供 HTTP 入口在启动时调用一次，把磁盘内容读进内存。 */
  load(): Promise<void>;
}

export function createAuthStore(deps: {
  path: string;
  key: Buffer;
  logger: Logger;
}): AuthStore;
```

### 为什么是加密 JSON 文件而不是 SQLite

见裁定二。`node:sqlite` 在 Node 24 可用但打印 `ExperimentalWarning: ... might change at any time`，而这是一台要长期在线的服务器的持久化路径；`better-sqlite3` 则需要原生编译。本阶段的数据量是**一个部署者的若干客户端与令牌**，几十到几百条记录，整体读写完全够用。

### 原子写不是可选项

写入必须是：写临时文件 → `fsync` → `rename` 到目标路径。理由：这个文件是**唯一**能证明谁被授权过的东西。直接覆写时若进程在写到一半被 OOM 杀死或断电，留下的是半截文件——下次启动解密失败，所有客户端的授权同时失效，而用户看到的现象是「连接器莫名其妙全掉了」。`rename` 在同一文件系统上是原子的，这是标准做法。

**目录不存在时要自己创建**（`mkdir -p` 语义），否则默认路径 `./data/...` 在全新部署上第一次写就失败。

### 令牌只存哈希

`access_token_hash` 与 `refresh_token_hash` 存的是 `hashToken()` 的结果。查找时先哈希再比对。这样存储文件即使泄露，里面的东西也不能直接拿去调 API。

**注意**：这意味着 `findByAccessToken` 是「哈希后在索引里查」，不是遍历解密比较。内存索引以哈希为 key。

- [ ] **Step 1: 写失败测试 `tests/unit/auth/store.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAuthStore } from '../../../src/auth/store.js';
import { createLogger } from '../../../src/core/logger.js';
import { generateToken, hashToken } from '../../../src/auth/crypto.js';

const logger = createLogger('error', () => {});
const key = randomBytes(32);
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authstore-'));
  path = join(dir, 'nested', 'tokens.json.enc');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore() {
  return createAuthStore({ path, key, logger });
}

function tokenRecord(overrides: Partial<Parameters<ReturnType<typeof makeStore>['saveTokens']>[0]> = {}) {
  const access = generateToken();
  const refresh = generateToken();
  return {
    record: {
      family_id: 'fam-1',
      client_id: 'client-1',
      access_token_hash: hashToken(access),
      refresh_token_hash: hashToken(refresh),
      scopes: ['mcp'],
      access_expires_at: Date.now() + 3600_000,
      refresh_expires_at: Date.now() + 30 * 24 * 3600_000,
      rotated: false,
      ...overrides,
    },
    access,
    refresh,
  };
}

describe('client registration', () => {
  it('round-trips a client through a reload', async () => {
    const store = makeStore();
    await store.load();
    const saved = await store.registerClient({
      client_id: 'c1',
      client_name: 'probe',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(saved.created_at).toBeGreaterThan(0);

    const reopened = makeStore();
    await reopened.load();
    const got = await reopened.getClient('c1');
    expect(got?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('creates the directory when it does not exist yet', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({ client_id: 'c1', redirect_uris: ['https://x/cb'] });
    expect(existsSync(path)).toBe(true);
  });

  it('returns undefined for an unknown client', async () => {
    const store = makeStore();
    await store.load();
    expect(await store.getClient('nope')).toBeUndefined();
  });
});

describe('encryption at rest', () => {
  it('writes nothing readable to disk', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({
      client_id: 'secret-client-id',
      client_name: 'my private connector',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('secret-client-id');
    expect(raw).not.toContain('my private connector');
    expect(raw).not.toContain('claude.ai');
  });

  it('refuses to start on a store encrypted with a different key', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({ client_id: 'c1', redirect_uris: ['https://x/cb'] });

    const wrongKey = createAuthStore({ path, key: randomBytes(32), logger });
    await expect(wrongKey.load()).rejects.toThrow();
  });

  it('starts clean when the file does not exist', async () => {
    const store = makeStore();
    await expect(store.load()).resolves.toBeUndefined();
    expect(await store.getClient('anything')).toBeUndefined();
  });
});

describe('token storage', () => {
  it('finds a record by its access token, never by a stored plaintext', async () => {
    const store = makeStore();
    await store.load();
    const { record, access } = tokenRecord();
    await store.saveTokens(record);

    expect((await store.findByAccessToken(access))?.family_id).toBe('fam-1');
    expect(await store.findByAccessToken('some-other-token')).toBeUndefined();

    // 磁盘上不得出现原始令牌
    expect(readFileSync(path, 'utf8')).not.toContain(access);
  });

  it('finds a record by its refresh token', async () => {
    const store = makeStore();
    await store.load();
    const { record, refresh } = tokenRecord();
    await store.saveTokens(record);
    expect((await store.findByRefreshToken(refresh))?.client_id).toBe('client-1');
  });
});

describe('refresh rotation and family revocation', () => {
  it('marks the old refresh token rotated and keeps the family id', async () => {
    const store = makeStore();
    await store.load();
    const first = tokenRecord();
    await store.saveTokens(first.record);

    const second = tokenRecord({ family_id: 'fam-1' });
    await store.rotateRefresh(first.refresh, second.record);

    const old = await store.findByRefreshToken(first.refresh);
    expect(old?.rotated, '旧刷新令牌必须留在存储里并标记为已轮换 —— 删掉它就再也认不出重放').toBe(true);
    expect((await store.findByRefreshToken(second.refresh))?.rotated).toBe(false);
  });

  it('revokes every token in a family', async () => {
    const store = makeStore();
    await store.load();
    const a = tokenRecord({ family_id: 'fam-9' });
    const b = tokenRecord({ family_id: 'fam-9' });
    const other = tokenRecord({ family_id: 'fam-other' });
    await store.saveTokens(a.record);
    await store.saveTokens(b.record);
    await store.saveTokens(other.record);

    expect(await store.revokeFamily('fam-9')).toBe('fam-9');
    expect(await store.findByAccessToken(a.access)).toBeUndefined();
    expect(await store.findByAccessToken(b.access)).toBeUndefined();
    expect(await store.findByAccessToken(other.access), '别的族不能被牵连').toBeDefined();
  });

  it('revokeByToken removes the whole family, not just that one token', async () => {
    const store = makeStore();
    await store.load();
    const a = tokenRecord({ family_id: 'fam-x' });
    const b = tokenRecord({ family_id: 'fam-x' });
    await store.saveTokens(a.record);
    await store.saveTokens(b.record);

    expect(await store.revokeByToken(a.access)).toBe('fam-x');
    expect(await store.findByAccessToken(b.access), '同族的其它令牌必须一起失效').toBeUndefined();
  });

  it('returns undefined when revoking something unknown, without throwing', async () => {
    const store = makeStore();
    await store.load();
    expect(await store.revokeFamily('nope')).toBeUndefined();
    expect(await store.revokeByToken('nope')).toBeUndefined();
  });
});

describe('expiry', () => {
  it('does not return an expired access token', async () => {
    const store = makeStore();
    await store.load();
    const { record, access } = tokenRecord({ access_expires_at: Date.now() - 1000 });
    await store.saveTokens(record);
    expect(await store.findByAccessToken(access)).toBeUndefined();
  });

  it('sweeps records whose refresh token has also expired', async () => {
    const store = makeStore();
    await store.load();
    const dead = tokenRecord({
      access_expires_at: Date.now() - 10_000,
      refresh_expires_at: Date.now() - 5_000,
    });
    const alive = tokenRecord({ family_id: 'fam-alive' });
    await store.saveTokens(dead.record);
    await store.saveTokens(alive.record);

    expect(await store.sweep()).toBe(1);
    expect(await store.findByAccessToken(alive.access)).toBeDefined();
  });

  it('keeps a record whose access token expired but whose refresh token has not', async () => {
    const store = makeStore();
    await store.load();
    const { record, refresh } = tokenRecord({ access_expires_at: Date.now() - 1000 });
    await store.saveTokens(record);
    await store.sweep();
    expect(await store.findByRefreshToken(refresh), '访问令牌过期不代表该刷新').toBeDefined();
  });
});

describe('atomic writes', () => {
  it('leaves no partial file behind and survives a reload after many writes', async () => {
    const store = makeStore();
    await store.load();
    for (let i = 0; i < 25; i += 1) {
      await store.registerClient({ client_id: `c${i}`, redirect_uris: [`https://x/${i}`] });
    }
    const reopened = makeStore();
    await reopened.load();
    expect((await reopened.getClient('c24'))?.redirect_uris).toEqual(['https://x/24']);
    expect((await reopened.getClient('c0'))?.redirect_uris).toEqual(['https://x/0']);
  });

  it('reports a corrupted store instead of silently starting empty', async () => {
    const store = makeStore();
    await store.load();
    await store.registerClient({ client_id: 'c1', redirect_uris: ['https://x/cb'] });

    writeFileSync(path, 'this is not encrypted json', 'utf8');
    const reopened = makeStore();
    await expect(
      reopened.load(),
      '静默从空存储启动会让所有客户端的授权无声失效，且没人知道为什么',
    ).rejects.toThrow();
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把 `revokeByToken` 改成只删除那一条记录、不吊销整族，确认 `revokeByToken removes the whole family` 转红而其余照旧；改回。
2. 把 `load()` 在解密失败时改成静默返回空存储，确认 `reports a corrupted store` 转红；改回。这条守的是「无声失效」——它比崩溃更难排查。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/auth/store.test.ts`

- [ ] **Step 3: 实现存储**

- 内存结构：`clients: Map<string, StoredClient>`、`tokens: StoredToken[]`，外加两个索引 `byAccessHash: Map<string, StoredToken>` 与 `byRefreshHash: Map<string, StoredToken>`。
- 每次变更后整体序列化 → `encryptJson` → 原子写。数据量小，不值得做增量。
- 原子写：`await mkdir(dirname(path), { recursive: true })`，写 `path + '.tmp'`，`fh.sync()`，`rename`。**临时文件名要带进程 pid 或随机后缀**，否则两个进程指向同一存储时会互相踩踏。
- `findByAccessToken` / `findByRefreshToken` 在返回前检查对应的过期时间，过期即视为不存在。
- `revokeFamily` 从数组与两个索引中一并删除该族全部记录。
- `sweep` 只删除**访问令牌与刷新令牌都已过期**的记录。
- `load()` 解密失败必须抛，并在 `AppError` 的 hint 里提示：要么 `TOKEN_ENCRYPTION_KEY` 变了、要么文件损坏，处理办法是删掉存储文件让所有客户端重新授权。**不要静默重来**。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/auth/store.ts tests/unit/auth/store.test.ts
git commit -m "feat(auth): add an encrypted, atomically written token store"
```

---

## Task 3: 令牌签发、轮换与吊销

**Files:**
- Create: `src/auth/provider.ts`
- Test: `tests/unit/auth/provider-tokens.test.ts`

**Interfaces:**
- Consumes: Task 1 的 crypto、Task 2 的 `AuthStore`、SDK 的 `OAuthServerProvider`/`OAuthTokens`/`AuthInfo`/`OAuthClientInformationFull`、`SessionStore`（`src/core/session.js`）
- Produces:

```ts
export interface PendingCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  expires_at: number;
}

export interface AppleOAuthProvider extends OAuthServerProvider {
  /** 由 Task 4 的登录流程调用：管理员通过校验后签发一次性授权码，返回原始码。 */
  issueAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
  }): string;
  /** 定期清理过期授权码与令牌，返回清理条数。 */
  sweep(): Promise<number>;
}

export function createOAuthProvider(deps: {
  store: AuthStore;
  sessions: SessionStore;
  logger: Logger;
  accessTokenTtlMs?: number;   // 默认 3600_000
  refreshTokenTtlMs?: number;  // 默认 30 * 24 * 3600_000
  authCodeTtlMs?: number;      // 默认 60_000
}): AppleOAuthProvider;
```

SDK 的 `OAuthServerProvider` 契约（已从 `node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/provider.d.ts` 核对）：

```ts
get clientsStore(): OAuthRegisteredClientsStore;
authorize(client, params: AuthorizationParams, res: Response): Promise<void>;
challengeForAuthorizationCode(client, authorizationCode: string): Promise<string>;
exchangeAuthorizationCode(client, authorizationCode, codeVerifier?, redirectUri?, resource?): Promise<OAuthTokens>;
exchangeRefreshToken(client, refreshToken, scopes?, resource?): Promise<OAuthTokens>;
verifyAccessToken(token: string): Promise<AuthInfo>;
revokeToken?(client, request: OAuthTokenRevocationRequest): Promise<void>;
skipLocalPkceValidation?: boolean;   // 保持默认 false，PKCE 校验交给 SDK
```

`authorize()` 属于 Task 4；本任务实现其余五个方法与 `issueAuthorizationCode`。

### 授权码：在内存里，一次性，删除而非标记

授权码 TTL 60 秒，**不落盘**——它活得比一次页面跳转还短，写进加密文件只是徒增泄露面。存 `Map<code_hash, PendingCode>`。

兑换成功后**从 Map 里删除**，不是标记 `used: true`。理由：删除让重放连记录都查不到，而「标记已用」的实现必须自己记得在每条查询路径上都检查那个标记——漏一处就是可重放的授权码。少一个需要记住的东西，就少一个漏掉的机会。

兑换时必须核对三项：`client_id`、`redirect_uri`、`code_challenge`（后者由 SDK 通过 `challengeForAuthorizationCode` 取走后自行校验）。**任一不匹配都要先把该码删掉再报错**——一个被用错的码不应该留着给人再试一次。

### 刷新令牌轮换与泄露检测

每次 `exchangeRefreshToken`：作废旧的、签发新的、`family_id` 不变。

**检测到已 `rotated` 的刷新令牌被再次使用时，吊销整个令牌家族。** 这是 OAuth 2.1 推荐的防窃取机制，逻辑是：正常客户端拿到新令牌后绝不会回头用旧的；旧的再次出现意味着它被复制过一份，而此刻无法分辨在用的是本人还是窃贼——两个都断掉、让本人重新授权，是唯一安全的选择。

### 吊销令牌必须连带销毁 MCP 会话

见裁定五。`revokeToken` 与家族吊销都要调用 `sessions.destroyByToken(familyId)`（Task 6 会在 `SessionStore` 上加这个方法；本任务先按接口调用，用假实现测试）。

**这一条极容易漏**：只删令牌记录会让当前正握着 `session_id` 的调用方继续读用户邮件，直到会话自己 TTL 过期。吊销的语义必须是「立刻断开」，不是「不再续期」。

- [ ] **Step 1: 写失败测试 `tests/unit/auth/provider-tokens.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createOAuthProvider } from '../../../src/auth/provider.js';
import { createAuthStore } from '../../../src/auth/store.js';
import { createLogger } from '../../../src/core/logger.js';
import type { SessionStore } from '../../../src/core/session.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const logger = createLogger('error', () => {});
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const client = {
  client_id: 'client-1',
  redirect_uris: [REDIRECT],
} as OAuthClientInformationFull;

let dir: string;
let destroyByToken: ReturnType<typeof vi.fn>;

function makeSessions(): SessionStore {
  destroyByToken = vi.fn().mockResolvedValue(0);
  return { destroyByToken } as unknown as SessionStore;
}

async function makeProvider(
  opts: { accessTokenTtlMs?: number; refreshTokenTtlMs?: number; authCodeTtlMs?: number } = {},
) {
  dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();
  await store.registerClient({ client_id: 'client-1', redirect_uris: [REDIRECT] });
  const provider = createOAuthProvider({ store, sessions: makeSessions(), logger, ...opts });
  return { provider, store };
}

/** 走完一次完整授权，返回一对令牌。 */
async function authorizeOnce(provider: Awaited<ReturnType<typeof makeProvider>>['provider']) {
  const code = provider.issueAuthorizationCode({
    clientId: 'client-1',
    redirectUri: REDIRECT,
    codeChallenge: 'challenge-abc',
    scopes: ['mcp'],
  });
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  return { code, tokens };
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('authorization codes', () => {
  it('exchanges a fresh code for an access and refresh token', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  it('refuses to exchange the same code twice', async () => {
    const { provider } = await makeProvider();
    const { code } = await authorizeOnce(provider);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT),
      '授权码必须一次性 —— 重放是最基本的攻击',
    ).rejects.toThrow();
  });

  it('refuses a code whose redirect_uri does not match the one it was issued for', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
    });
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/cb'),
    ).rejects.toThrow();
  });

  it('refuses a code issued to a different client', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'someone-else',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
    });
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT)).rejects.toThrow();
  });

  it('discards a code after a failed exchange, so it cannot be retried', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
    });
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/cb'),
    ).rejects.toThrow();
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT),
      '用错过一次的码不该还能正确地再用一次',
    ).rejects.toThrow();
  });

  it('expires a code that is older than its ttl', async () => {
    const { provider } = await makeProvider({ authCodeTtlMs: 1 });
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT)).rejects.toThrow();
  });

  it('returns the stored challenge so the sdk can verify pkce', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
    });
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe('challenge-abc');
  });

  it('leaves pkce validation to the sdk', async () => {
    const { provider } = await makeProvider();
    expect(
      provider.skipLocalPkceValidation ?? false,
      'true 会把 PKCE 校验推给上游，而这里没有上游',
    ).toBe(false);
  });
});

describe('access tokens', () => {
  it('verifies a freshly issued access token', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('client-1');
    expect(info.scopes).toEqual(['mcp']);
  });

  it('rejects a token it never issued', async () => {
    const { provider } = await makeProvider();
    await expect(provider.verifyAccessToken('made-up-token')).rejects.toThrow();
  });

  it('rejects an expired access token', async () => {
    const { provider } = await makeProvider({ accessTokenTtlMs: 1 });
    const { tokens } = await authorizeOnce(provider);
    await new Promise((r) => setTimeout(r, 20));
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
});

describe('refresh rotation', () => {
  it('issues a new pair and invalidates the old refresh token', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const next = await provider.exchangeRefreshToken(client, tokens.refresh_token!);

    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await provider.verifyAccessToken(next.access_token)).toBeTruthy();
  });

  it('treats reuse of a rotated refresh token as theft and revokes the whole family', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const next = await provider.exchangeRefreshToken(client, tokens.refresh_token!);

    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!),
      '已轮换的刷新令牌再次出现 = 泄露信号',
    ).rejects.toThrow();

    await expect(
      provider.verifyAccessToken(next.access_token),
      '泄露信号出现后，同族的新令牌也必须一起失效',
    ).rejects.toThrow();
  });

  it('destroys the live MCP sessions of a revoked family', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    destroyByToken.mockClear();

    await provider.exchangeRefreshToken(client, tokens.refresh_token!).catch(() => undefined);

    expect(
      destroyByToken,
      '只删令牌不断会话，等于拿走门票却让人继续待在屋里',
    ).toHaveBeenCalledTimes(1);
  });

  it('rejects a refresh token belonging to another client', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const other = { client_id: 'client-2', redirect_uris: [REDIRECT] } as OAuthClientInformationFull;
    await expect(provider.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow();
  });
});

describe('revocation', () => {
  it('revokes an access token and its family, and destroys the sessions', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);

    await provider.revokeToken!(client, { token: tokens.access_token });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
    expect(destroyByToken).toHaveBeenCalled();
  });

  it('does nothing, and does not throw, for an unknown token', async () => {
    const { provider } = await makeProvider();
    await expect(provider.revokeToken!(client, { token: 'never-existed' })).resolves.toBeUndefined();
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把「兑换成功后删除授权码」改成「标记为已用但保留」，且不在查询路径上检查该标记——确认 `refuses to exchange the same code twice` 转红；改回。
2. 把泄露检测去掉（已轮换的刷新令牌当作普通失效处理，不吊销家族），确认 `treats reuse of a rotated refresh token as theft` 与 `destroys the live MCP sessions` 两条转红；改回。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/auth/provider-tokens.test.ts`

- [ ] **Step 3: 实现**

- `clientsStore` 返回一个包住 `AuthStore` 的对象，实现 SDK 的 `OAuthRegisteredClientsStore`（`getClient` 与 `registerClient`）。
- 授权码放内存 `Map`，key 是 `hashToken(code)`。
- `exchangeAuthorizationCode`：查码 → **先删** → 再校验 `client_id`、`redirect_uri`、过期 → 通过后签发令牌。删在校验之前，保证任何失败路径都不会留下可重试的码。
- 令牌签发：`generateToken()` 两次，存哈希，`family_id` 用 `randomUUID()`。
- `exchangeRefreshToken`：查记录 → 若 `rotated` 为真则 `revokeFamily` + `destroyByToken` 后抛错 → 否则 `rotateRefresh` 写入新记录。
- `verifyAccessToken` 返回 `{ token, clientId, scopes, expiresAt }`（`AuthInfo` 的形状）。
- 所有失败都抛 SDK 的 OAuth 错误类型（见 `server/auth/errors.js`），这样 `mcpAuthRouter` 才能映射成正确的 OAuth 错误响应；不要抛本项目的 `AppError`——那是工具层的错误模型，两者不能混。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/auth/provider.ts tests/unit/auth/provider-tokens.test.ts
git commit -m "feat(auth): issue, rotate and revoke tokens with reuse detection"
```

---

## Task 4: 授权流程与管理员登录

**Files:**
- Create: `src/auth/login.ts`
- Modify: `src/auth/provider.ts`（补上 `authorize()`）
- Test: `tests/unit/auth/login.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `verifyPassword`、Task 3 的 `AppleOAuthProvider.issueAuthorizationCode`
- Produces:

```ts
export interface LoginDeps {
  adminPasswordHash: string;
  provider: AppleOAuthProvider;
  logger: Logger;
  /** authorize() 暂存待授权请求的地方，登录表单凭 requestId 从这里取回。 */
  pending: ReturnType<typeof createPendingStore>;
}

/** 渲染登录页。pending 由 authorize() 暂存，表单回传时凭 requestId 取回。 */
export function renderLoginPage(params: { requestId: string; error?: string }): string;

/** 处理登录表单提交。成功时返回要跳转到的完整 URL（含 code 与 state），失败时返回 undefined。 */
export function handleLoginSubmit(
  deps: LoginDeps,
  params: { requestId: string; password: string },
): { redirectTo: string } | { error: string };

/** authorize() 把待授权请求暂存在这里，等管理员通过登录页确认。 */
export interface PendingAuthorization {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  state?: string;
  expires_at: number;
}
export function createPendingStore(ttlMs?: number): {
  put(p: PendingAuthorization): string;   // 返回 requestId
  take(requestId: string): PendingAuthorization | undefined;  // 取出即删除
  sweep(now?: number): number;
};
```

### 这个流程到底在授权什么

见裁定四。只有一个人（部署者），所以流程是：

1. 客户端（claude.ai）带着 `client_id`、`redirect_uri`、`code_challenge`、`state` 打到 `/authorize`。
2. `authorize()` 把这些参数暂存，生成一个 `requestId`，渲染登录页。
3. 管理员输入口令并提交。
4. 口令通过 → 用暂存的参数签发一次性授权码 → 302 跳回 `redirect_uri`，带上 `code` 与原样的 `state`。
5. 口令不通过 → 重新渲染登录页并显示错误，**`requestId` 保持有效**，让人可以再试；但整体有 TTL。

**`state` 必须原样带回**——它是客户端防 CSRF 的手段，改动或丢弃会让客户端拒绝这次回调。

### 登录页的四条硬要求

1. **表单里绝不能出现口令哈希、密钥或任何令牌。** 页面是纯 HTML 字符串，唯一的隐藏字段是 `requestId`。
2. **`requestId` 必须是高熵随机值**，不能是自增数或可猜的东西——它是「这次授权请求」的凭证。
3. **失败信息不区分「口令错」与「请求已过期」**……**不，这一条反过来**：这里只有一个管理员、没有账号枚举的问题，而含糊的报错会让部署者在自己配错时抓瞎。**要分开说清楚**：口令错就说口令错，请求过期就说请重新发起。安全上的模糊化在这个场景里没有收益，只有成本。
4. **响应必须带 `Cache-Control: no-store`**，避免登录页或跳转被中间层缓存。

### 口令校验用 Task 1 的 `verifyPassword`

它内部用 `timingSafeEqual`。**不要在这一层再写一次比较逻辑。**

- [ ] **Step 0: 先装 `@types/express`**

```bash
npm install --save-exact --save-dev @types/express@5.0.0
```

**这一步必须在写代码之前做，理由不是整洁而是安全。** express 5 不自带类型声明，本项目也没装过；而 `tsconfig.json` 开着 `skipLibCheck: true`，于是 SDK 的 `provider.d.ts` 里那句 `import { Response } from 'express'` 解析失败被静默吞掉，`authorize()` 第三个参数**退化成 `any`**。实测确认：写一个 `r.thisMethodDoesNotExistOnResponse()` 能通过 `npm run typecheck`。

本任务要写的正是 `res.redirect(...)`、`res.set(...)` 这类**防开放重定向的安全逻辑**——在 `any` 上写它们，等于把这一层的类型检查整个关掉。装上类型后，再跑一次那个探针确认它现在会报错，把两次输出贴进报告。

装完确认 `npm audit` 仍为 0。

- [ ] **Step 1: 写失败测试 `tests/unit/auth/login.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  renderLoginPage,
  handleLoginSubmit,
  createPendingStore,
} from '../../../src/auth/login.js';
import { hashPassword } from '../../../src/auth/crypto.js';
import { createLogger } from '../../../src/core/logger.js';

const logger = createLogger('error', () => {});
const PASSWORD = 'a-long-admin-password';
const adminPasswordHash = hashPassword(PASSWORD);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function makeProvider(code = 'issued-code-123') {
  return {
    issueAuthorizationCode: vi.fn().mockReturnValue(code),
  } as never;
}

function pendingWith(store: ReturnType<typeof createPendingStore>, state?: string) {
  return store.put({
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    code_challenge: 'challenge-abc',
    scopes: ['mcp'],
    state,
    expires_at: Date.now() + 600_000,
  });
}

describe('pending authorization store', () => {
  it('hands back what was put in, exactly once', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    expect(store.take(id)?.client_id).toBe('client-1');
    expect(store.take(id), '取出即删除 —— 一个待授权请求不该能被消费两次').toBeUndefined();
  });

  it('generates unguessable request ids', () => {
    const store = createPendingStore();
    const ids = new Set(Array.from({ length: 100 }, () => pendingWith(store)));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('expires a pending request', () => {
    const store = createPendingStore(1);
    const id = store.put({
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      code_challenge: 'c',
      scopes: ['mcp'],
      expires_at: Date.now() - 1,
    });
    expect(store.take(id)).toBeUndefined();
  });
});

describe('login page', () => {
  it('carries the request id and nothing sensitive', () => {
    const html = renderLoginPage({ requestId: 'req-abc' });
    expect(html).toContain('req-abc');
    expect(html).not.toContain(adminPasswordHash);
    expect(html).not.toContain('scrypt$');
    expect(html.toLowerCase()).toContain('type="password"');
  });

  it('shows an error when one is given', () => {
    const html = renderLoginPage({ requestId: 'req-abc', error: '口令不正确' });
    expect(html).toContain('口令不正确');
  });

  it('escapes the request id rather than interpolating it raw', () => {
    const html = renderLoginPage({ requestId: '"><script>alert(1)</script>' });
    expect(html, '登录页拼 HTML 时不转义，就是一个现成的反射型 XSS').not.toContain('<script>alert(1)</script>');
  });
});

describe('login submission', () => {
  it('issues a code and redirects back with it', () => {
    const store = createPendingStore();
    const id = pendingWith(store, 'client-state-xyz');
    const provider = makeProvider('the-code');
    const result = handleLoginSubmit(
      { adminPasswordHash, provider, logger, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    expect('redirectTo' in result).toBe(true);
    const url = new URL((result as { redirectTo: string }).redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.get('state'), 'state 必须原样带回，它是客户端防 CSRF 的手段').toBe(
      'client-state-xyz',
    );
  });

  it('omits state when the client did not send one', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const result = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    const url = new URL((result as { redirectTo: string }).redirectTo);
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('rejects a wrong password without issuing anything', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const provider = makeProvider();
    const result = handleLoginSubmit(
      { adminPasswordHash, provider, logger, pending: store } as never,
      { requestId: id, password: 'wrong' },
    );
    expect('error' in result).toBe(true);
    expect(provider.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it('says plainly which of the two things went wrong', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    const wrongPass = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: 'wrong' },
    );
    const expired = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: 'never-existed', password: PASSWORD },
    );
    // 只有一个管理员，不存在账号枚举问题；含糊报错只会让部署者配错时抓瞎
    expect((wrongPass as { error: string }).error).not.toBe((expired as { error: string }).error);
  });

  it('keeps the pending request usable after a wrong password', () => {
    const store = createPendingStore();
    const id = pendingWith(store);
    handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: 'wrong' },
    );
    const second = handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    expect('redirectTo' in second, '输错一次口令不该让人重新发起整个授权').toBe(true);
  });

  it('never logs the submitted password', () => {
    const lines: string[] = [];
    const capturing = createLogger('debug', (line) => lines.push(line));
    const store = createPendingStore();
    const id = pendingWith(store);
    handleLoginSubmit(
      { adminPasswordHash, provider: makeProvider(), logger: capturing, pending: store } as never,
      { requestId: id, password: PASSWORD },
    );
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把 `renderLoginPage` 的转义去掉，确认 `escapes the request id` 转红；改回。
2. 把 `state` 的透传去掉，确认 `issues a code and redirects back with it` 转红；改回。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/auth/login.test.ts`

- [ ] **Step 3: 实现，并补上 `provider.authorize()`**

`authorize(client, params, res)` 的职责：把 `params`（含 `redirectUri`、`codeChallenge`、`scopes`、`state`）存进 pending store，然后 `res.set('Cache-Control', 'no-store').send(renderLoginPage({ requestId }))`。

**`redirect_uri` 必须与客户端注册时的完全一致**，不做前缀匹配、不做通配。不匹配时按 OAuth 规范**不要跳转**（跳到一个未注册的地址正是开放重定向），而是直接返回错误页。

HTML 转义写一个小函数处理 `& < > " '` 五个字符，所有插值都过它。

- [ ] **Step 4: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/auth/login.ts src/auth/provider.ts tests/unit/auth/login.test.ts
git commit -m "feat(auth): add the admin login flow that issues authorization codes"
```

---

## Task 5: 进程级状态治理

**Files:**
- Modify: `src/parsers/ical.ts`、`src/core/session.ts`
- Test: `tests/unit/parsers/ical-timezone-isolation.test.ts`、`tests/unit/core/session-revocation.test.ts`

**Interfaces:**
- Produces：`SessionStore` 新增两个方法

```ts
/** 建立会话时记入它属于哪个令牌家族；stdio 入口传 undefined。 */
create(account: AccountConfig, tokenFamilyId?: string): Session;
/** 吊销令牌时调用：销毁该家族名下全部会话，返回销毁数量。 */
destroyByToken(tokenFamilyId: string): Promise<number>;
```

### 为什么这是一个独立任务

阶段一与阶段 2a 的账本各记了一条待办，两条都只在**并发会话**下才现形，而阶段三正是引入并发的那一步：

1. **`ICAL.TimezoneService` 是进程级全局注册表**（`src/parsers/ical.ts` 的 `registerTimezones`），仅以 TZID 字符串为键，且名字已被占用时跳过注册。stdio 下只有一个用户，无所谓；HTTP 下两个租户各自的日历若都带 `Asia/Shanghai` 的 VTIMEZONE 定义，**先到者的定义会静默支配后到者的解析**——时间会算错，而且错得没有任何痕迹。
2. 令牌吊销必须连带销毁 MCP 会话（裁定五），而 `SessionStore` 现在没有「按令牌找会话」的能力。

### 时区隔离怎么做

最小且正确的做法：**解析结束后把本次注册的 TZID 从全局注册表里摘掉**。`registerTimezones` 记下自己实际注册了哪些名字（跳过的不算），解析完成后逐一 `ICAL.TimezoneService.remove(tzid)`。

不要试图给注册表加锁或做 per-session 副本——`ical.js` 的解析路径在内部直接查这个全局表，绕不开。用完即摘是唯一不改动第三方库就能成立的隔离方式。

**必须用 `try/finally`**：解析抛异常时同样要摘干净，否则一次坏卡片就在全局表里留下一个永久污染项。

- [ ] **Step 1: 写失败测试 `tests/unit/parsers/ical-timezone-isolation.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { parseCalendarObject } from '../../../src/parsers/ical.js';

const ref = { collectionUrl: 'https://c/1/cal/', resourceUrl: 'https://c/1/cal/a.ics' };
const CRLF = String.fromCharCode(13, 10);

/** 两份都声明 Asia/Shanghai，但偏移量不同 —— 现实中不会这样，正因如此它能证明串扰。 */
function calendarWithTz(offset: string, hour: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//probe//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:' + offset,
    'TZOFFSETTO:' + offset,
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:evt-1',
    'DTSTAMP:20260101T000000Z',
    'SUMMARY:probe',
    'DTSTART;TZID=Asia/Shanghai:20260901T' + hour + '0000',
    'DTEND;TZID=Asia/Shanghai:20260901T' + hour + '3000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF);
}

describe('timezone registry isolation', () => {
  it('leaves no TZID registered after parsing', () => {
    const before = ICAL.TimezoneService.has('Asia/Shanghai');
    parseCalendarObject(calendarWithTz('+0800', '10'), ref);
    expect(
      ICAL.TimezoneService.has('Asia/Shanghai'),
      '解析完必须把自己注册的 TZID 摘掉，否则下一个租户的同名时区会被它支配',
    ).toBe(before);
  });

  it('cleans up even when parsing throws', () => {
    const before = ICAL.TimezoneService.has('Asia/Shanghai');
    const broken = calendarWithTz('+0800', '10').replace('END:VCALENDAR', '');
    try {
      parseCalendarObject(broken, ref);
    } catch {
      // 预期可能抛
    }
    expect(ICAL.TimezoneService.has('Asia/Shanghai')).toBe(before);
  });

  it('does not let one calendar definition govern another with the same TZID', () => {
    const first = parseCalendarObject(calendarWithTz('+0800', '10'), ref);
    const second = parseCalendarObject(calendarWithTz('+0100', '10'), ref);
    // 两份都写 10:00 本地时间，但偏移量差 7 小时，所以 UTC 瞬时必须不同。
    // 若第一份的定义残留在全局表里支配了第二份，两个值会相等。
    expect(
      second.events[0]!.start,
      '两份日历对同一 TZID 的定义不同，解析结果就必须不同',
    ).not.toBe(first.events[0]!.start);
  });
});
```

- [ ] **Step 2: 写失败测试 `tests/unit/core/session-revocation.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSessionStore } from '../../../src/core/session.js';
import type { AccountConfig } from '../../../src/core/config.js';

function account(id = 'account_1'): AccountConfig {
  return {
    id,
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
      contactsWrite: false,
    },
  };
}

function makeStore() {
  const closed: string[] = [];
  const store = createSessionStore({
    ttlMs: 60_000,
    providerFactory: () =>
      ({
        imap: { close: vi.fn().mockImplementation(async () => { closed.push('imap'); }) },
        smtp: {},
        caldav: {},
        carddav: {},
      }) as never,
  });
  return { store, closed };
}

describe('destroyByToken', () => {
  it('destroys every session belonging to a token family', async () => {
    const { store } = makeStore();
    const a = store.create(account(), 'fam-1');
    const b = store.create(account(), 'fam-1');
    const other = store.create(account(), 'fam-2');

    expect(await store.destroyByToken('fam-1')).toBe(2);
    expect(() => store.get(a.id)).toThrow();
    expect(() => store.get(b.id)).toThrow();
    expect(store.get(other.id).id, '别的令牌家族不受影响').toBe(other.id);
  });

  it('closes the underlying connections, not just the map entry', async () => {
    const { store, closed } = makeStore();
    store.create(account(), 'fam-1');
    await store.destroyByToken('fam-1');
    expect(closed, '只从 Map 里删掉会留下一条还连着 iCloud 的 IMAP 连接').toContain('imap');
  });

  it('leaves stdio sessions alone, since they carry no token family', async () => {
    const { store } = makeStore();
    const s = store.create(account());
    expect(await store.destroyByToken('fam-1')).toBe(0);
    expect(store.get(s.id).id).toBe(s.id);
  });

  it('returns 0 for an unknown family without throwing', async () => {
    const { store } = makeStore();
    await expect(store.destroyByToken('nope')).resolves.toBe(0);
  });
});
```

**鉴别性实验（必做，贴两次输出）**：

1. 把 `registerTimezones` 的清理去掉，确认 `does not let one calendar definition govern another` 转红；改回。这一条是本任务存在的理由。
2. 把 `destroyByToken` 改成只从 Map 删除、不调用 `imap.close()`，确认 `closes the underlying connections` 转红；改回。

- [ ] **Step 3: 运行确认两个文件都失败**

Run: `npx vitest run tests/unit/parsers/ical-timezone-isolation.test.ts tests/unit/core/session-revocation.test.ts`

- [ ] **Step 4: 实现**

`registerTimezones` 改成返回它实际注册的 TZID 列表；调用处用 `try/finally` 在解析结束后逐一 `remove`。**只摘自己注册的**——若某个 TZID 在调用前就已存在（被别处注册），不要动它。

`SessionStore` 的 `create` 增加可选的第二参数 `tokenFamilyId`，存在 `Session` 上；`destroyByToken` 遍历找出匹配的会话，逐个走现有的 `destroy` 路径（那条路径已经会关闭 IMAP 连接）。

**现有 `create(account)` 的调用点不能改语义**：stdio 入口不传第二参数，行为与今天完全一致。

- [ ] **Step 5: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run
git add src/parsers/ical.ts src/core/session.ts tests/unit/parsers/ical-timezone-isolation.test.ts tests/unit/core/session-revocation.test.ts
git commit -m "fix(core): scope the timezone registry and destroy sessions on revocation"
```

---

## Task 6: HTTP 入口

**Files:**
- Create: `src/bin/http.ts`、`src/server/httpApp.ts`
- Modify: `package.json`（新增 `serve:http` 脚本，把 `express` 提升为直接依赖）
- Test: `tests/unit/server/http-app.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的全部产出、`createServer`（`src/server/createServer.js`）、`loadConfig`/`loadHttpConfig`
- Produces:

```ts
/** 建好但未监听的 express 应用，便于单测直接打请求而不占端口。 */
export function createHttpApp(deps: {
  config: AppConfig;
  httpConfig: HttpConfig;
  sessions: SessionStore;
  provider: AppleOAuthProvider;
  logger: Logger;
}): { app: Express; closeAll: () => Promise<void> };
```

### 每个客户端一个 transport 实例

v1 用一个模块级 `transport` 变量承载连接，**第二个客户端接入直接顶掉第一个**——这是本次重构立项时列出的头号缺陷。

正确做法：以 MCP 会话 ID 为键维护 `Map<string, { transport, server }>`。

- `POST /mcp` 带 `mcp-session-id` 头 → 找到既有 transport 复用；不带且是 `initialize` 请求 → 新建 transport 与 `McpServer`，用 `sessionIdGenerator: () => randomUUID()`。
- `GET /mcp` → 交给对应 transport 处理 SSE 流。
- `DELETE /mcp` → 关闭并从 Map 中移除。
- transport 的 `onclose` 回调里也要从 Map 中移除，否则断开的连接会永远留在表里。

**这个 Map 是进程级的，但以随机会话 ID 为键，且每个条目持有各自独立的 `McpServer`**，所以不构成裁定五意义上的跨租户共享。`closeAll()` 供优雅关闭时清场。

### 路由与中间件顺序

```
app.use(cors(...))                              // 允许的来源见下
app.post('/admin-login', rateLimit, 登录表单处理)  // 必须在 mcpAuthRouter 之前
app.use(mcpAuthRouter({ provider, issuerUrl }))   // /.well-known/*、/authorize、/token、/register、/revoke
app.get('/health', ...)                         // 不需要认证
app.all('/mcp', requireBearerAuth({ verifier: provider }), mcpHandler)
```

### 登录表单不能用 `POST /authorize`

Task 4 的登录页最初把表单 action 定为 `/authorize`。**那会和 SDK 撞车**：`mcpAuthRouter` 的授权处理器声明了 `allowedMethods(['GET', 'POST'])`，并且在 `POST` 时把请求体当成 OAuth 授权参数解析（`req.method === 'POST' ? req.body : req.query`，见 `handlers/authorize.js:79,123`）。于是登录表单提交会被它当作一个缺少 `client_id`／`code_challenge` 的授权请求直接拒掉，而报错信息完全指不到真正的原因。

**表单 action 改为 `/admin-login`**，字段名 `request_id` 与 `password` 保持不变。同时改掉 `src/auth/login.ts` 中 `renderLoginPage` 里的 `action="/authorize"`——那一处是唯一的真相来源，改完要 grep 确认没有别处硬编码这个路径。

路由注册顺序也要求 `/admin-login` 在 `mcpAuthRouter` **之前**：express 的 `router.use(path)` 是前缀匹配，先注册的先命中，把自己的路由放在后面容易被意外吞掉。

**`/health` 必须在认证之前，且不得泄露任何信息**——只返回 `{ status: 'ok' }` 与进程启动时间。不要返回版本号、账号数、会话数：健康检查端点是公开的，它说的每一句话都是在对扫描者说。

**`/mcp` 必须在 `requireBearerAuth` 之后。** 这条弄反了就是整个阶段白做。有一条测试专门守它。

CORS：只允许 `PUBLIC_URL` 的来源与 `https://claude.ai`。不要用 `origin: true` 反射任意来源。

### 启动时的硬性检查

`bin/http.ts` 在 `listen` 之前必须：

1. `loadConfig` + `loadHttpConfig`，任一失败就写 stderr 并以非零码退出——**绝不带着半套配置开始监听**。
2. `store.load()`，解密失败同样退出（见 Task 2）。
3. 打印 `deprecations` 与 `notices` 到 stderr（与 `bin/stdio.ts` 一致）。
4. 装 `SIGINT`/`SIGTERM` 处理：停止接受新连接 → `closeAll()` → 关闭 HTTP server，带一个有上限的超时。

- [ ] **Step 1: 写失败测试 `tests/unit/server/http-app.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpApp } from '../../../src/server/httpApp.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { SessionStore } from '../../../src/core/session.js';

const logger = createLogger('error', () => {});

const appConfig = {
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
      },
    },
  ],
  sessionTtlMs: 60_000,
  imapIdleTimeoutMs: 60_000,
  logLevel: 'error',
  deprecations: [],
  notices: [],
} as AppConfig;

const httpConfig = {
  port: 17733,
  publicUrl: new URL('https://mcp.example.com'),
  adminPasswordHash: 'scrypt$32768$8$1$c2FsdA$aGFzaA',
  tokenStorePath: './data/tokens.json.enc',
  encryptionKey: Buffer.alloc(32),
};

let verifyAccessToken: ReturnType<typeof vi.fn>;

function makeProvider() {
  verifyAccessToken = vi.fn().mockRejectedValue(new Error('nope'));
  return {
    clientsStore: { getClient: vi.fn(), registerClient: vi.fn() },
    authorize: vi.fn(),
    challengeForAuthorizationCode: vi.fn(),
    exchangeAuthorizationCode: vi.fn(),
    exchangeRefreshToken: vi.fn(),
    verifyAccessToken,
    revokeToken: vi.fn(),
    issueAuthorizationCode: vi.fn(),
    sweep: vi.fn(),
  } as never;
}

function build() {
  return createHttpApp({
    config: appConfig,
    httpConfig,
    sessions: { create: vi.fn(), get: vi.fn(), destroyByToken: vi.fn() } as unknown as SessionStore,
    provider: makeProvider(),
    logger,
  });
}

/** 不占端口地打一个请求：用 supertest 风格的最小封装。 */
async function request(app: import('express').Express, method: string, path: string, headers: Record<string, string> = {}) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('health endpoint', () => {
  it('answers without authentication', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });

  it('discloses nothing about the deployment', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health');
    const body = res.body.toLowerCase();
    // 公开端点说的每一句话都是在对扫描者说
    expect(body).not.toContain('icloud.com');
    expect(body).not.toContain('account');
    expect(body).not.toContain('version');
    expect(body).not.toContain('session');
  });
});

describe('mcp endpoint authentication', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = build();
    const res = await request(app, 'POST', '/mcp');
    expect(res.status, '/mcp 必须在 requireBearerAuth 之后 —— 顺序弄反整个阶段就白做了').toBe(401);
  });

  it('rejects a bearer token the provider does not recognise', async () => {
    const { app } = build();
    const res = await request(app, 'POST', '/mcp', { authorization: 'Bearer made-up' });
    expect(res.status).toBe(401);
    expect(verifyAccessToken).toHaveBeenCalledWith('made-up');
  });

  it('never echoes the presented token back', async () => {
    const { app } = build();
    const res = await request(app, 'POST', '/mcp', { authorization: 'Bearer super-secret-token' });
    expect(res.body).not.toContain('super-secret-token');
  });
});

describe('oauth metadata', () => {
  it('serves authorization server metadata at the well-known path', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = JSON.parse(res.body);
    expect(meta.issuer).toContain('mcp.example.com');
    expect(meta.code_challenge_methods_supported, 'PKCE 必须声明 S256').toContain('S256');
  });
});

describe('cors', () => {
  it('does not reflect an arbitrary origin', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health', { origin: 'https://evil.example' });
    expect(res.body).not.toContain('evil.example');
  });
});
```

**鉴别性实验（必做，贴两次输出）**：把 `/mcp` 的路由挪到 `requireBearerAuth` 之前，确认 `rejects an unauthenticated request` 转红；改回。这是整个阶段最不能出错的一行。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/server/http-app.test.ts`

- [ ] **Step 3: 把 express 提升为直接依赖**

```bash
npm install --save-exact express@5.2.1
```

`@types/express` 已在 Task 4 装好（理由见那里），此处不重复。

版本要与 SDK 依赖的大版本一致（SDK 声明 `express: ^5.2.1`）。装完确认 `npm audit` 仍为 0、`npm ls express` 没有出现两份不同版本。

- [ ] **Step 4: 实现 `httpApp.ts` 与 `bin/http.ts`**

按上面的路由顺序搭。`package.json` 增加：

```json
"serve:http": "node dist/bin/http.js",
"start:http": "tsx src/bin/http.ts"
```

- [ ] **Step 5: 运行确认通过并提交**

```bash
npm run typecheck && npx vitest run && npm run build
git add -A
git commit -m "feat(http): add the authenticated Streamable HTTP entrypoint"
```

---

## Task 7: 部署产物与文档

**Files:**
- Create: `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`Caddyfile`
- Modify: `README.md`、`SKILL.md`、`CLAUDE.md`、`.env.example`

- [ ] **Step 1: 多阶段 Dockerfile**

三阶段：`deps`（只装生产依赖）、`build`（装全部依赖并 `npm run build`）、`runtime`（`node:22-alpine`，非 root 用户，只拷 `dist/` 与生产 `node_modules/`）。

**必须以非 root 运行**，并把 `TOKEN_STORE_PATH` 指向一个挂载卷。`HEALTHCHECK` 打 `/health`。

`.dockerignore` 至少排除 `.env`、`.env.test`、`data/`、`node_modules/`、`.git/`、`docs/`、`.superpowers/`。**漏掉 `.env` 就是把凭据烤进镜像层**，而镜像层是可以被逐层解出来的。

- [ ] **Step 2: docker-compose 与 Caddy**

两个服务：`caddy`（自动证书，反代到 app）与 `app`。Caddyfile 用 `PUBLIC_URL` 的域名，反代到 `app:17733`。

compose 里**只用 `env_file` 引用 `.env`，不要把任何密钥写进 compose 文件本身**——那个文件是要进版本库的。

给 token 存储声明一个具名卷；**在文档里写明这个卷丢失的后果是所有客户端需要重新授权**（不是数据丢失，但用户需要知道）。

- [ ] **Step 3: 生成密钥材料的命令**

README 里给出两条可直接复制的命令：

```bash
# 生成 TOKEN_ENCRYPTION_KEY（32 字节 base64）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

# 生成 ADMIN_PASSWORD_HASH（会提示输入口令，不回显、不进 shell 历史）
node -e "const r=require('node:readline').createInterface({input:process.stdin,output:process.stderr});r.question('password: ',p=>{r.close();import('./dist/auth/crypto.js').then(m=>console.log(m.hashPassword(p)))})"
```

第二条**必须走 stdin 而不是命令行参数**——写成 `node -e "...('明文口令')"` 会把口令留在 shell 历史与进程列表里。

- [ ] **Step 4: 文档**

- **README**：新增「远程部署」一节，含域名与 DNS、生成密钥材料、`docker compose up`、在 claude.ai 添加远程 MCP 的步骤、如何吊销某个客户端的授权。环境变量表补 `PORT`/`PUBLIC_URL`/`ADMIN_PASSWORD_HASH`/`TOKEN_STORE_PATH`/`TOKEN_ENCRYPTION_KEY`，并注明**这五个只有 HTTP 入口需要**。排查表补三行：401 一直不过、授权后跳回失败、令牌存储解密失败。
- **SKILL.md**：不需要改工具契约（工具集不变），但要说明远程与本地两种部署下 `apple_login` 的行为完全一致。
- **CLAUDE.md**：概述补第二个入口；「非显而易见的约束」补三条——(a) 每客户端独立 transport 实例，模块级单例是 v1 的头号缺陷；(b) 令牌吊销必须连带销毁 MCP 会话，只删令牌等于拿走门票却让人留在屋里；(c) `ICAL.TimezoneService` 用完即摘的理由。

- [ ] **Step 5: 全量验证并提交**

```bash
npm run typecheck && npx vitest run && npm run build
docker build -t apple-icloud-mcp:probe .   # 只验证能构建，不推送
git add -A
git commit -m "feat(deploy): add Docker, Caddy and remote deployment docs"
```

集成测试与真实部署由控制者决定何时进行，实现者不要自行执行。

---

## 完成标准

1. `npm run typecheck`、`npx vitest run`、`npm run build` 全部干净；`npm audit` 为 0。
2. stdio 入口行为与本阶段开始前**完全一致**——同样 25 个工具，同样的 `apple_login` 语义。
3. HTTP 入口在缺少任一必填环境变量时拒绝启动，并在 stderr 指名缺哪个。
4. 未带 Bearer 令牌访问 `/mcp` 返回 401。
5. 能从 claude.ai 完成一次完整授权：动态注册 → 登录页 → 授权码 → 令牌 → 调用工具。
6. 吊销令牌后，原 `session_id` 立刻不可用（不是等 TTL 过期）。
7. 已轮换的刷新令牌被再次使用时，整个令牌家族失效。
8. 令牌存储文件中不出现任何明文令牌、客户端名或回调地址。
9. `docker build` 成功，镜像以非 root 运行，`.env` 未被打进镜像。
