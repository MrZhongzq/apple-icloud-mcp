# Apple iCloud MCP Server 重构设计

日期：2026-08-22
状态：待实现
分支：`refactor`

## 1. 背景

现有实现是一次临时验证的产物，暴露出四类问题，导致项目搁置：

- **连接与会话层不稳**：`server.ts` 用一个模块级 `transport` 变量承载 SSE 连接，第二个客户端接入会覆盖第一个；SSE 是 MCP 的旧传输方式，多数客户端已改用 Streamable HTTP。会话存在内存 `Map` 中，无过期、无清理。
- **认证形同虚设**：`apple_login` 只查环境变量里有没有这个邮箱，从不验证 App 专用密码，因此凭据错误要等到第一次真正调用工具时才以晦涩的 IMAP 错误暴露出来。IMAP 用 `sender` 认证、CalDAV 用 `email` 认证，两套身份没有文档化，改动时极易弄错。
- **数据全部丢给模型解析**：`mail_read` 返回原始 header 数组和未解码的 TEXT 段，中文主题乱码、base64/quoted-printable 不解码、多部分正文不合并；`calendar_list_events` 返回原始 CalDAV 对象，要求模型自己读 iCal，写入时还要求模型手写 iCal 字符串。
- **无法真正部署**：没有测试、没有部署文档、依赖中 `imap-simple` 已停止维护（底层 `node-imap` 多年未更新，也是编码问题的根源）。

目标是把它重构成对标 Google Workspace connector 的 Apple 版本：邮件、日历、提醒事项、通讯录四块能力，本地 stdio 与远程 HTTP 两种部署形态同等可用。

## 2. 范围

### 目标

- 四个能力模块：Mail（IMAP/SMTP）、Calendar 与 Reminders（CalDAV）、Contacts（CardDAV）。
- 两个传输入口：stdio（本地客户端直接拉起）与 Streamable HTTP（远程部署），共用同一套业务代码。
- 远程入口实现 OAuth 2.1 授权（自建授权服务器，支持动态客户端注册）。
- 服务端完成全部协议细节处理，工具的输入输出是干净的 JSON。
- 可运行的测试套件与可照做的部署文档。

### 非目标

- **邮件附件的下载与发送**：本次不做，接口预留 `attachments` 元信息字段。
- **iCloud 备忘录（Notes）、照片、查找、iCloud Drive**：Apple 未提供可配合 App 专用密码使用的标准协议，无法实现。
- **多用户 SaaS 化**：远程部署面向单个管理员及其配置的若干 iCloud 账号，不做租户隔离体系。
- **邮件线程（threading）视图**：搜索返回平铺列表，不做会话聚合。

## 3. 架构

### 依赖方向

严格单向，任何反向引用都视为设计违规：

```
bin/stdio.ts ─┐
              ├→ server/createServer.ts → modules/*/tools.ts → modules/*/service.ts → providers/icloud/*
bin/http.ts  ─┘         注册启用的模块      zod schema + 编解码    纯业务逻辑, 可测      连接与原始收发
```

- `providers/*` 不引用任何 MCP 类型，只暴露以领域对象为输入输出的方法。
- `modules/*/service.ts` 不引用任何 MCP 类型，接受 provider 接口作为依赖（构造函数注入），因此单测中可整体替换为假实现。
- `modules/*/tools.ts` 是唯一知道 MCP 的地方：定义 zod schema、调用 service、把结果与错误转成 MCP 响应。
- `bin/*` 只负责选传输方式、装配依赖、启动。

### 目录

