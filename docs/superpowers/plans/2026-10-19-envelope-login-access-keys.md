# 远程入口：访问密钥、管理页与加密信封登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让远程 HTTP 入口可以安全地多人共用。服务器主人按人发放访问密钥，并在一个管理页上管理这些密钥。每个人用自己的加密信封带着 iCloud 凭据登录，VPS 上不预存任何 iCloud 密码。

**Architecture:** 分三个阶段：

1. **阶段一（Task 1–7）：多人隔离的基础。**
   - 访问密钥替代管理员口令，成为 OAuth 授权的凭证。
   - 密钥 id 沿 code → token → `AuthInfo.extra` → 工具回调一路传下去。
   - iCloud 会话和 MCP transport 都按密钥校验归属。
   - 管理页 `/admin` 负责管理密钥，以及控制是否允许使用 env 账号的开关。
2. **阶段二（Task 8–10）：加密信封。**
   - 服务端持有一对 X25519 密钥。
   - 客户端脚本把 `.env` 封进 ECIES 信封。
   - `apple_login({ envelope })` 解密信封、防重放，再复用 `parseAccount` 构造账号。
3. **阶段三（Task 11–12）：** SKILL.md、文档、部署模板，以及上线。

stdio 与 CLI 入口的行为一律不变。

**Tech Stack:** TypeScript (ESM/NodeNext)、express 5、`@modelcontextprotocol/sdk`、Node 内置 `crypto`（X25519 / HKDF / AES-256-GCM）、vitest。

**Spec:** `docs/superpowers/specs/2026-10-19-envelope-login-design.md`

## Global Constraints

**依赖与运行环境**

- 不新增任何 npm 依赖，加密只用 `node:crypto`。Node 版本下限仍是 `>=20`。
- `scripts/make-envelope.mjs` 零依赖，不 import 仓库里的任何文件。

**输出与文案**

- `src/` 里不出现 `console.log`。日志一律用英文，经 `logger` 写到 stderr；面向用户的文案用中文。
- `InvalidTokenError` / `InvalidGrantError` 的消息必须是 ASCII，因为它们会写进 `WWW-Authenticate` 响应头。见 `provider.ts:180-187`。

**秘密的处理**

- 信封原文、解密后的载荷、访问密钥明文、App 专用密码，都不能进日志、错误消息或磁盘。唯一的例外是：访问密钥明文在新建那一次的 HTTP 响应里出现。
- 访问密钥格式：`amk_` + `randomBytes(32)` 的 base64url（43 字符）。服务端只存 `hashToken(明文)`。

**信封格式**

- 服务端公钥文本：`amp1_` + base64url(X25519 原始公钥 32 字节)。
- kid：`base64url(sha256(服务端原始公钥).subarray(0, 8))`。
- 信封文本：`ame1.` + base64url(JSON `{ v: 1, kid, epk, iv, ct, tag }`)。其中 `epk`/`iv`/`ct`/`tag` 都是 base64url，`epk` 是临时公钥的原始 32 字节。
- 密钥派生：用 `hkdfSync('sha256', ECDH共享秘密, salt = epk原始 ‖ 服务端公钥原始, info = 'apple-icloud-mcp envelope v1', 32)` 派生 AES-256-GCM 密钥。IV 为 12 字节，AAD = utf8(`'ame1.' + kid`)。
- 载荷：`{ v: 1, nonce: <base64url, 解码后 ≥16 字节>, iat: <ms epoch>, env: { <白名单内的 _1 变量>: string } }`。
- 时间窗：`iat ∈ [now − 300_000, now + 60_000]`。nonce 从第一次被接受起作废，作废记录保留到 `iat + 300_000`。

**白名单与默认值**

- 信封 env 白名单，正好 12 个，下文称"12 个白名单变量"：
  - `ICLOUD_ACCOUNT_1`、`ICLOUD_APP_PASSWORD_1`、`ICLOUD_SENDER_1`、`ICLOUD_LABEL_1`
  - `ALLOW_MAIL_READ_1`、`ALLOW_MAIL_WRITE_1`
  - `ALLOW_CALENDAR_READ_1`、`ALLOW_CALENDAR_WRITE_1`
  - `ALLOW_REMINDERS_READ_1`、`ALLOW_REMINDERS_WRITE_1`
  - `ALLOW_CONTACTS_READ_1`、`ALLOW_CONTACTS_WRITE_1`
- env 账号开关默认 **关闭**（`env_accounts_enabled: false`）。

**会话与存储**

- 会话归属不匹配时，表现必须与 id 不存在时完全一样：`SESSION_EXPIRED`，消息 `无效的 session_id`；`work_done` 返回 `{ success: false }`。
- 管理页会话：cookie 名 `amcp_admin`，`Path=/admin; HttpOnly; SameSite=Strict`，`PUBLIC_URL` 是 https 时再加 `Secure`。空闲 30 分钟过期，只存在内存里。
- `last_used_at`：内存里每次都更新；落盘时同一把密钥至少间隔 60 秒。
- 信封私钥文件：默认是 `TOKEN_STORE_PATH` 同目录下的 `envelope-key.json.enc`，可用 `ENVELOPE_KEY_PATH` 覆盖。文件用 `TOKEN_ENCRYPTION_KEY` 加密，权限 0600。

**测试与提交**

- 单测命令：`npx vitest run <file>`；全量：`npm test`；类型检查：`npm run typecheck`。注意 `tsconfig` 只覆盖 `src/`，测试文件不做类型检查。
- 每个 commit message 末尾加：`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. **同一张授权页被提交两次。** 2026-10-19 实际发生过：第一次提交成功并跳回 claude.ai，第二次显示"登录请求不存在或已过期"。期望的行为是：第二次提交显示"这次授权已经完成，可以关闭此页"，而不是报错。由 Task 4 负责。
2. **服务重启。** 信封密钥对必须跨重启保持不变，否则每次重启都要让所有朋友改 `MCP_ENVELOPE_PUBKEY`。由 Task 8 负责。
3. **升级 VPS 上已有的令牌快照。** 旧快照里没有 `access_keys`/`settings` 字段，必须能正常加载。加载后旧令牌失效，env 开关为关闭状态。由 Task 3 负责。
4. **模型传进来的信封带了首尾空白或换行**（脚本输出末尾的 `\n`），必须能接受；被引号包住时，要报"信封格式不对"并给出提示，不能报 INTERNAL。由 Task 10 负责。
5. **朋友的 `.env` 来自 Windows**：CRLF 换行、值带引号、有 `#` 注释行。脚本必须正确解析，并且不能把 `\r` 带进密码里。由 Task 9 负责。

---

## 阶段一：访问密钥、管理页、会话归属

### Task 1: iCloud 会话按访问密钥校验归属

**Files:**
- Modify: `src/core/session.ts`（`Session`、`SessionStore`、`createSessionStore`，新增常量与取值函数）
- Modify: `src/modules/{mail,calendar,reminders,contacts}/tools.ts`（`serviceOf` 与每个 handler）
- Modify: `src/modules/session/tools.ts`（`apple_login` 写入 owner，`work_done` 传入调用方）
- Test: `tests/unit/core/session-ownership.test.ts`（新建）
- Test: `tests/unit/server/tool-ownership.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export const ACCESS_KEY_ID_KEY = 'accessKeyId'`
  - `export function accessKeyIdFrom(extra?: ToolExtraLike): string | undefined`：形状和用法同 `tokenFamilyIdFrom`。
  - `Session.ownerKeyId?: string`
  - `SessionStore.create(account: AccountConfig, tokenFamilyId?: string, ownerKeyId?: string): Session`
  - `SessionStore.get(id: string, callerKeyId?: string): Session`
  - `SessionStore.destroy(id: string, callerKeyId?: string): Promise<boolean>`
  - `SessionStore.destroyMatching(predicate: (s: Session) => boolean): Promise<number>`：逐个走 `destroyById`，会关闭底层连接。

