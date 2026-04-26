# Apple iCloud MCP Server

An open-source Model Context Protocol (MCP) server for integrating Apple iCloud Mail and Calendar into your AI agents.

## Features
- **Apple Mail:** Read, list, send, and delete emails via IMAP/SMTP.
- **Apple Calendar:** Read, create, update, and delete calendar events via CalDAV.
- **Multi-Account:** Supports up to 5 iCloud accounts simultaneously.
- **Cross-Platform:** Works on Windows, macOS, and Linux (x86/ARM).
- **Secure:** Uses Apple's App-Specific Passwords. Does not store sensitive credentials persistently. Features an AI-triggered `work_done` endpoint to clear session state.

> **Note:** iCloud Notes are not supported because Apple does not provide a standard API (like IMAP/CalDAV) and Notes do not work with App-Specific Passwords.

## Prerequisites
- Node.js (v18 or higher)
- Your iCloud Email address
- An **App-Specific Password** generated from [appleid.apple.com](https://appleid.apple.com/)

## Environment Variables
Create a `.env` file or export these variables in your shell before starting the server:

```env
# 0 for single account, 1 for multiple accounts
multiple_account_enable=1

# Account 1
icloud_account=zzqhmbb@gmail.com
icloud_app_pass=mwve-yzhe-sdol-hfta
allow_calendar_read=true
allow_calendar_write=true
allow_mail_read=true
allow_mail_write=true

# Account 2 (optional)
icloud_account2=xxxxxx
icloud_app_pass2=xxxxxx
allow_calendar2_read=true
allow_calendar2_write=true
allow_mail2_read=true
allow_mail2_write=true

# Port (Optional, default is 17733)
PORT=17733

# HTTPS Support (Optional)
# Provide absolute paths to your SSL certificates to enable HTTPS
# SSL_CERT=/path/to/cert.pem
# SSL_KEY=/path/to/key.pem
```

> **环境变解析格式说明 / Environment Variable Formatting:**
> * 在使用 `.env` 文件或传入环境变量时，变量值是从等号（`=`）或冒号（`:`）后面的**第一个非空格字符**开始算起，直到行尾结束。
> * **中间的空格、连字符（-）、引号等都会被完整保留并算作变量值的一部分**。
> * 这允许您在等号后面为了对齐而添加一个或多个空格，系统会自动忽略前导空格。但请勿在实际参数内部随意打断或增加不必要的空格。

## Deployment

### 1. Portable Script (No Global Installation)
**Windows (PowerShell):**
```powershell
.\scripts\start.ps1
```

**Linux / Mac:**
```bash
chmod +x scripts/start.sh
./scripts/start.sh
```

### 2. Docker
Build and run via Docker. It supports multi-arch builds (amd64/arm64).
```bash
docker build -t apple-icloud-mcp .
docker run -p 17733:17733 --env-file .env apple-icloud-mcp
```

### 3. NPM (Node.js)
```bash
npm install
npm run build
npm run serve
```

## How to use with AI
Point your AI agent (Claude, Cursor, etc.) to the SSE endpoint:
`http://localhost:17733/sse` (or `https://yourdomain.com:17733/sse` if using SSL).

Tell your AI to refer to the included `SKILL.md` file for instructions on how to call the tools.