```
src/
  core/
    config.ts        环境变量 schema 与解析（zod），启动即校验
    accounts.ts      账号解析与查找
    session.ts       会话存储：TTL、清理定时器、每会话的连接缓存
    errors.ts        AppError 与错误码枚举
    logger.ts        分级日志 + 敏感信息脱敏
    ids.ts           不透明 ID 的编解码
  providers/icloud/
    imap.ts          ImapFlow 连接的建立、复用、关闭
    smtp.ts          nodemailer transporter
    caldav.ts        tsdav CalDAV 客户端（日历与提醒共用）
    carddav.ts       tsdav CardDAV 客户端
  parsers/
    mime.ts          mailparser 封装：解码、HTML 转文本、正文合并
    ical.ts          ical.js 封装：事件与待办的解析与生成、RRULE 展开、时区
    vcard.ts         vcard4 封装：联系人解析与生成
  modules/
    mail/            tools.ts · service.ts · types.ts
    calendar/        tools.ts · service.ts · types.ts
    reminders/       tools.ts · service.ts · types.ts
    contacts/        tools.ts · service.ts · types.ts
  server/
    createServer.ts  按能力开关注册模块，返回配置好的 McpServer
    capabilities.ts  能力开关求值
  auth/              仅 HTTP 入口使用
    provider.ts      OAuthServerProvider 实现
    store.ts         客户端与令牌的加密存储
    login.ts         管理员登录页与凭据校验
  bin/
    stdio.ts
    http.ts
tests/
  unit/              解析层与服务层
  integration/       默认 skip，需 .env.test
  fixtures/          真实报文、.ics、.vcf 样本
```

单包结构，不做 monorepo：模块数量有限，拆包带来的构建与版本管理成本超过收益。

## 4. 核心抽象

### 4.1 配置

`core/config.ts` 用 zod 定义完整 schema，进程启动时解析，失败即退出并打印具体是哪一项、期望什么。不再出现"服务起来了但账号列表是空的"。