- [ ] **Step 1: 写失败测试 `tests/unit/core/session-ownership.test.ts`**

使用真实的 `createSessionStore`，providerFactory 用 `http-e2e.test.ts:94-112` 那种不连网的替身。用例：
- `get rejects a session owned by another key exactly like an unknown id`：先 `s = create(acc, 'fam', 'key-A')`，再调 `get(s.id, 'key-B')`。期望抛出 `AppError`，`code === 'SESSION_EXPIRED'`、`message === '无效的 session_id'`；之后 `get(s.id, 'key-A')` 仍然成功。
- `owner-less sessions only match owner-less callers`：`s = create(acc)` 之后，`get(s.id)` 成功，`get(s.id, 'key-A')` 抛 `SESSION_EXPIRED`。
- `destroy by a non-owner returns false and leaves the session alive`：`destroy(s.id, 'key-B')` 结果为 `false`；`size()` 不变；底层连接没有被关闭。
- `destroyMatching closes providers of every matched session`：建 3 个会话，其中 2 个属于 key-A。`destroyMatching(x => x.ownerKeyId === 'key-A')` 返回 `2`，`size() === 1`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/core/session-ownership.test.ts`
Expected: FAIL（`destroyMatching` 不存在，归属检查没生效）

- [ ] **Step 3: 在 `src/core/session.ts` 实现上述 Interfaces**

归属比较用 `session.ownerKeyId !== callerKeyId`，两边都是 `undefined` 时视为匹配。不匹配时抛出的错误必须和 id 不存在时那个 `AppError` 一模一样，用同一个常量。不匹配时**不要**刷新 `lastActiveAt`。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/core/session-ownership.test.ts tests/unit/core/session.test.ts tests/unit/core/session-revocation.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试 `tests/unit/server/tool-ownership.test.ts`**

用一个收集型 registrar（写法同 `tests/unit/modules/session-tools.test.ts:14-22`）调用 `registerAllTools`。config 是一个所有能力全开的账号，`sessions` 用真实的 store 加替身 providers。

- 用例 `every session-bound tool refuses a session_id owned by another access key`：
  1. 先 `s = sessions.create(account, 'fam', 'key-A')`；
  2. 对每个 `inputSchema` 里有 `session_id` 的工具（`work_done` 除外，它在下一条用例里单独测），调用 `handler({ session_id: s.id, ...FIXTURE_ARGS[name] }, { authInfo: { token: 't', clientId: 'c', scopes: [], extra: { accessKeyId: 'key-B' } } })`；
  3. 断言结果的 `isError === true`，并且 `JSON.parse(content[0].text).error.code === 'SESSION_EXPIRED'`。
  - `FIXTURE_ARGS` 一开始是空对象。如果某个工具在解析会话之前就因为参数报错，就给它补上最小的合法参数。不要调整 handler 内部的顺序。
  - 断言被检查的工具数量 `=== 22`：邮件 7 个、日历 5 个、提醒事项 5 个、通讯录 5 个。这个数量用来防止测试悄悄漏掉某个模块。
- 用例 `work_done from another key does not destroy the session`：用 key-B 的 extra 调 `work_done`，结果是 `success: false`，并且 `sessions.size() === 1`。

- [ ] **Step 6: 运行，确认失败**

Run: `npx vitest run tests/unit/server/tool-ownership.test.ts`
Expected: FAIL（工具层没有传入调用方身份，返回了正常结果或其他错误码）

- [ ] **Step 7: 修改四个模块的 tools.ts 和 session/tools.ts**

- 四个模块的 `serviceOf` 签名都改成 `(sessionId: string, extra?: ToolExtra)`，内部调用 `sessions.get(sessionId, accessKeyIdFrom(extra))`。
- 每个 handler 都改为接收 `(args, extra)`，并把 `extra` 传给 `serviceOf`。
- `apple_login` 调用 `sessions.create(account, tokenFamilyIdFrom(extra), accessKeyIdFrom(extra))`。
- `work_done` 调用 `sessions.destroy(args.session_id, accessKeyIdFrom(extra))`。
- 更新 `src/core/session.ts` 里 `TOKEN_FAMILY_KEY` 上方的注释，说明 `ACCESS_KEY_ID_KEY` 走的是同一条链路。

- [ ] **Step 8: 运行全量单测与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS；退出码为 0。不要用管道接 `tail`，那样会吞掉退出码。

- [ ] **Step 9: Commit**

```bash
git add src/core/session.ts src/modules tests/unit/core/session-ownership.test.ts tests/unit/server/tool-ownership.test.ts
git commit -m "feat(session): bind iCloud sessions to the calling access key"
```

### Task 2: 允许零账号、按会话判断权限、给信封账号用的 config 入口

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/modules/{mail,calendar,reminders,contacts}/service.ts`（各自的 `requireRead`/`requireWrite` 的 hint）
- Modify: `src/server/createServer.ts`
- Test: `tests/unit/core/config-envelope.test.ts`（新建）
- Test: `tests/unit/server/register.test.ts`（追加用例）

**Interfaces:**
- Produces:
  - `AccountConfig.origin?: 'env' | 'envelope'`：未设置时等同于 `'env'`。
  - `loadConfig(env: NodeJS.ProcessEnv, options?: { allowNoAccounts?: boolean }): AppConfig`
  - `export const ENVELOPE_ENV_KEYS: readonly string[]`：值就是那 12 个白名单变量。
  - `export function accountFromEnvelopeEnv(env: Record<string, unknown>): { account: AccountConfig; notices: string[] }`
    - 先过滤：只保留白名单里、值为 string 的键，其余丢弃。
    - 再调用 `parseAccount(filtered, 1)`。返回 `undefined` 时抛 `AppError('INVALID_INPUT', '信封里没有账号信息', { hint: '确认 .env 里设置了 ICLOUD_ACCOUNT_1 与 ICLOUD_APP_PASSWORD_1 后重新生成信封' })`。
    - 返回的 account 带 `origin: 'envelope'`，`id` 为 `'account_1'`。
  - `export function capabilityHint(account: AccountConfig, stem: string): string`
    - `stem` 形如 `'ALLOW_MAIL_READ'`。
    - env 账号返回 `设置环境变量 ${stem}_${n}=true 后重启服务`（`n` 取自 `account.id`），也就是今天的原文。
    - 信封账号返回 `在你自己的 .env 里把 ${stem}_1 设为 true，重新生成信封后再登录`。
  - `HttpConfig.envelopeKeyPath: string`：取 `clean(env.ENVELOPE_KEY_PATH) ?? join(dirname(tokenStorePath), 'envelope-key.json.enc')`。
  - `ServerDeps.registerAllModules?: boolean`：为 true 时，`registerAllTools` 不再看账号能力，四个模块全部注册。

