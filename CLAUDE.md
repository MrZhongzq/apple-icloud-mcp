# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`apple-icloud-mcp`：把 iCloud 邮件（IMAP/SMTP）和日历（CalDAV）暴露成 MCP 工具的服务器。TypeScript + ESM（`"type": "module"`，`module: NodeNext`），Express 承载 MCP SDK 的 SSE transport。

## 常用命令

```bash
npm start          # 开发：tsx 直接跑 src/server.ts（不编译）
npm run build      # tsc → dist/
npm run serve      # 生产：node dist/server.js（跑的是 dist/ 里已编译的代码）
npx tsc --noEmit   # 仅类型检查
```

仓库没有测试框架、没有 lint 配置，改完代码只能靠 `npx tsc --noEmit` + 手动连服务器验证。

其他启动方式：`.\scripts\start.ps1` / `./scripts/start.sh`（自动 `npm install` 后 `npm start`）；`docker build -t apple-icloud-mcp . && docker run -p 17733:17733 --env-file .env apple-icloud-mcp`。

服务端点：`http://localhost:17733/sse`（SSE），`POST /message`（客户端回传）。配置 `SSL_CERT` + `SSL_KEY` 且文件存在时自动切 HTTPS。

## 架构

四层，请求路径固定为 `server.ts → auth.ts → services/{mail,calendar}.ts`：

- `src/config.ts`：唯一的凭据来源。`getConfig()` 每次调用都重新扫描环境变量，按下标拼出账号列表——账号 1 无后缀，账号 2–5 后缀为数字（`icloud_account2`、`allow_mail2_read`…），仅当 `multiple_account_enable=1` 时才扫描第 2–5 个。凭据不落盘、不缓存。
- `src/services/auth.ts`：`login(email)` 在内存 `Map` 里建一个 uuid 会话并挂上 `AccountConfig`；`work_done` 调 `logout()` 删除。进程重启 = 所有会话失效，没有过期清理逻辑。
- `src/server.ts`：手写工具清单（`ListToolsRequestSchema` 里直接写 JSON Schema，虽然依赖了 zod 但没用它）+ `CallToolRequestSchema` 的 switch 分发。`apple_login` / `work_done` 不校验会话，其余工具先 `getSession(session_id)`，取不到就返回错误文本。工具异常统一被 catch 成 `{ isError: true }` 的 JSON 文本，不会抛给客户端。
- `src/services/*.ts`：每个函数第一行都是 `if (!account.allowXxx) throw` 的权限闸门，然后是纯粹的 IMAP/SMTP/CalDAV 调用。

`SKILL.md` 是给 AI 客户端看的工具使用契约（登录 → 带 `session_id` 调用 → `work_done`）。**新增或修改工具时要同时改三处**：`server.ts` 的工具清单、`server.ts` 的 switch 分支、`SKILL.md` 的工具说明。

## 关键约定与坑

- **邮件用 `sender`，日历用 `email`。** IMAP/SMTP 认证用的是 `account.sender`（`icloud_sender` 未设置时回退到 `icloud_account`），CalDAV 用的是 `account.email`。这是历史上修过的 bug（`Fix IMAP auth`、`Fix icloud email sender logic`），改认证相关代码时别把两者混用。
- **权限开关默认开启**：`process.env[...] !== 'false'`，变量缺失即视为允许。要关必须显式写 `false`。
- **`dist/` 已提交进 git**，`npm run serve` 跑的是提交进去的产物。改了 `src/` 后如果走 `serve`，必须先 `npm run build`，否则行为不变。
- **`transport` 是模块级单变量**，每次 `GET /sse` 都会覆盖它，因此同一时刻只支持一个 SSE 客户端。
- **`calendar_update_event` 要求传 `calendar_url`，但 `updateEvent()` 实际没用它**（tsdav 只需要 `event_url` + `etag`）。
- **创建事件落在第一个支持 VEVENT 的日历**（`calendar.ts` 里 `components.includes('VEVENT')` 筛选，找不到就用 `calendars[0]`），无法指定目标日历。
- **`mail_delete` 只打 `\Deleted` 标记**，不做 expunge，邮件不会真正消失。
- **iCloud Notes 不支持**，Apple 没有配合 App-Specific Password 的标准 API，不要尝试用 IMAP 读 Notes。
- 环境变量取值从 `=` 或 `:` 后第一个非空格字符开始到行尾，值中间的空格/引号/连字符全部保留（见 README 与 SKILL.md 的说明）。

## 仓库卫生

仓库没有 `.gitignore`，`node_modules/`、`dist/` 和 `.env` 都被跟踪在版本库里。提交前留意别把新的凭据带进去。