变量命名统一为大写下划线；旧的小写命名保留一层兼容映射，命中时打印弃用警告。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ICLOUD_ACCOUNT_1` | 是 | — | Apple ID 邮箱，用于 CalDAV/CardDAV 认证 |
| `ICLOUD_APP_PASSWORD_1` | 是 | — | App 专用密码，格式 `xxxx-xxxx-xxxx-xxxx` |
| `ICLOUD_SENDER_1` | 否 | 同 `ICLOUD_ACCOUNT_1` | 邮件收发身份（iCloud 邮箱或别名），用于 IMAP/SMTP 认证 |
| `ICLOUD_LABEL_1` | 否 | 账号邮箱 | 展示名，便于模型在多账号间区分 |
| `ALLOW_MAIL_READ_1` | 否 | `true` | 读权限缺省允许 |
| `ALLOW_MAIL_WRITE_1` | 否 | `false` | **写权限缺省禁止** |
| `ALLOW_CALENDAR_READ_1` / `ALLOW_CALENDAR_WRITE_1` | 否 | `true` / `false` | 同上 |
| `ALLOW_REMINDERS_READ_1` / `ALLOW_REMINDERS_WRITE_1` | 否 | `true` / `false` | 同上 |
| `ALLOW_CONTACTS_READ_1` / `ALLOW_CONTACTS_WRITE_1` | 否 | `true` / `false` | 同上 |
| `SESSION_TTL_MINUTES` | 否 | `30` | 会话空闲过期时间 |
| `IMAP_IDLE_TIMEOUT_SECONDS` | 否 | `300` | IMAP 连接空闲多久后断开 |
| `LOG_LEVEL` | 否 | `info` | `error`/`warn`/`info`/`debug` |
| `PORT` | 否 | `17733` | 仅 HTTP 入口 |
| `PUBLIC_URL` | HTTP 入口必填 | — | 对外基址，OAuth 元数据与回调用 |
| `ADMIN_PASSWORD_HASH` | HTTP 入口必填 | — | 管理员登录口令的 argon2 哈希 |
| `TOKEN_STORE_PATH` | 否 | `./data/tokens.db` | 令牌存储位置 |
| `TOKEN_ENCRYPTION_KEY` | HTTP 入口必填 | — | 32 字节 base64，用于加密落盘的令牌 |

账号 2–5 用后缀 `_2`…`_5`，仅当对应的 `ICLOUD_ACCOUNT_n` 存在时才解析；不再需要 `multiple_account_enable` 这个开关。

权限缺省值的翻转是有意为之：旧实现的 `!== 'false'` 意味着任何拼写错误都会静默打开删除邮件的权限。

仓库提供 `.env.example`，真实 `.env` 由 `.gitignore` 排除。

### 4.2 账号与会话

`apple_login` 真正验证凭据：

1. 按邮箱查配置，查不到返回 `NOT_FOUND` 并附上已配置账号列表。
2. 建立 IMAP 连接并执行一次 `NOOP`；建立 CalDAV 客户端并查询 principal。
3. 两者都成功才创建会话，返回 `{session_id, account, label, capabilities}`，其中 `capabilities` 是该账号实际启用的读写权限，模型据此知道能做什么。
4. 失败时区分原因：密码错误（`AUTH_FAILED`，hint 提示检查 App 专用密码是否已吊销）、网络不可达（`UPSTREAM_ERROR`，retryable）、配置缺失（`NOT_FOUND`）。

会话对象持有：账号配置、创建时间、最后活跃时间、惰性初始化的 IMAP 连接、CalDAV/CardDAV 客户端缓存。

- **TTL**：默认 30 分钟无活动过期。每次工具调用刷新最后活跃时间。
- **清理**：单个定时器每分钟扫描一次，过期会话关闭连接并移除。
- **IMAP 空闲**：连接空闲超过 `IMAP_IDLE_TIMEOUT_SECONDS` 自动关闭，下次调用时透明重连；重连失败按 `AUTH_FAILED`/`UPSTREAM_ERROR` 分类返回。
- **`work_done`**：立即关闭所有连接、销毁会话。

连接复用是本次性能上的主要收益：旧实现每次工具调用都要完整建立一次 IMAP 连接（TLS 握手 + 认证 + 选择邮箱），一次列表操作要数秒。

### 4.3 不透明 ID

日历事件、提醒、联系人的标识对模型是不透明字符串：`base64url(资源集合URL + "|" + 资源URL)`。

etag **不编码进 ID**——它会随每次修改变化，编码进去必然过期。写操作时服务端先取当前 etag，再用 `If-Match` 提交。需要乐观锁的调用方可传 `expected_etag`，不匹配时返回 `CONFLICT`。

### 4.4 错误

```ts
class AppError extends Error {
  code: ErrorCode
  hint?: string        // 写给模型看的下一步动作
  retryable: boolean
  cause?: unknown      // 仅进日志，不出现在 MCP 响应中
}
```

`ErrorCode` 枚举：`AUTH_FAILED` · `PERMISSION_DENIED` · `NOT_FOUND` · `INVALID_INPUT` · `SESSION_EXPIRED` · `CONFLICT` · `RATE_LIMITED` · `UPSTREAM_ERROR` · `INTERNAL`。

在 `modules/*/tools.ts` 的统一包装层转成 MCP 响应：`isError: true` + `{error: {code, message, hint, retryable}}` 的 JSON 文本。`hint` 是让模型自我恢复的关键，例如 `SESSION_EXPIRED` 的 hint 为"调用 apple_login 重新获取 session_id 后重试本次操作"。

上游库抛出的异常一律在 provider 层捕获并映射为 `AppError`，不允许原始异常穿透到 MCP 边界。

## 5. 工具接口

除 `apple_accounts` 与 `apple_login` 外，所有工具都需要 `session_id`。所有时间参数与返回值均为 ISO 8601 字符串，带时区偏移。破坏性工具带 MCP 的 `destructiveHint` 注解，只读工具带 `readOnlyHint`。

### 5.1 会话

| 工具 | 参数 | 返回 |
|---|---|---|
| `apple_accounts` | — | 已配置账号列表：`[{email, label, capabilities}]` |
| `apple_login` | `account?`（单账号时可省略） | `{session_id, account, label, capabilities}` |
| `work_done` | `session_id` | `{success}` |

### 5.2 邮件

| 工具 | 参数 | 说明 |
|---|---|---|
| `mail_folders` | `session_id` | 返回 `[{path, name, specialUse, unseen, total}]`，`specialUse` 标出收件箱/已发送/废纸篓等，模型不必猜 Apple 的文件夹命名 |
| `mail_search` | `session_id`, `folder?`(默认 INBOX), `query?`, `limit?`(默认 20，上限 100), `cursor?` | `query` 支持 `{from, to, subject, text, since, before, unseen, flagged}` 组合。返回 `{messages: [{uid, date, from, to, subject, snippet, seen, flagged, hasAttachments}], nextCursor}` |
| `mail_read` | `session_id`, `uid`, `folder?`, `format?`(`text`\|`html`\|`both`，默认 text) | 返回解码后的 `{uid, messageId, date, from, to, cc, subject, text, html?, attachments: [{filename, contentType, size}], inReplyTo, references}` |
| `mail_send` | `session_id`, `to[]`, `cc?[]`, `bcc?[]`, `subject`, `text?`, `html?`, `in_reply_to?` | 至少提供 `text` 或 `html`。发信身份取账号的 sender |
| `mail_mark` | `session_id`, `uid[]`, `folder?`, `flags:{seen?, flagged?}` | 批量设置或清除标记 |
| `mail_move` | `session_id`, `uid[]`, `from_folder`, `to_folder` | 批量移动 |
| `mail_delete` | `session_id`, `uid[]`, `folder?`, `permanent?`(默认 false) | 默认移入废纸篓；`permanent: true` 才 `\Deleted` + expunge |

`snippet` 是正文前 200 字符的纯文本预览，让模型在不逐封 `mail_read` 的情况下判断相关性。

### 5.3 日历

| 工具 | 参数 | 说明 |
|---|---|---|
| `calendar_list` | `session_id` | `[{calendar_id, name, color, writable, supports}]` |
| `calendar_list_events` | `session_id`, `start`, `end`, `calendar_ids?[]`, `expand_recurring?`(默认 true) | 返回结构化事件；重复事件按时间范围展开为具体发生实例，每个实例带 `recurrence_id` 与 `series_id` |
| `calendar_create_event` | `session_id`, `calendar_id?`(默认首个可写日历), `event` | `event`: `{title, start, end, all_day?, timezone?, location?, description?, url?, attendees?[], recurrence?, alarms?[]}` |
| `calendar_update_event` | `session_id`, `event_id`, `patch`, `scope?`(`this`\|`all`，默认 `all`), `expected_etag?` | `patch` 为 `event` 的部分字段；`scope: this` 只改重复序列中的单次发生 |
| `calendar_delete_event` | `session_id`, `event_id`, `scope?`, `expected_etag?` | 同上 |

`recurrence` 用结构化对象表达而非裸 RRULE 字符串：`{freq, interval?, count?, until?, byday?[], bymonthday?[]}`，服务端负责与 RRULE 互转。`alarms` 为 `[{minutes_before, action}]`。

### 5.4 提醒事项（阶段二）

| 工具 | 说明 |
|---|---|
| `reminders_lists` | 列出提醒列表（CalDAV 中支持 VTODO 的集合） |
| `reminders_list` | 按列表、完成状态、截止日期范围查询 |
| `reminders_create` | `{title, notes?, due?, priority?, list_id?}` |
| `reminders_update` | 支持 `completed` 切换、修改标题/备注/截止/优先级 |
| `reminders_delete` | 删除 |

复用 Calendar 的 CalDAV provider 与 `parsers/ical.ts`，差异仅在 VTODO 的字段映射（`STATUS`、`PERCENT-COMPLETE`、`DUE`、`PRIORITY`）。

### 5.5 通讯录（阶段二）

| 工具 | 说明 |
|---|---|
| `contacts_search` | 按姓名、邮箱、电话模糊查询，分页 |
| `contacts_read` | 读取完整联系人 |
| `contacts_create` | `{names, emails?[], phones?[], organization?, note?, birthday?, addresses?[]}` |
| `contacts_update` | 部分字段更新 |
| `contacts_delete` | 删除 |

vCard 的解析与生成在 `parsers/vcard.ts`，模型只见结构化字段。

**针对真实 iCloud 账号的实测结论（2026-08-24，1429 个联系人）**，本节的实现据此确定：

- iCloud CardDAV **不支持 `addressbook-query` REPORT**（返回 `400 Bad Request: Didn't understand the report`）。`supported-report-set` 只声明 `sync-collection` 与 `addressbook-multiget`。因此服务端过滤不可用。
- `contacts_search` 改为：首次全量拉取并记录 `sync-token`（实测 1429 张卡 6.9 秒 / 305 KB），后续带 token 走 `sync-collection` 只取变更集，匹配在会话缓存内完成。缓存随会话生命周期存续，由服务器的变更集保证新鲜度。
- iCloud 下发的 vCard 版本为 **3.0**（非 4.0）。解析层仍需容忍 4.0，但 fixture 以 3.0 为主。
- 实际出现的属性集中在 `FN`/`N`/`ORG`/`TEL`/`EMAIL`/`ADR`/`TITLE`/`UID`/`REV`/`PRODID`；单张平均 218 字节，最大 1496 字节。
- **`PHOTO` 极少但存在**（1429 张中有 2 张）。`contacts_read` 只返回是否存在头像，绝不把 base64 放进响应。
- 账号下只有一个通讯簿（无 `displayName`，url 尾段为 `card`），但实现不得假设只有一个。

结构化模型在 spec 最小集之外，另含 `url`、`impp`、生日提醒相关字段。与日历一致，**未建模的 vCard 属性在更新时原地保留**，不得按模型重建整张卡片。

## 6. 解析层

这是旧实现问题最集中的地方，也是测试的重点。

- **MIME**（`mailparser`）：正确处理 RFC 2047 编码的主题与发件人显示名（中文邮件乱码的根因）、base64 与 quoted-printable 正文、multipart/alternative 的正文选取、内嵌图片的剥离。`format: text` 时若邮件只有 HTML，服务端转换为可读纯文本（保留链接与段落结构）。
- **iCal**（`ical.js`）：解析时正确处理 `DTSTART;VALUE=DATE`（全天事件）与 `TZID`（跨时区），按查询范围展开 RRULE 并正确应用 `EXDATE` 与 `RECURRENCE-ID` 覆盖；生成时输出符合规范、能被 Apple 客户端正确读取的 VEVENT/VTODO（包含 `UID`、`DTSTAMP`、`SEQUENCE`）。
- **vCard**（`vcard4`）：兼容 iCloud 实际下发的 vCard 3.0 与 4.0。

## 7. 安全

- App 专用密码只存在于进程内存，只在会话存活期间保留，不写入任何持久化存储、不进日志。
- 日志全局脱敏：密码、令牌、Authorization 头一律替换；邮件正文与联系人详情在 `info` 级别只记录计数与耗时，`debug` 级别才记录截断后的摘要。
- 权限闸门在 service 层执行（不依赖工具层），且写权限缺省关闭。
- HTTP 入口：令牌加密落盘（`TOKEN_ENCRYPTION_KEY`）、管理员口令以 argon2 哈希存储、授权码一次性且短时效、刷新令牌轮换、支持撤销。
- 仓库：`.gitignore` 覆盖 `.env`、`node_modules`、`dist`、证书与密钥文件；`.env.example` 只含占位符。历史中已泄露的 App 专用密码已由用户吊销，`main` 分支的历史保持原样不重写。

## 8. 测试

框架为 vitest 4。

**解析层单测**（最高优先级，fixture 驱动）：
- 中文主题的 RFC 2047 编码解码
- base64 与 quoted-printable 正文解码
- multipart/alternative 正文选取与 HTML 转文本
- 全天事件的日期边界
- 跨时区事件（含 DST 切换日）
- RRULE 展开、EXDATE 排除、RECURRENCE-ID 覆盖
- VTODO 完成状态映射
- vCard 3.0 与 4.0 双版本解析

fixture 来自真实报文与 Apple 客户端导出的 `.ics`/`.vcf`，脱敏后固化进仓库。

**服务层单测**：provider 替换为假实现，覆盖权限闸门（读写各一）、分页与游标、错误映射（每个 `ErrorCode` 至少一例）、会话过期与重连、不透明 ID 的编解码往返。

**集成测试**：默认 `skip`，仅当存在 `.env.test` 时运行。只操作专用测试资源——名为 `MCP-Test` 的日历与提醒列表、邮件的专用测试文件夹——且每个用例自行清理。用于验证 Apple 服务器的实际行为（文件夹命名、CalDAV 怪癖、SMTP 限制）。

CI 只跑单测。

## 9. 阶段划分

每个阶段结束都产出可用的东西，避免再次出现半成品搁置。

**阶段一 —— 本地可用**
`core` + `providers/icloud/{imap,smtp,caldav}` + `parsers/{mime,ical}` + `modules/{mail,calendar}` + `bin/stdio.ts` + 单测。
完成标准：在 Claude Code 中配置为 stdio MCP server，能完成"搜索本周未读邮件并读取正文"与"查看下周日程并创建一个带提醒的事件"，中文邮件无乱码，`npm test` 全绿，`npm audit` 无高危。

**阶段二 —— 能力补齐（拆为两次交付）**

*阶段 2a —— 提醒事项*：`modules/reminders` + 对应单测。复用既有 CalDAV provider 与 `parsers/ical.ts`，仅新增 VTODO 字段映射（`STATUS`、`PERCENT-COMPLETE`、`DUE`、`PRIORITY`）与 VTODO 集合的筛选。完成标准：提醒列表、按完成状态/截止日期查询、创建、完成状态切换、删除均可用，且与日历模块共用同一套原地修改语义。

*阶段 2b —— 通讯录*：`providers/icloud/carddav` + `parsers/vcard` + `modules/contacts` + 对应单测。完成标准：搜索走 `sync-collection` 增量同步 + 会话缓存，读取不返回 base64 头像，增删改可用且未建模属性在更新后完好。

两次交付各自独立可用，各自出计划、各自终审。

**阶段三 —— 远程上线**
`bin/http.ts`（Streamable HTTP，每客户端独立 transport 实例）+ `auth/*`（OAuth 2.1）+ 部署产物。
完成标准：能从 claude.ai 添加该远程 MCP 并完成授权流程；产出多阶段 Dockerfile、含 Caddy 自动证书的 `docker-compose.yml`、`/health` 端点、以及涵盖域名配置、证书、客户端接入、令牌吊销的部署文档。

## 10. 兼容与迁移

这是破坏性重构，工具名称与签名均有变化。旧版仅用于本人临时测试，无外部使用者，因此不提供工具层面的兼容垫片。

唯一保留的兼容是环境变量：旧的小写命名（`icloud_account`、`allow_mail_read` 等）仍可识别，映射到新命名并打印一次弃用警告。

旧代码保留在 `main` 分支供对照，重构在 `refactor` 分支进行。

## 11. 风险

- **Apple 未公开文档的行为**：CalDAV 的 `RECURRENCE-ID` 覆盖、CardDAV 的分页、IMAP 特殊文件夹命名在 iCloud 上的实际表现可能与规范有出入。缓解：集成测试针对真实账号验证，遇到差异在 provider 层吸收，不外溢到 service。
- **速率限制**：Apple 对 IMAP 连接数与 SMTP 发信频率有未公开的限制。缓解：会话级连接复用天然降低连接数；发信失败时映射为 `RATE_LIMITED` 并给出 retryable 提示。
- **OAuth 自建授权服务器的安全实现**：协议层由 SDK 的 `mcpAuthRouter` 承担，自实现部分集中在 `OAuthServerProvider` 的令牌签发、存储、轮换与撤销。缓解：这部分逻辑完全可单测，且在阶段三集中实现与评审。
- **全天事件与时区**：跨时区场景是日历类集成最常见的错误来源。缓解：作为解析层单测的重点，含 DST 切换日用例。