- [ ] **Step 1: 写失败测试 `tests/unit/core/config-envelope.test.ts`**

用例：
- `loadConfig still refuses zero accounts by default`：`loadConfig({})` 抛 `INVALID_INPUT`。
- `loadConfig accepts zero accounts when allowed`：`loadConfig({}, { allowNoAccounts: true }).accounts` 是 `[]`。
- `accountFromEnvelopeEnv applies the iCloud sender guard`：传入 `{ ICLOUD_ACCOUNT_1: 'x@gmail.com', ICLOUD_APP_PASSWORD_1: 'p', ALLOW_MAIL_READ_1: 'true' }`，`account.capabilities.mailRead === false`，且 `notices.length === 1`。fixture 里显式写了 `ALLOW_MAIL_READ_1: 'true'`，所以邮件被关掉只能是域名保护起的作用。
- `accountFromEnvelopeEnv keeps write defaults off`：传入 `{ ICLOUD_ACCOUNT_1: 'x@icloud.com', ICLOUD_APP_PASSWORD_1: 'p' }`，结果中 `mailWrite`、`calendarWrite`、`remindersWrite`、`contactsWrite` 都为 `false`。
- `accountFromEnvelopeEnv rejects a malformed boolean`：`ALLOW_CALENDAR_WRITE_1: 'yess'` 抛 `INVALID_INPUT`。
- `accountFromEnvelopeEnv ignores non-whitelisted and other-slot keys`：传入 `ICLOUD_ACCOUNT_2`、`LOG_LEVEL`、`PUBLIC_URL`，返回的 account 和不传这些键时一模一样（用 `toEqual` 比较）。
- `accountFromEnvelopeEnv marks origin envelope`：`account.origin === 'envelope'`。
- `capabilityHint differs by origin`：两种来源的账号各断言一条完整字符串。
- `loadHttpConfig derives envelopeKeyPath next to the token store`：`TOKEN_STORE_PATH=/data/tokens.json.enc` 时，结果是 `path.join('/data', 'envelope-key.json.enc')`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/core/config-envelope.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 `src/core/config.ts` 实现**

`parseAccount` 保持私有，`accountFromEnvelopeEnv` 是唯一新增的外部入口。

- [ ] **Step 4: 把四个 service 的 hint 改为调用 `capabilityHint(account, 'ALLOW_X_Y')`**

env 账号拿到的字符串必须和今天的逐字相同。现有的 service 测试如果断言了 hint 原文，应当不需要任何改动就能通过。

- [ ] **Step 5: 在 `tests/unit/server/register.test.ts` 追加失败测试**

- `registerAllModules registers all 25 tools with zero accounts`：`config.accounts = []` 时，collector 收到 25 个名字。
- `without registerAllModules zero accounts registers only the 3 session tools`：只收到 `apple_accounts`、`apple_login`、`work_done`。这一条锁住 stdio/CLI 的行为不变。

- [ ] **Step 6: 实现 `registerAllModules`，然后运行**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/modules src/server/createServer.ts tests/unit/core/config-envelope.test.ts tests/unit/server/register.test.ts
git commit -m "feat(config): allow zero accounts for the remote entry and parse envelope accounts through parseAccount"
```

### Task 3: AuthStore 存放访问密钥与设置

**Files:**
- Modify: `src/auth/store.ts`
- Test: `tests/unit/auth/store-access-keys.test.ts`（新建）

**Interfaces:**
- Produces（全部挂在 `AuthStore` 上）：
  - `interface AccessKeyRecord { id: string; name: string; key_hash: string; created_at: number; enabled: boolean; last_used_at?: number }`
  - `StoredToken.access_key_id?: string`
  - `createAccessKey(name: string): Promise<{ record: AccessKeyRecord; plaintext: string }>`
  - `listAccessKeys(): AccessKeyRecord[]`：按 `created_at` 升序。
  - `getAccessKey(id: string): AccessKeyRecord | undefined`
  - `findAccessKeyByPlaintext(plaintext: string): AccessKeyRecord | undefined`：不管 enabled 与否都返回，由调用方判断。
  - `setAccessKeyEnabled(id: string, enabled: boolean): Promise<boolean>`
  - `deleteAccessKey(id: string): Promise<boolean>`
  - `revokeFamiliesByAccessKey(id: string): Promise<string[]>`：删掉这把密钥名下的全部令牌记录，返回被删的 family id，已去重。
  - `touchAccessKey(id: string, now?: number): void`
  - `getSettings(): { envAccountsEnabled: boolean }`
  - `setEnvAccountsEnabled(enabled: boolean): Promise<void>`

- [ ] **Step 1: 写失败测试 `tests/unit/auth/store-access-keys.test.ts`**

用临时目录里的真实文件。用例：
- `created key plaintext has the amk_ shape and is never persisted`：
  - 明文匹配 `/^amk_[A-Za-z0-9_-]{43}$/`；
  - 用同一个 key 调 `decryptJson` 解密落盘文件，再 `JSON.stringify` 一遍，结果不包含这个明文，但包含 `hashToken(明文)`。
- `findAccessKeyByPlaintext returns the record, disabled or not`
- `keys and settings survive a reload`：
  - 新建两把密钥、把开关设为 true；
  - 用同一路径、同一 key 新建一个 store 并 `load()`；
  - `listAccessKeys()` 的 name 依次为两把密钥的名字，`getSettings().envAccountsEnabled === true`。
- `an old snapshot without access_keys or settings loads with defaults`：
  - 用 `encryptJson({ clients: [], tokens: [<一条没有 access_key_id 的令牌>] }, key)` 手工写出文件；
  - `load()` 不抛错，`listAccessKeys()` 为 `[]`，`getSettings().envAccountsEnabled === false`；
  - 那条旧令牌仍然能通过 `findByAccessToken` 查到。是否放行由 provider 决定，见 Task 4。
- `revokeFamiliesByAccessKey removes only that key's families`
- `touchAccessKey persists at most once per 60 seconds per key`：
  - 用注入的 `now`，把落盘函数换成计数器（或者看文件的 mtime 和内容是否变化）；
  - `touch(id, 0)` 落盘一次；`touch(id, 30_000)` 不落盘，但内存里的 `last_used_at === 30_000`；`touch(id, 61_000)` 再落盘一次。
- `decrypt failure hint names the token store file and its consequences`：
  - 用错误的 key 去 `load()`；
  - 错误的 `hint` 包含 `tokens.json.enc` 这个文件名，也包含 `访问密钥`。删掉它会丢失访问密钥，这一点必须在提示里说出来。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/auth/store-access-keys.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 `src/auth/store.ts` 实现**

- `StoreSnapshot` 增加 `access_keys?: AccessKeyRecord[]` 与 `settings?: { env_accounts_enabled: boolean }`，`load()` 时缺失的字段按默认值处理。
- 维护一个 `byKeyHash` 索引。
- `touchAccessKey` 的落盘走现有的 `persist()` 队列，fire-and-forget，`.catch` 后只用 `logger.warn` 记录错误名。
- 解密失败的 hint 改为：`TOKEN_ENCRYPTION_KEY 可能变了，或 <文件名> 已损坏。删除这个文件会清空全部访问密钥与已授权的客户端，所有人都要重新授权；信封密钥对存放在另一个文件里，不受影响。`

- [ ] **Step 4: 运行**

Run: `npx vitest run tests/unit/auth/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/store.ts tests/unit/auth/store-access-keys.test.ts
git commit -m "feat(auth): persist access keys and settings in the encrypted store"
```

### Task 4: OAuth 授权页改用访问密钥，密钥 id 贯穿令牌链

**Files:**
- Modify: `src/auth/login.ts`
- Modify: `src/auth/provider.ts`
- Modify: `src/server/httpApp.ts`（只改登录表单路由）
- Modify: `tests/unit/server/http-e2e.test.ts`
  - `startServer` 里建一把密钥；
  - `runFullAuthFlow` 改为 POST `/access-login`，提交 `access_key`；
  - `runFullAuthFlow` 返回值增加 `accessKeyId`。
- Modify: `tests/unit/auth/login.test.ts`、`tests/unit/auth/provider-tokens.test.ts`（跟着新签名改）
- Test: `tests/unit/auth/access-key-login.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `AuthStore` 访问密钥方法；Task 1 的 `ACCESS_KEY_ID_KEY`。
- Produces:
  - 登录表单 POST 到 `/access-login`，字段为 `request_id`、`access_key`；输入框标签为 `访问密钥`，`type="password"`，`autocomplete="off"`。
  - `LoginDeps`：`{ findAccessKey(plaintext: string): AccessKeyRecord | undefined; provider: AppleOAuthProvider; logger: Logger; pending: PendingStore }`，原来的 `adminPasswordHash` 删除。
  - `handleLoginSubmit(deps, { requestId: string; accessKey: string }): { redirectTo: string } | { error: string } | { alreadyCompleted: true }`
  - `PendingStore.wasCompleted(requestId: string): boolean`：`take()` 成功后记下这个 id，保留到原请求的 `expires_at`；`sweep` 时一并清理。
  - `export function renderAlreadyCompletedPage(): string`：标题「授权已完成」，正文「这次授权已经完成，可以关闭此页，回到 Claude 继续。」
  - `export function escapeHtml(input: string): string`：从 login.ts 导出，供 Task 6 复用。
  - `issueAuthorizationCode(params: { clientId; redirectUri; codeChallenge; scopes; accessKeyId: string }): string`
  - `createOAuthProvider` 的 deps 增加 `accessKeys: Pick<AuthStore, 'getAccessKey' | 'touchAccessKey'>`。生产环境直接传 store。

- [ ] **Step 1: 写失败测试 `tests/unit/auth/access-key-login.test.ts`**

使用真实的 provider、store 和 pending store。用例：
- `a valid enabled key issues a code that carries the key id through to AuthInfo.extra`：
  - 走一遍 `handleLoginSubmit`、`exchangeAuthorizationCode`、`verifyAccessToken`；
  - 结果的 `extra.accessKeyId === record.id`，`extra.tokenFamilyId` 是一个非空字符串。
- `a wrong or disabled key gets the same error`：两种情况都返回 `{ error: '访问密钥不正确或已停用，请重试' }`，并且之后同一个 requestId 仍然可以用正确的密钥提交成功。
- `the admin password is no longer accepted on the authorization page`：`accessKey` 传管理员口令明文，返回上面那个 error。
- `a second submit of a completed request reports alreadyCompleted`：第一次提交得到 `redirectTo`，第二次用同样的参数得到 `{ alreadyCompleted: true }`。
- `disabling the key between login and code exchange makes the exchange fail`：在 `handleLoginSubmit` 之后、兑换之前调用 `setAccessKeyEnabled(id, false)`；兑换时抛 `InvalidGrantError`，消息是 ASCII。
- `verifyAccessToken rejects tokens of a disabled or deleted key`：抛 `InvalidTokenError`，消息匹配 `/^[\x20-\x7e]+$/`。
- `verifyAccessToken rejects a legacy token without access_key_id`：直接用 `store.saveTokens` 写入一条不带 `access_key_id` 的记录；用它调 verify 时抛 `InvalidTokenError`。
- `refresh keeps access_key_id and refuses a disabled key`：
  - 正常刷新后的新令牌，verify 得到同一个 `accessKeyId`；
  - 禁用密钥后再刷新，抛 `InvalidGrantError`。
- `verifyAccessToken updates last_used_at`：verify 之后，`getAccessKey(id).last_used_at` 已被设置。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/auth/access-key-login.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 login.ts 与 provider.ts 的改动**

- `PendingCode` 增加 `access_key_id`，`buildTokenPair` 增加 `accessKeyId` 参数并写进 `StoredToken`。
- 新增的错误消息（必须 ASCII）：
  - `'access key disabled or removed; re-authorize'`
  - `'access token predates access keys; re-authorize'`

- [ ] **Step 4: 修改 httpApp.ts 的路由**

- 原 `app.post('/admin-login', …)` 改为 `app.post('/access-login', …)`，handler 读取 `access_key` 字段。
- `{ alreadyCompleted }` 时返回 200，内容为 `renderAlreadyCompletedPage()`，带 `LOGIN_PAGE_HEADERS`。
- 限流照旧。
- 同步更新这段路由上方的注释，以及 `renderLoginPage` 的 `action`。

- [ ] **Step 5: 修改 http-e2e 的辅助函数与旧的 login/provider 测试**

- `startServer` 用 `store.createAccessKey('e2e')` 建一把密钥，把明文放进 `TestServer.accessKey`。
- `runFullAuthFlow(base, accessKey)`
- 旧测试只跟着新签名调整；断言内容不变的，不要放宽。

- [ ] **Step 6: 运行**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/auth src/server/httpApp.ts tests/unit/auth tests/unit/server/http-e2e.test.ts
git commit -m "feat(auth): authorize with per-person access keys and thread the key id through every token"
```

### Task 5: MCP transport 归属、切断某把密钥、远程登录模式

**Files:**
- Modify: `src/server/httpApp.ts`
- Modify: `src/modules/session/tools.ts`
- Modify: `src/server/createServer.ts`（透传 `remote`）
- Test: `tests/unit/server/http-e2e.test.ts`（追加 describe 块）
- Test: `tests/unit/modules/session-tools.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `destroyMatching`、`accessKeyIdFrom`；Task 3 的 `getSettings`、`revokeFamiliesByAccessKey`；Task 2 的 `registerAllModules`。
- Produces:
  - `export interface RemoteLoginDeps { envAccountsEnabled(): boolean; openEnvelope?: (text: string) => { account: AccountConfig; notices: string[] } }`，位于 `src/modules/session/tools.ts`。
  - `SessionToolDeps.remote?: RemoteLoginDeps`，`ServerDeps.remote?: RemoteLoginDeps`。
  - `CreateHttpAppDeps.store: AuthStore`（新增必填），以及 `CreateHttpAppDeps.envelope?: { publicKeyText: string; open: (text: string) => { account: AccountConfig; notices: string[] } }`（Task 10 才会传入）。
  - `HttpApp.cutOffAccessKey(keyId: string): Promise<void>`：依次执行 `store.revokeFamiliesByAccessKey` → `sessions.destroyMatching(s => s.ownerKeyId === keyId)` → 关闭 `entries` 中 `ownerKeyId === keyId` 的 transport 并从表中删除。
  - `HttpApp.onEnvAccountsDisabled(): Promise<void>`：执行 `sessions.destroyMatching(s => s.account.origin !== 'envelope')`。
  - `McpEntry.ownerKeyId?: string`

`apple_login` 在 `remote` 存在时的行为：
- 只有 `remote.openEnvelope` 存在时，schema 才增加 `envelope: z.string().optional()`，与 `account` 互斥。两者都给时报 `INVALID_INPUT`。
- 没给 `envelope`，且 `remote.envAccountsEnabled()` 为 false 时，报 `AppError('INVALID_INPUT', '这台服务器只接受加密信封登录', { hint: '运行 node scripts/make-envelope.mjs，把它输出的一整行原样作为 envelope 参数传给 apple_login' })`。
- `apple_accounts` 在 `remote` 存在且 `!envAccountsEnabled()` 时返回 `[]`。
- `remote` 为 undefined（stdio/CLI）时，两个工具的行为与 schema 和今天逐字相同。

- [ ] **Step 1: 在 session-tools.test.ts 追加失败测试**

- `remote mode with env accounts disabled refuses login without an envelope`：config 里有账号，但 `envAccountsEnabled: () => false`；返回的错误码为 `INVALID_INPUT`，并且 `sessions.create` 没有被调用。
- `remote mode with env accounts disabled lists no accounts`
- `remote mode with env accounts enabled logs in as today`
- `without remote the schema has no envelope field`：`Object.keys(inputSchema)` 等于 `['account']`。

- [ ] **Step 2: 在 http-e2e 追加失败测试（describe `multi-person isolation`）**

`startServer` 改成可以建两把密钥 A 和 B，并接受 `{ envAccountsEnabled }` 参数，默认 true，这样现有用例不受影响。

用例：
- `B cannot use A's mcp-session-id`：
  - A 完成 initialize，拿到 `mcpSessionId`；
  - B 用自己的令牌、带上 A 的 `mcp-session-id`，发 `tools/list`，返回 400；
  - B 用同一 id 发 `DELETE /mcp`，返回 400，之后 A 用这个 id 仍然能 `tools/list`，返回 200。
- `cutting off A destroys A's sessions and transports but not B's`：
  - A、B 各通过 `loginThroughMcp` 建一个会话；
  - 调用 `srv.cutOffAccessKey(A)`；
  - 断言 `srv.sessions.get(sessionA)` 抛 `SESSION_EXPIRED`，用底层不带归属检查的方式确认（或者用 `size() === 1` 加上 `get(sessionB, B)` 成功）；
  - A 的令牌调 `/mcp` 返回 401；
  - B 的 `tools/list` 返回 200。
  - **断言的是会话从 store 里消失，不是只看 401。**
- `env accounts disabled: apple_login without envelope fails through /mcp`：`startServer({ envAccountsEnabled: false })` 时，`apple_login` 返回 `isError`，错误码为 `INVALID_INPUT`，`srv.sessions.size() === 0`。
- `remote entry registers all 25 tools even with zero env accounts`：config 的 `accounts: []`，`tools/list` 返回 25 个工具。

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/unit/modules/session-tools.test.ts tests/unit/server/http-e2e.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**

- `createMcpRouteHandler` 在 initialize 时取 `accessKeyIdFrom({ authInfo: req.auth })` 写入 `newEntry.ownerKeyId`。
- 之后的每个请求，如果 entry 存在但 `entry.ownerKeyId !== 调用方`，就按"找不到 entry"处理，走现有的 400 分支。
- `createServer` 的调用改为传入 `registerAllModules: true` 和 `remote: { envAccountsEnabled: () => store.getSettings().envAccountsEnabled, openEnvelope: deps.envelope?.open }`。

- [ ] **Step 5: 运行**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server src/modules/session/tools.ts tests/unit/server/http-e2e.test.ts tests/unit/modules/session-tools.test.ts
git commit -m "feat(http): bind mcp transports to access keys, add key cut-off and envelope-only login mode"
```

### Task 6: 管理页 `/admin`

**Files:**
- Create: `src/server/adminPages.ts`：纯渲染函数。
- Create: `src/server/admin.ts`：express Router，以及管理页会话。
- Modify: `src/server/httpApp.ts`：在 `mcpAuthRouter` 之前挂载。
- Test: `tests/unit/server/admin.test.ts`（新建，用真实端口，写法照 http-e2e）

**Interfaces:**
- Consumes:
  - Task 3 的 store 方法；
  - Task 4 的 `escapeHtml`、`LOGIN_PAGE_HEADERS`/`applyLoginPageHeaders`；
  - Task 5 的 `cutOffAccessKey`、`onEnvAccountsDisabled`；
  - `verifyPassword`。
- Produces:
  - `export function createAdminRouter(deps: AdminRouterDeps): express.Router`
  - `interface AdminRouterDeps { adminPasswordHash: string; store: AuthStore; publicUrl: URL; logger: Logger; cutOffAccessKey(id: string): Promise<void>; onEnvAccountsDisabled(): Promise<void>; envAccountCount: number; envelopePublicKey?: string; now?: () => number }`
  - 路由：

    | 方法 | 路径 | 行为 |
    |---|---|---|
    | GET | `/admin` | 未登录显示登录页，已登录显示面板 |
    | POST | `/admin/login` | 限流同 `/access-login`；成功后设 cookie，303 → `/admin` |
    | POST | `/admin/logout` | |
    | POST | `/admin/keys` | 字段 `name`，去掉首尾空白后长度 1–64；成功时 **直接以 200 渲染面板并附带新密钥明文**，不重定向，免得明文进 URL |
    | POST | `/admin/keys/:id/disable` | 先 `setAccessKeyEnabled(false)`，再 `cutOffAccessKey`，303 |
    | POST | `/admin/keys/:id/enable` | 303 |
    | GET | `/admin/keys/:id/destroy` | 显示确认页 |
    | POST | `/admin/keys/:id/destroy` | 先 `cutOffAccessKey`，再 `deleteAccessKey`，303 |
    | POST | `/admin/settings/env-accounts` | 字段 `enabled` 取 `'true'`/`'false'`；从 true 改为 false 时调用 `onEnvAccountsDisabled`，303 |

  - 面板内容：
    - 密钥表格，列为名字、创建时间、状态（启用/已停用）、上次使用（从未使用时显示 `从未`）。时间用 ISO 字符串加 UTC 标注，不依赖服务器时区。
    - 新建表单。
    - env 开关，旁边的说明文字：`打开后，任何一把有效的访问密钥都能登录服务器 .env 里配置的 ${envAccountCount} 个账号。`
    - `envelopePublicKey` 存在时，显示公钥一行和说明：`把这一行发给使用者，写进他的 MCP_ENVELOPE_PUBKEY。`
  - 每个响应都加 `LOGIN_PAGE_HEADERS`。
  - **所有** POST（包括 login）都要求 `Origin` 头等于 `publicUrl.origin`，否则返回 403。未登录访问任何非 login 的 POST，303 → `/admin`。

- [ ] **Step 1: 写失败测试 `tests/unit/server/admin.test.ts`**

用例：
- `GET /admin without a session shows the login form, never key data`
- `wrong admin password is rejected, right one sets an HttpOnly SameSite=Strict cookie scoped to /admin`
- `POST without a matching Origin is 403 even with a valid cookie`：分别测缺少 `Origin` 头和 `Origin` 为 `https://evil.example` 两种情况。
- `creating a key shows the plaintext once and the dashboard lists it afterwards without it`：
  - 新建时返回的 HTML 含 `amk_` 明文；
  - 随后 `GET /admin` 的 HTML 含名字，不含明文。
- `key names are HTML-escaped`：名字为 `<script>x</script>` 时，页面里出现的是 `&lt;script&gt;`。
- `disable calls cutOffAccessKey and the row shows 已停用`
- `destroy requires the confirm POST and removes the row`
- `turning env accounts off calls onEnvAccountsDisabled; turning on does not`
- `admin session expires after 30 idle minutes`：注入 `now`。
- `/admin responses carry no-store and frame-ancestors 'none'`

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/server/admin.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 adminPages.ts 与 admin.ts，在 httpApp 中挂载**

- 管理页会话表：`Map<hashToken(cookie值), { lastActiveAt }>`。cookie 值由 `generateToken()` 生成；每次请求按 30 分钟空闲判断并刷新。
- 页面样式沿用 `renderLoginPage` 的极简内联样式。
- 不要用任何 `<script>`。删除确认用服务端渲染的页面，不用 `confirm()`。

- [ ] **Step 4: 运行**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/admin.ts src/server/adminPages.ts src/server/httpApp.ts tests/unit/server/admin.test.ts
git commit -m "feat(admin): add the access-key management page"
```

### Task 7: 阶段一接入 `bin/http.ts`

**Files:**
- Modify: `src/bin/http.ts`
- Modify: `.env.example`（远程部分的注释：VPS 上不再需要 iCloud 账号）

**Interfaces:**
- Consumes: Task 2–6 的全部产出。

- [ ] **Step 1: 修改 `bin/http.ts`**

- `loadConfig(process.env, { allowNoAccounts: true })`。
- `createHttpApp` 传入 `store`。
- 启动后，如果 `config.accounts.length > 0 && !store.getSettings().envAccountsEnabled`，打一条警告：`logger.warn('env accounts are configured but disabled; enable them on /admin or remove them from .env', { accounts: config.accounts.length })`。
- `ready` 日志里的 `accounts` 字段保留。

- [ ] **Step 2: 手工冒烟（本地，不连 iCloud）**

Run（PowerShell，在临时目录里准备一份只有 HTTP 变量、没有账号的环境）：先 `npm run build`，再用 `PUBLIC_URL=http://127.0.0.1:17733`、一个临时的 `ADMIN_PASSWORD_HASH`、`TOKEN_ENCRYPTION_KEY`、`TOKEN_STORE_PATH=<临时目录>` 启动 `node dist/bin/http.js`。

Expected：
- 进程正常启动；
- `GET /health` 返回 200；
- `GET /admin` 返回登录页；
- 浏览器登录后能新建一把密钥。

结束后停掉进程，删除临时目录。

- [ ] **Step 3: 全量**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部退出码为 0

- [ ] **Step 4: Commit**

```bash
git add src/bin/http.ts .env.example
git commit -m "feat(http): start without env accounts and warn when they are configured but disabled"
```

---

## 阶段二：加密信封

### Task 8: 服务端信封密钥对 `keyring`

**Files:**
- Create: `src/auth/keyring.ts`
- Test: `tests/unit/auth/keyring.test.ts`

**Interfaces:**
- Produces:
  - `export interface EnvelopeKeyring { publicKeyText: string; kid: string; publicKeyRaw: Buffer; privateKey: KeyObject }`
  - `export async function loadOrCreateEnvelopeKeyring(opts: { path: string; encryptionKey: Buffer; logger: Logger }): Promise<EnvelopeKeyring>`
    - 文件不存在时：用 `generateKeyPairSync('x25519')` 生成；把 `encryptJson({ v: 1, jwk: privateKey.export({ format: 'jwk' }) }, key)` 原子写入（临时文件加 rename，写法同 store.ts），权限 0600；打一条 `info` 日志 `generated a new envelope key pair`，不带任何密钥材料。
    - 文件存在时：解密后导入。
    - 解密失败时：抛 `AppError('INTERNAL', '信封密钥文件无法解密', { hint: 'TOKEN_ENCRYPTION_KEY 可能变了。删除 <path> 后重启会生成新的密钥对：访问密钥与令牌不受影响，但所有使用者都要换新的 MCP_ENVELOPE_PUBKEY。' })`。
  - `export function kidOf(publicKeyRaw: Buffer): string`

- [ ] **Step 1: 写失败测试**

- `public key text has the amp1_ shape`：匹配 `/^amp1_[A-Za-z0-9_-]{43}$/`。
- `the same file yields the same key pair across reloads`：调用两次 `loadOrCreate`，两次的 `publicKeyText` 相同，`kid` 也相同。这是 Review Focus 第 2 条。
- `the file on disk contains no raw key material`：用 `JSON.stringify` 和 base64 搜索文件内容，找不到私钥 `d` 字段的原文。
- `a wrong encryption key fails with the hint naming the file`
- `deleting the file regenerates a different key pair`
- `file mode is 0600 on POSIX`：在 `process.platform === 'win32'` 时 `it.skip`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/auth/keyring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- 原始公钥用 `publicKey.export({ format: 'jwk' }).x` 取得，它本身就是 base64url 编码的 32 字节。
- 从 JWK 导入私钥用 `createPrivateKey({ key: jwk, format: 'jwk' })`。

- [ ] **Step 4: 运行**

Run: `npx vitest run tests/unit/auth/keyring.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/keyring.ts tests/unit/auth/keyring.test.ts
git commit -m "feat(auth): persist an X25519 envelope key pair in its own encrypted file"
```

### Task 9: 客户端脚本 `scripts/make-envelope.mjs`

**Files:**
- Create: `scripts/make-envelope.mjs`
- Test: `tests/unit/scripts/make-envelope.test.ts`（新建目录）

**Interfaces:**
- Produces（ESM 导出；只有被直接运行时才执行 main，判断方式为 `import.meta.url === pathToFileURL(process.argv[1]).href`）：
  - `export function parseDotenv(text: string): Record<string, string>`
    - 按 `\r?\n` 分行；
    - 跳过空行和 `#` 开头的行；
    - 允许 `export ` 前缀；
    - 值两侧的一对 `"…"` 或 `'…'` 会被去掉；
    - 未加引号的值去掉首尾空白，`" #"` 之后的内容视为行内注释。
  - `export function collectEnvelopeEnv(source: Record<string, string | undefined>): Record<string, string>`
    - 只取 12 个白名单变量里非空的那些。
    - 缺少 `ICLOUD_ACCOUNT_1` 或 `ICLOUD_APP_PASSWORD_1` 时抛 `Error('缺少环境变量 <名字>')`。
    - `source` 里存在 `ICLOUD_ACCOUNT_2..5` 中任意一个时，抛 `Error('配置了多个账号：信封一次只装一个账号（_1）')`。
  - `export function sealEnvelope(publicKeyText: string, env: Record<string, string>, now?: number): string`：算法完全按 Global Constraints。nonce 用 `randomBytes(16)`。
  - main：
    - 参数只接受 `--env-file <path>`。没给时，如果 cwd 下有 `.env` 就读它。
    - 合并规则同 dotenv：进程环境里已有的变量优先。
    - 公钥取自合并后的 `MCP_ENVELOPE_PUBKEY`，格式不对时报错 `MCP_ENVELOPE_PUBKEY 格式不对（应以 amp1_ 开头）`，不打印它的值。
    - 成功：stdout 写 `信封 + '\n'`，退出码 0。
    - 任何失败：stderr 写一行中文原因，退出码 1。

- [ ] **Step 1: 写失败测试 `tests/unit/scripts/make-envelope.test.ts`**

测试里要能验证密文。为了不依赖 Task 10，在测试文件里写一个约 20 行的本地 `openForTest(envelope, privateKey)`，严格按 Global Constraints 解密。Task 10 的服务端实现会和这个脚本交叉验证。

用例：
- `parseDotenv handles CRLF, quotes, export and comments`：输入 `'# c\r\nexport ICLOUD_ACCOUNT_1="a@icloud.com"\r\nICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop  # note\r\n'`，结果为 `{ ICLOUD_ACCOUNT_1: 'a@icloud.com', ICLOUD_APP_PASSWORD_1: 'abcd-efgh-ijkl-mnop' }`，值里不含 `\r`。这是 Review Focus 第 5 条。
- `collectEnvelopeEnv keeps only whitelisted _1 keys`
- `collectEnvelopeEnv refuses a second account`
- `sealEnvelope output decrypts to the same env with a fresh 16-byte nonce and the given iat`：同一个输入封两次，两次的 nonce 不同。
- `sealEnvelope binds the kid`：解开 `ame1.` 之后的 JSON，`kid === kidOf(公钥原始)`；把 kid 改掉以后，`openForTest` 因为 AAD 不匹配而失败。
- `the script as a child process prints exactly one envelope line and nothing else`：
  - 用 `spawnSync(process.execPath, ['scripts/make-envelope.mjs', '--env-file', tmp])` 运行；
  - stdout 匹配 `/^ame1\.[A-Za-z0-9_-]+\n$/`；stderr 为空；退出码 0。
- `the script never echoes the password, on success or failure`：
  - 成功路径：stdout 和 stderr 都不含密码明文；
  - 失败路径（删掉 `MCP_ENVELOPE_PUBKEY`）：退出码 1，stderr 含 `MCP_ENVELOPE_PUBKEY`，不含密码。
- `process env wins over the file`

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/scripts/make-envelope.test.ts`
Expected: FAIL（脚本不存在）

- [ ] **Step 3: 实现脚本**

- 风格参照 `scripts/probe-network.mjs`：零依赖，顶部注释说明用途和"绝不打印凭据"。
- 用 `createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' })` 导入服务端公钥。

- [ ] **Step 4: 运行**

Run: `npx vitest run tests/unit/scripts/make-envelope.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/make-envelope.mjs tests/unit/scripts/make-envelope.test.ts
git commit -m "feat(scripts): add make-envelope to seal the routine's .env for remote login"
```

### Task 10: 服务端解开信封，`apple_login({ envelope })` 端到端

**Files:**
- Create: `src/auth/envelope.ts`
- Modify: `src/modules/session/tools.ts`（信封分支，以及响应里的 `notices`）
- Modify: `src/server/httpApp.ts`、`src/bin/http.ts`（加载 keyring，创建 opener，传入 `envelope` 与 `envelopePublicKey`，sweeper 里加入 `opener.sweep()`）
- Test: `tests/unit/auth/envelope.test.ts`
- Test: `tests/unit/server/http-e2e.test.ts`（追加 describe `envelope login`）

**Interfaces:**
- Consumes: Task 8 的 `EnvelopeKeyring`；Task 2 的 `accountFromEnvelopeEnv`；Task 9 的 `sealEnvelope`（只在测试里用）。
- Produces:
  - `export const ENVELOPE_MAX_AGE_MS = 300_000`、`export const ENVELOPE_MAX_FUTURE_SKEW_MS = 60_000`
  - `export function createEnvelopeOpener(deps: { keyring: EnvelopeKeyring; now?: () => number }): { open(text: string): { account: AccountConfig; notices: string[] }; sweep(now?: number): number }`
  - `apple_login` 的成功响应在 `notices.length > 0` 时增加 `notices: string[]` 字段，env 账号和信封账号都适用。

`open` 的校验顺序，每一步失败都抛 `AppError('INVALID_INPUT', …)`：

1. `text.trim()` 不以 `ame1.` 开头，或 JSON / 字段不合法 → `信封格式不对`。hint：`把 make-envelope.mjs 输出的那一整行原样传入，不要加引号或改动`。
2. `kid` 不匹配 → `信封是用另一把公钥加密的`。hint：`向服务器主人要当前的公钥，更新 MCP_ENVELOPE_PUBKEY 后重新生成信封`。
3. 解密失败 → `信封无法解密`，hint 同第 2 条。
4. 载荷不合法（`v !== 1`、nonce 解码后不足 16 字节、`iat` 不是有限数、`env` 不是对象）→ `信封内容不完整`。hint：`用仓库里最新的 make-envelope.mjs 重新生成`。
5. `iat` 不在时间窗内 → `信封已过期`。hint：`重新运行 node scripts/make-envelope.mjs 生成新信封后再试一次`。
6. nonce 已经用过 → `这个信封已经用过`，hint 同第 5 条。
7. 记下 nonce（有效期到 `iat + ENVELOPE_MAX_AGE_MS`）→ `accountFromEnvelopeEnv(payload.env)`。

日志只记录失败的类别，例如 `logger.warn('envelope rejected', { reason: 'expired' })`，绝不记录信封内容或载荷。

- [ ] **Step 1: 写失败测试 `tests/unit/auth/envelope.test.ts`**

从 `../../../scripts/make-envelope.mjs` 导入 `sealEnvelope`，这就是交叉验证。用例：
- `opens what the script sealed and builds the account through parseAccount`：`account.origin === 'envelope'`，`appPassword` 等于封进去的值。
- `accepts surrounding whitespace and a trailing newline`：`open('  ' + env + '\n')` 成功。这是 Review Focus 第 4 条。
- `a quoted envelope is a format error, not INTERNAL`：`open('"' + env + '"')` 的错误码是 `INVALID_INPUT`，消息为 `信封格式不对`。
- `the same envelope is refused the second time`
- `iat 5 minutes + 1 ms old is refused; 1 minute ahead is accepted; 1 minute + 1 ms ahead is refused`：注入 `now`。
- `an envelope sealed for another key pair reports the key mismatch`
- `sweep forgets nonces only after their window has passed`：
  - 在 `iat + 299_999` 时 sweep，同一个信封仍然被拒，理由是"用过"；
  - 在 `iat + 300_001` 时 sweep 之后，同一个信封的拒绝理由是"过期"，不是"用过"。
- `a Gmail Apple ID in the envelope comes back with mail disabled and a notice`

- [ ] **Step 2: 在 http-e2e 追加失败测试**

`startServer({ envAccountsEnabled: false, withEnvelope: true })`：用临时路径加载一个 keyring，传入 opener 和公钥。用例：
- `a friend logs in with an envelope, uses a tool, and work_done ends it`：
  - 用 B 的令牌加 `sealEnvelope` 产生的信封调 `apple_login`，成功；
  - `srv.sessions.size() === 1`；
  - 调用一个替身 provider 能应答的读工具（例如 `calendar_list`，替身的 `caldav` 需要补上 `listCalendars` 返回 `[]`），成功；
  - `work_done` 之后 `size() === 0`。
- `replaying the same envelope through /mcp is refused`
- `the admin dashboard shows the envelope public key`：登录 `/admin` 后，HTML 含 `keyring.publicKeyText`。
- `tools/list advertises envelope on apple_login`

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/unit/auth/envelope.test.ts tests/unit/server/http-e2e.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现并接线**

- `bin/http.ts`：`await loadOrCreateEnvelopeKeyring({ path: httpConfig.envelopeKeyPath, encryptionKey: httpConfig.encryptionKey, logger })` 必须放在 `listen` 之前，失败就退出，理由同 `store.load()`。
- `apple_login` 的 `envelope` 参数描述写：`远程入口的登录凭据：运行 node scripts/make-envelope.mjs 得到的一整行，原样传入。与 account 二选一。`

- [ ] **Step 5: 运行**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS，退出码均为 0

- [ ] **Step 6: Commit**

```bash
git add src/auth/envelope.ts src/modules/session/tools.ts src/server/httpApp.ts src/bin/http.ts tests/unit/auth/envelope.test.ts tests/unit/server/http-e2e.test.ts
git commit -m "feat(http): log in with a sealed envelope, single-use and time-boxed"
```

---

## 阶段三：文档与上线

### Task 11: SKILL.md、部署文档、CLAUDE.md、模板

**Files:**
- Modify: `SKILL.md`
- Modify: `docs/部署与-Routine-接入.md`
- Modify: `docs/沙盒-CLI-用法.md`
- Modify: `README.md`（Remote deployment / Limitations）
- Modify: `CLAUDE.md`（Non-obvious constraints）
- Create: `deploy/compose.vps.yml.example`、`deploy/nginx-site.conf.example`
  - 内容取自 `C:\Users\ZIQI\AppData\Local\Temp\claude\F--apple-mcp\41f8d24c-a1de-441a-8fec-cd2114884493\scratchpad\deploy\compose.vps.yml` 与 `…\site-https.conf`；
  - 域名换成 `mcp.example.com`；
  - 保留每一行注释的理由。

**Interfaces:** 无代码。

- [ ] **Step 1: SKILL.md**

- 「Which of these are you?」部分增加第三类读者：**远程连接器，并且手里有 shell 和这个仓库**。
- 这类读者的流程写成编号步骤：
  1. 在仓库根目录运行 `node scripts/make-envelope.mjs`，把 stdout 的那一整行原样作为 `apple_login` 的 `envelope` 参数。不要打印、复述或改动它。
  2. 正常调用工具。
  3. 最后调用 `work_done`。
- 错误表里 `INVALID_INPUT` 一行补充：信封过期或已用过时，重新生成一次再试，**只试一次**。
- 「Running unattended」部分补充：每次运行生成一个新信封，不要复用上次的。
- `apple_accounts` 的说明补充：远程信封模式下返回空数组属于正常情况。

- [ ] **Step 2: 部署文档与沙盒文档**

**`docs/部署与-Routine-接入.md`**：
- 对比表增加一列「远程 HTTP + 信封」，其中「凭据放在哪」一项为「每个人自己的 Routine 环境」。
- 新增一节「和别人共用一台服务器」：
  - 主人的步骤：进入 `/admin`，新建密钥，把密钥和公钥发给对方。
  - 朋友的步骤：在 claude.ai 添加连接器，授权页输入访问密钥；在 Routine 环境设置 `.env` 或环境变量，并加上 `MCP_ENVELOPE_PUBKEY`；Routine 拉取仓库、读取 SKILL.md。
  - 信任说明。
  - 「VPS 泄露怎么办」：朋友们重新生成 App 专用密码；主人删除 `envelope-key.json.enc` 后重启，再分发新公钥。
- 新增一节「放在宝塔或已有的 nginx 后面」，引用 `deploy/` 下的两个模板。
- 写上升级说明：升级后已有的连接器授权会失效，需要在 `/admin` 建一把自己的密钥后重新连接；env 账号默认关闭。

**`docs/部署与-Routine-接入.md:23` 与 `docs/沙盒-CLI-用法.md:5`**：
- 「cowork 沙盒」改为「Routine 的云端沙盒」。
- 写入实测结论（spec 4.8）：云端沙盒里 CLI 可以用日历、提醒事项、通讯录；邮件端口在「受限」「完全」两档网络下都被拦截，要用邮件就走远程连接器，或者设 `ALLOW_MAIL_READ_1=false`。

- [ ] **Step 3: README 与 CLAUDE.md**

**README**：Remote deployment 一节补充访问密钥、`/admin`、信封、`ENVELOPE_KEY_PATH`；Limitations 补充「VPS 在会话期间持有明文 App 密码」。

**CLAUDE.md** 新增三条约束，每条都写明「为什么」：
1. 会话归属检查只在 `SessionStore.get/destroy` 做，transport 归属在 `createMcpRouteHandler` 另做一层；不匹配时必须和"不存在"无法区分。
2. 信封账号必须经过 `accountFromEnvelopeEnv` → `parseAccount`，不允许另写解析，否则域名保护和写权限默认关闭的规则会失效。
3. env 账号开关默认关闭，因为一旦打开，任何密钥都能登录 env 账号。

Architecture 段落补充 `src/server/admin.ts`、`src/auth/keyring.ts`、`src/auth/envelope.ts`。

- [ ] **Step 4: 核对**

Run: `npm test`（确认文档改动没有碰到任何测试，例如 ids.test.ts 会扫描 service 文件）
Expected: PASS

逐一确认：SKILL.md 里出现的工具名、参数名、脚本路径，都和代码一致。

- [ ] **Step 5: Commit**

```bash
git add SKILL.md docs README.md CLAUDE.md deploy
git commit -m "docs: document access keys, the admin page, envelope login and the BT/nginx deployment"
```

### Task 12: 上线到 VPS（**每一步对外操作都先征得用户确认**）

**Files:** 无仓库改动。

- [ ] **Step 1: 推送**

推送前先问用户。确认后执行 `git push`。

- [ ] **Step 2: VPS 更新**

在 VPS 的 `~/icloud-mcp-http` 依次执行：
1. `git pull`
2. `docker build -t apple-icloud-mcp:local .`（约 5 分钟，会占用 swap）
3. `docker compose -p icloud-mcp -f compose.vps.yml up -d`

Expected：容器状态为 `healthy`；`curl -s https://icloudmcp.zzqhmbb.eu.org/health` 返回 `{"status":"ok"}`；容器日志里出现 `generated a new envelope key pair`。

- [ ] **Step 3: 交给用户的操作清单（由用户自己执行，Claude 不代为操作）**

1. 打开 `https://icloudmcp.zzqhmbb.eu.org/admin`，用管理员口令登录，给自己建一把密钥。
2. 在 claude.ai 删除并重新添加连接器，授权页输入这把密钥。
3. 复制公钥，写进 Routine 环境的 `MCP_ENVELOPE_PUBKEY`。
4. 在 Routine 里运行一次只读自检。

- [ ] **Step 4: 清除 VPS 上的 iCloud 凭据（要先等用户确认第 3 步的自检通过）**

确认后，从 VPS 的 `~/icloud-mcp-http/.env` 中删掉 `ICLOUD_*`/`ALLOW_*` 这几行（操作时不显示文件内容），然后重启容器，确认启动日志里没有 env 账号相关的警告。

- [ ] **Step 5: 更新记忆**

在 `vps-http-deployment.md` 中补记：密钥文件的位置、`/admin` 的用法，以及 VPS 上已经不再保存 iCloud 凭据。
