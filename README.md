# Apple iCloud MCP Server

A Model Context Protocol (MCP) server that exposes Apple iCloud **Mail** (IMAP/SMTP), **Calendar** (CalDAV), **Reminders** (CalDAV), and **Contacts** (CardDAV) as tools for AI agents. Supports up to 5 iCloud accounts at once, each with independent read/write permissions.

Two ways to reach it as an MCP server: the **stdio** transport (`dist/bin/stdio.js`), launched as a local subprocess by your MCP client — this is what the rest of this README assumes until the "Remote deployment" section — and a **remote Streamable HTTP + OAuth 2.1** transport (`dist/bin/http.js`), for putting the server on the internet behind your own domain so a hosted client like claude.ai can reach it. The two entrypoints share every tool and all business logic; the HTTP one adds an authorization server in front. See [Remote deployment](#remote-deployment-http--oauth) below.

There is also a third way to drive the same tools that is not an MCP transport at all: a **sandbox CLI** (`dist/bin/cli.js`), for an agent that has a shell but cannot mount an MCP connector — a Claude Routine running in a sandbox, for instance. It calls the same modules directly from the command line (23 tools: all 25 minus `apple_login`/`work_done`, which it manages itself), so it needs no domain, no certificate and no OAuth, and the credentials live in that sandbox's own `.env` rather than on a shared server. Setup and usage are documented in Chinese in [`docs/沙盒-CLI-用法.md`](docs/沙盒-CLI-用法.md). One measured caveat: from an Anthropic-hosted Routine sandbox, IMAP (993) and SMTP (587) are blocked at every network level, so the CLI there gets calendar, reminders and contacts but no mail — mail needs the remote HTTP server.

## Which one do I need?

| You are… | Use | Credentials live |
|---|---|---|
| Claude Code / Claude Desktop on your own machine | **stdio** (`dist/bin/stdio.js`) — see Install below | your machine |
| A Claude Routine that needs only calendar, reminders and contacts | **sandbox CLI** (`dist/bin/cli.js`) in the Routine's checkout of this repo | the Routine's environment |
| A Claude Routine (or claude.ai) that needs mail too, or should not carry this repo | **remote HTTP** server you or a friend runs, with **envelope login** | the Routine's environment — sealed into a one-time envelope per run; the server stores none |

A Routine in **some other repository** does not need this repo at all for the third row: one zero-dependency script plus a few lines of instructions is enough. See [`docs/远程连接-单脚本接入.md`](docs/远程连接-单脚本接入.md) (Chinese).

**Not supported, and not planned for this approach:** iCloud Notes. Apple provides no standard protocol for Notes (no IMAP/CalDAV equivalent) that works with an App-Specific Password, so there is no way to implement this without reverse-engineering a private, unsupported API.

## Prerequisites

- Node.js 20 or newer
- An Apple ID (iCloud email address)
- An **App-Specific Password**, generated at [appleid.apple.com](https://appleid.apple.com/) under Sign-In and Security → App-Specific Passwords. Your normal Apple ID password will not work against IMAP/SMTP/CalDAV.

## Environment variables

Copy `.env.example` to `.env` and fill in real values, or set these directly in your MCP client's server config (see below). Suffix `_1` is the first account; accounts 2–5 use the same names with `_2` .. `_5` and are picked up automatically once `ICLOUD_ACCOUNT_n` is present — there is no separate "enable multi-account" switch.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ICLOUD_ACCOUNT_1` | yes | — | Apple ID email. Used for CalDAV auth and as the fallback send-from address. |
| `ICLOUD_APP_PASSWORD_1` | yes | — | App-Specific Password, format `xxxx-xxxx-xxxx-xxxx`. |
| `ICLOUD_SENDER_1` | no | = `ICLOUD_ACCOUNT_1` | IMAP/SMTP auth identity and mail-send "from" address, if it differs from the Apple ID (e.g. a custom alias). **Must resolve to an iCloud mail domain** (`@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`) — see the mail-domain note below the table. |
| `ICLOUD_LABEL_1` | no | = the email | Display label, useful when running multiple accounts. |
| `ALLOW_MAIL_READ_1` | no | `true` | Read defaults to **on**. |
| `ALLOW_MAIL_WRITE_1` | no | `false` | Write (send/mark/move/delete) defaults to **off** — must be explicitly `true`. |
| `ALLOW_CALENDAR_READ_1` | no | `true` | Read defaults to **on**. |
| `ALLOW_CALENDAR_WRITE_1` | no | `false` | Write (create/update/delete) defaults to **off** — must be explicitly `true`. |
| `ALLOW_REMINDERS_READ_1` | no | `true` | Read defaults to **on**. |
| `ALLOW_REMINDERS_WRITE_1` | no | `false` | Write (create/update/delete) defaults to **off** — must be explicitly `true`. |
| `ALLOW_CONTACTS_READ_1` | no | `true` | Read defaults to **on**. |
| `ALLOW_CONTACTS_WRITE_1` | no | `false` | Write (create/update/delete) defaults to **off** — must be explicitly `true`. |
| `ICLOUD_ACCOUNT_2` .. `_5`, `ICLOUD_APP_PASSWORD_2` .. `_5`, etc. | no | — | Same fields, repeated per account slot 2–5. |
| `SESSION_TTL_MINUTES` | no | `30` | A session (from `apple_login`) expires after this many minutes of inactivity. |
| `IMAP_IDLE_TIMEOUT_SECONDS` | no | `300` | IMAP idle/connection timeout. |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug`. All logging goes to **stderr** — stdout is reserved for the MCP protocol. |

**Write permissions default to OFF.** This is a deliberate change from the previous version of this server, which defaulted writes to on — a typo in a variable name there would silently grant delete-mail permission. Now, an unset or misspelled write-permission variable fails closed.

**The effective sender must be an iCloud mail address.** IMAP/SMTP authenticate with the effective sender (`ICLOUD_SENDER_n`, falling back to `ICLOUD_ACCOUNT_n` if unset) — not with `ICLOUD_ACCOUNT_n` itself, which CalDAV uses instead. Apple's IMAP/SMTP servers reject any username that isn't an Apple-assigned iCloud address, so if your Apple ID (or your `ICLOUD_SENDER_n`) is not `@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`, that account's mail tools are **automatically disabled at startup** — `mailRead`/`mailWrite` are forced to `false` regardless of `ALLOW_MAIL_READ_n`/`ALLOW_MAIL_WRITE_n`, and a notice explaining why is printed to stderr. Calendar, reminders and contacts are unaffected. If you do have an iCloud mail address, set `ICLOUD_SENDER_n` to it; if you don't, that account simply doesn't use iCloud Mail and its calendar, reminders and contacts tools remain available.

**Legacy (v1) variable names still work**, mapped automatically with a deprecation warning on stderr: `icloud_account`, `icloud_app_pass`, `icloud_sender`, and the multi-account forms with the digit inside the name (`icloud_account2`, `allow_mail2_read`, `allow_calendar3_write`, …). `multiple_account_enable` is now a no-op — accounts 2–5 are detected by presence of `ICLOUD_ACCOUNT_n`, not by an enable flag.

### Remote HTTP transport only

**These seven variables are read only by `dist/bin/http.js` (`loadHttpConfig`).** The stdio entrypoint (`dist/bin/stdio.js`, everything above) never reads them and never requires them — running this server locally for Claude Code/Desktop does not need a domain, a certificate, or any of this. They matter only if you're doing the [remote deployment](#remote-deployment-http--oauth) below.

The reverse also holds: the HTTP entrypoint does **not** require `ICLOUD_ACCOUNT_1`. It starts with zero accounts configured, because on a shared server each person logs in with an envelope carrying their own account (see [Sharing one server](#sharing-one-server-access-keys-and-envelope-login)). Accounts you do put in its `.env` stay unusable until you switch on ".env 账号" on the `/admin` page.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PUBLIC_URL` | yes | — | Full base URL this server is reachable at, e.g. `https://mcp.example.com` (no trailing slash). Doubles as the OAuth issuer and the callback base. Must be `https://` except for `localhost`/`127.0.0.1`, which are exempted for local testing. |
| `ADMIN_PASSWORD_HASH` | yes | — | The scrypt hash of the admin password (`scrypt$32768$8$1$<salt>$<hash>`), **not the password itself**. Generate with the stdin command below. The admin password logs in to the `/admin` management page only; it is not accepted on the OAuth authorization page, which takes access keys. |
| `TOKEN_ENCRYPTION_KEY` | yes | — | Base64 encoding of a 32-byte key, used to encrypt both the store (OAuth clients, tokens, access keys, settings) and the envelope key file at rest (AES-256-GCM). Generate with the command below. Losing or rotating this key makes both files undecryptable — see Troubleshooting. |
| `PORT` | no | `17733` | Port the HTTP server listens on. |
| `TOKEN_STORE_PATH` | no | `./data/tokens.json.enc` | Where the encrypted store of OAuth clients, tokens, access keys and settings lives. In Docker this is set to `/app/data/tokens.json.enc`, backed by the `token_store` named volume. |
| `ENVELOPE_KEY_PATH` | no | `envelope-key.json.enc` next to `TOKEN_STORE_PATH` | Where the server's X25519 envelope key pair lives (encrypted with `TOKEN_ENCRYPTION_KEY`, mode 0600). Generated on first start if missing. Kept in its own file so it can be rebuilt without touching access keys or tokens: delete it and restart, and everyone using envelope login needs the new public key. In Docker the default lands in the same `token_store` volume. |
| `TRUST_PROXY` | no | `false` | Whether to trust `X-Forwarded-For` when deciding a request's client address. Rate limits (`/access-login` and `/admin/login`, plus the SDK's own on `/token`, `/register`, `/revoke`) are keyed on that address, so this is not cosmetic in either direction. **Leave it off if the server's port is exposed directly** — the header is written by the caller, and trusting it lets anyone pick their own rate-limit bucket and retry access keys and the admin password without limit. **Turn it on if anything terminates TLS in front of it** — including the `docker-compose.yml` in this repo, which puts Caddy in front: without it every request arrives from one container IP, so per-IP limiting distinguishes nobody and a single unauthenticated visitor can exhaust the `/access-login` and `/token` budgets for everyone, locking the whole authorization flow. The shipped compose file sets it to `true` for exactly this reason, as does `deploy/compose.vps.yml.example` for an existing nginx in front. |

## Install

```bash
npm install
npm run build      # compiles TypeScript to dist/ — required before an MCP client can launch it
```

That is the whole install. **Do not run the server yourself.** This is a stdio MCP server: it speaks JSON-RPC over stdin/stdout and is launched *by* your MCP client as a child process. Running `npm run serve` in a terminal is not an error, but it will appear to hang — it is waiting for a client to speak to it on stdin.

`npm start` runs the same server from TypeScript source via `tsx`, skipping the build. Useful while developing; point your client at `npm run build` output for normal use.

## Register it with Claude Code

Two equivalent ways. Both need `npm run build` to have run first, so `dist/bin/stdio.js` exists.

### With the CLI

```bash
claude mcp add apple-icloud \
  -e ICLOUD_ACCOUNT_1=your-apple-id@example.com \
  -e ICLOUD_SENDER_1=your-name@icloud.com \
  -e ICLOUD_APP_PASSWORD_1=abcd-efgh-ijkl-mnop \
  -e ALLOW_CALENDAR_WRITE_1=true \
  -- node /absolute/path/to/apple_mcp/dist/bin/stdio.js
```

Add `-s user` to make it available in every project, or `-s project` to write a shared `.mcp.json` into the current repo. The default scope is `local` — this project only, private to you. Note the `--` separator: everything after it is the command Claude Code runs.

### With a config file

```json
{
  "mcpServers": {
    "apple-icloud": {
      "command": "node",
      "args": ["/absolute/path/to/apple_mcp/dist/bin/stdio.js"],
      "env": {
        "ICLOUD_ACCOUNT_1": "your-apple-id@example.com",
        "ICLOUD_SENDER_1": "your-name@icloud.com",
        "ICLOUD_APP_PASSWORD_1": "abcd-efgh-ijkl-mnop",
        "ALLOW_CALENDAR_WRITE_1": "true"
      }
    }
  }
}
```

**On Windows**, JSON strings escape backslashes, so write the path as `"C:\Users\you\apple_mcp\dist\bin\stdio.js"` or use forward slashes (`C:/Users/you/apple_mcp/dist/bin/stdio.js`), which Node accepts.

**Set `ICLOUD_SENDER_1`** unless your Apple ID is itself an `@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn` address. If your Apple ID is a Gmail or other third-party address — common for older accounts — the mail tools are disabled without it. See the mail-domain note above.

You can also drop the credentials in a `.env` file at the repo root instead of putting them in the client config; the server loads it at startup. Keep `.env` out of version control — the shipped `.gitignore` already excludes it.

### Verify the registration

```bash
claude mcp list
```

`apple-icloud` should appear as connected. Inside a session, ask Claude to call `apple_accounts` — it takes no arguments, needs no login, and returns the accounts the server actually parsed along with the capabilities each one has. That is the fastest way to confirm your environment variables arrived intact.

To check the server without any client at all, pipe a handshake into it directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/bin/stdio.js
```

A healthy server answers on stdout with 25 tools (3 session + 7 mail + 5 calendar + 5 reminders + 5 contacts) and writes only logs to stderr. Eighteen tools means the mail set was disabled — check the sender-domain notice on stderr.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Server exits immediately, stderr says no accounts configured | No `ICLOUD_ACCOUNT_1` reached the process | Check the `env` block in your client config, or that `.env` sits at the repo root. The message names the variables it needs. |
| Only 18 tools; stderr carries a notice about the sender address | The effective sender is not an iCloud mail domain, so mail was disabled | Set `ICLOUD_SENDER_1` to your `@icloud.com` address. If you have none, that account does not use iCloud Mail — calendar, reminders, and contacts still work. |
| `AUTH_FAILED` — "iCloud 拒绝了这组凭据" | Wrong, revoked, or mistyped App-Specific Password; or an Apple ID without two-factor authentication | Regenerate the password at appleid.apple.com. Note that if only *mail* fails while calendar works, the password is fine — it is the sender address (row above). |
| `PERMISSION_DENIED` naming an `ALLOW_…` variable | That capability is off; writes default to off | Set the named variable to `true` and restart the client so the server relaunches. |
| `PERMISSION_DENIED` with no variable named | iCloud itself refused the write on that calendar, reminder list, or address book — usually a subscribed or shared read-only one | Pass a different `calendar_id` from `calendar_list`, `list_id` from `reminders_lists`, or `address_book_id` from `contacts_search`. |
| `SESSION_EXPIRED` | Sessions expire after `SESSION_TTL_MINUTES` of inactivity | The model should call `apple_login` again; the error hint says so. Raise the TTL if it happens constantly. |
| Client shows the server as failed, with no useful error | Something wrote to stdout and corrupted the JSON-RPC stream | This should not happen — all logging is on stderr by design. If it does, capture stderr and file it as a bug. |
| Calendar events come back an hour off after a DST change | Recurring events created by this server are UTC-anchored | Known phase-one limitation, documented under Limitations. Events created in the Apple UI are unaffected. |
| *(remote HTTP transport only)* Every request to `/mcp` returns 401, even with a freshly-issued token | The client dynamically registered against a different `PUBLIC_URL` than the one the server is now configured with, so the `issuer` in the OAuth metadata doesn't match what the client discovered when it registered | Restart the authorization from the client with `PUBLIC_URL` matching the domain it's actually reaching. There's no way to fix an existing registration's issuer after the fact — it has to re-register. |
| *(remote HTTP transport only)* After upgrading, every existing connector gets 401 | Tokens issued before access keys existed belong to no key and are rejected by design | Log in to `/admin` with the admin password, create an access key for yourself, and reconnect the connector in claude.ai with that key. See "Upgrading from the admin-password version" below. |
| *(remote HTTP transport only)* The access-key page appears, but submitting it doesn't get you back to the client | The pending authorization request expired — it's held in memory for 10 minutes from when `/authorize` was first hit, and the page re-renders with "登录请求不存在或已过期" | Don't retry the same form — the `request_id` it's bound to is already gone. Start the authorization over from the client (e.g. re-add the connector in claude.ai). "访问密钥不正确或已停用" is different: the request is still valid, so fix the key and submit the same page again. |
| *(remote HTTP transport only)* The server refuses to start: "令牌存储无法解密" or "信封密钥文件无法解密" | The store (`TOKEN_STORE_PATH`) or the envelope key file (`ENVELOPE_KEY_PATH`) can't be decrypted — almost always `TOKEN_ENCRYPTION_KEY` changed since they were written (then both are affected), occasionally file corruption | Deleting the file is the intended recovery, not a last resort. Deleting the store wipes every access key, OAuth client and the ".env 账号" setting: recreate keys on `/admin` and every client re-authorizes. Deleting the envelope key file gives the server a new key pair: everyone using envelope login needs the new public key. No iCloud data or password is in either file. |

## Tools

All tools except `apple_accounts` and `apple_login` require a `session_id` obtained from `apple_login`.

| Tool | Summary |
|---|---|
| `apple_accounts` | List configured accounts and their read/write capabilities. No session required. |
| `apple_login` | Authenticate and open a session; returns `session_id`. Verifies live only the protocols the account's enabled capabilities need — IMAP for mail, CalDAV for calendar/reminders, CardDAV for contacts. |
| `work_done` | Close the session and release its connections. Call when finished. |
| `mail_folders` | List mail folders with unread counts and special-use tags (inbox, trash, …). |
| `mail_search` | Search messages by folder/sender/subject/text/date/flags; paginated, headers-only. |
| `mail_read` | Read one message's full decoded body, headers, and attachment metadata by `uid`. |
| `mail_send` | Send a new message (text and/or HTML). |
| `mail_mark` | Batch set/clear seen and flagged state. |
| `mail_move` | Batch move messages between folders. |
| `mail_delete` | Batch delete; moves to trash by default, `permanent: true` expunges immediately. |
| `calendar_list` | List calendars with their opaque `calendar_id` and `writable` status. |
| `calendar_list_events` | Query events in a time range; recurring events are expanded into occurrences by default. |
| `calendar_create_event` | Create an event from structured fields (no hand-written iCal needed). |
| `calendar_update_event` | Patch an existing event; only the fields given change. |
| `calendar_delete_event` | Delete an event (whole series or a single occurrence via `scope`). |
| `reminders_lists` | List reminder (VTODO) lists with their opaque `list_id` and `writable` status. |
| `reminders_list` | Query reminders by list, completion state, and due-date range. |
| `reminders_create` | Create a reminder from structured fields. |
| `reminders_update` | Patch an existing reminder; only the fields given change. |
| `reminders_delete` | Delete a reminder. Cannot be undone. |
| `contacts_search` | Search contacts by keyword (name, org, email, phone, note, …); paginated. |
| `contacts_read` | Read one contact's full detail by `contact_id`. |
| `contacts_create` | Create a contact from structured fields. |
| `contacts_update` | Patch an existing contact; only the fields given change. |
| `contacts_delete` | Delete a contact. Cannot be undone. |

## Limitations to know before you rely on this

- **Event creation is UTC-anchored, with no timezone field.** `start`/`end` must carry an explicit offset (e.g. `2026-09-10T14:00:00+08:00`) — a bare local time is silently read as UTC. A one-off event created this way is fine, since the ISO timestamp is already an absolute instant. A **recurring** event, however, will drift by an hour across a daylight-saving transition, for users in DST-observing zones. Users in zones without DST (mainland China included) are unaffected. Reading events back still reports the correct source timezone.
- **All-day values keep the calendar date you wrote, in the offset you wrote it in.** `all_day: true` (events) and `all_day_due: true` (reminders) discard the time-of-day and keep only the date part as read in that timestamp's own offset — `2026-09-01T00:00:00+08:00` and `2026-09-01T23:00:00-05:00` both mean September 1. The result does not depend on the server's own timezone.
- **Attendees are preserved, not managed.** `calendar_update_event` patches the existing event in place, so `ATTENDEE`, `ORGANIZER`, `CATEGORIES`, `STATUS`, and `X-APPLE-*` properties survive an edit untouched. Adding/removing invitees and anything about invitation/RSVP status is out of scope this phase.
- **Attachments are not supported.** `mail_read` reports attachment filename/type/size but cannot download content; `mail_send` cannot attach files.
- **`mail_delete` moves to trash, not permanently, unless `permanent: true`.**
- **iCloud Notes are unsupported**, and will remain so under this approach — see above.
- **Mail tools silently disappear for an account whose sender isn't an iCloud address.** Symptom: the `mail_*` tools are missing for that account (or, if you bypass this check by other means, IMAP/SMTP fail with `AUTHENTICATIONFAILED` / `AUTH_FAILED`). Cause: IMAP/SMTP authenticate with the effective sender (`ICLOUD_SENDER_n`, or `ICLOUD_ACCOUNT_n` as a fallback), and Apple's mail servers reject a non-iCloud username outright — a Gmail-based Apple ID is the common case. Fix: set `ICLOUD_SENDER_n` to your actual iCloud mail address (`@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`); if you don't have one, you don't use iCloud Mail and that account keeps its calendar, reminders and contacts tools. Check stderr at startup for the exact notice naming the affected account.
- Range queries (`calendar_list_events`) use overlap semantics: an event that starts before the window but runs into it is included — this is what "what's on today" should mean for an overnight or multi-day event, and matches RFC 4791.
- **`calendar_list_events` returns at most 1000 events.** It has no `limit` parameter; when a query matches more, only the 1000 earliest-starting are returned and `truncated: true` is set on the result. Expanded recurring events count individually, so a single daily event fills a large share of that cap over a long window — narrow the range, pass `calendar_ids`, or set `expand_recurring: false`. `reminders_list` and `contacts_search` set the same flag against their own `limit`.
- **Contact search matches a session-local cache, not a live server-side query** — iCloud's CardDAV has no `addressbook-query` filtering. The first search in a session pays for a full pull of every address book the account can see (about 4.5s observed for 1,429 contacts); subsequent searches in the same session sync incrementally (about 0.4s with no changes). Expect the first call to be noticeably slower — that is not a failure to retry.
- **Address-book groups are not contacts.** iCloud stores groups ("Coworkers", "Family", "ICE", …) as vCards marked `X-ADDRESSBOOKSERVER-KIND:group` in the same address book as people; `contacts_search` leaves them out. There is no tool to list or edit groups or their membership.
- **Contact birthdays accept only `YYYY-MM-DD` or `--MM-DD`.** Anything else is rejected with `INVALID_INPUT` rather than written — a vCard `BDAY` the parser cannot read makes the whole card unreadable, which would leave the contact unreachable through this server. Reading is tolerant in the other direction: a card written by another client with an unparseable `BDAY` still comes back, just without the `birthday` field, and a no-year birthday (Apple stores those with a placeholder year of 1604) is reported as `--MM-DD`.
- **Contact photos are reported as a boolean only.** `has_photo` tells you whether a `PHOTO` property exists on the vCard; no tool returns photo bytes or a URL, and no response ever contains base64 image data.
- **The remote HTTP server holds plaintext App-Specific Passwords in memory for the life of each session.** It has to — it connects to iCloud on the user's behalf. That is as true of envelope login as of accounts in the server's `.env`: the password is never written to the server's disk, but while a session is open, whoever controls the server (or has broken into it) can read it. Anyone using someone else's server is trusting its owner. Two narrower consequences, documented in `docs/部署与-Routine-接入.md`: the server's disk (envelope private key plus `TOKEN_ENCRYPTION_KEY`) together with a captured envelope reveals the password even after the envelope expired; and a restart forgets which envelopes were used, so one used within the previous 5 minutes could be replayed once by someone who also holds a valid access key.

## Remote deployment (HTTP + OAuth)

This puts the server on the internet as a remote MCP endpoint — for example, so you can add it as a custom connector in claude.ai instead of running it as a local stdio subprocess. Everything in this section is about `dist/bin/http.js`; nothing here changes how the stdio transport (all of the above) works or what it needs.

### 1. Domain and DNS

You need a domain name (a subdomain is fine, e.g. `mcp.example.com`) with an A/AAAA record pointing at the machine that will run this, and ports 80 and 443 reachable from the internet on it. Caddy (in `docker-compose.yml`) uses port 80 to complete the ACME HTTP challenge and provisions a Let's Encrypt certificate automatically the first time it starts — there's nothing to configure for TLS beyond having the domain resolve correctly before you bring the stack up.

`PUBLIC_URL` is that domain as a full URL, e.g. `https://mcp.example.com` (no trailing slash). It is simultaneously: the OAuth issuer a client verifies against, the base every OAuth callback is built from, and the domain the `Caddyfile` serves (`{$PUBLIC_URL}` — one value, read in both places, so it can't drift out of sync with itself).

If ports 80/443 are already taken by an existing nginx (a BT-Panel / 宝塔 host, for instance), skip Caddy and use the templates in `deploy/` instead — see [Behind an existing nginx](#behind-an-existing-nginx).

### 2. Generate key material

Two commands, run from the repo root after `npm run build` (the second one imports the compiled `dist/auth/crypto.js`):

```bash
# TOKEN_ENCRYPTION_KEY — 32 random bytes, base64-encoded
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

# ADMIN_PASSWORD_HASH — prompts for the password on stdin; it is never echoed
# and never appears as a command-line argument, so it never lands in shell
# history or in `ps`/the process list the way `node -e "...('the password')"` would.
node -e "const r=require('node:readline').createInterface({input:process.stdin,output:process.stderr});r.question('password: ',p=>{r.close();import('./dist/auth/crypto.js').then(m=>console.log(m.hashPassword(p)))})"
```

Put both outputs, plus `PUBLIC_URL`, into `.env` (`cp .env.example .env` first if you haven't). iCloud credentials are optional here: on a server where everyone logs in with an envelope, the server's `.env` holds none. The admin password is whatever you type at the `password:` prompt — you use that plaintext password to log in to `/admin` later; only its hash goes in `.env`.

### 3. Bring the stack up

```bash
docker compose up -d --build
```

This starts two containers: `caddy` (public-facing, terminates TLS, proxies to `app:17733` over the internal compose network) and `app` (this server; publishes no host port of its own — only `caddy` can reach it). The `token_store` named volume holds two encrypted files: the store (`tokens.json.enc` — OAuth clients, tokens, access keys, settings) and, generated on first start, the envelope key pair (`envelope-key.json.enc`). Losing the volume means recreating every access key, every client re-authorizing and everyone using envelope login taking a new public key — not an iCloud data loss — see "Revoking access" below.

Confirm it's up without going through the OAuth flow:

```bash
curl https://mcp.example.com/health   # -> {"status":"ok"} — this route needs no auth
```

### 4. Create your access key on `/admin`

Open `https://mcp.example.com/admin` and log in with the **plaintext** admin password you chose in step 2 — not the hash. The page (in Chinese) has four parts:

- **访问密钥** — every access key, with its name, creation time, status and last use, plus 停用 / 启用 (disable / enable) and 销毁 (destroy, behind a confirmation page) per row.
- **新建访问密钥** — give a name (1–64 characters) and the page shows the new key, `amk_…`, **exactly once**; the server stores only its hash. Copy it then. Do not reload that page afterwards: it is the result of the create form, so reloading resubmits it and creates a second key (the browser warns before resubmitting). Reopen `/admin` from the address bar instead, and destroy any accidental duplicate.
- **.env 账号** — a switch, off by default. While on, **any** valid access key can log in to the accounts configured in the server's `.env`. Turning it off destroys the sessions already built on those accounts.
- **信封公钥** — the server's envelope public key, `amp1_…`, for the people who log in with envelopes.

The admin session lives in memory only, expires after 30 idle minutes, and does not survive a restart. Create one key for yourself now; the next step uses it.

### 5. Add it as a remote MCP server in claude.ai

1. In claude.ai, add a custom connector / remote MCP server pointing at `https://mcp.example.com/mcp` (your `PUBLIC_URL` plus `/mcp`).
2. claude.ai discovers this server's OAuth metadata at `/.well-known/oauth-authorization-server`, then dynamically registers itself as a client (`POST /register`) and opens `/authorize` in a browser.
3. You'll land on this server's own access-key page (输入访问密钥), which submits to `POST /access-login`. Paste your access key from step 4. The admin password is not accepted here.
4. On success, the browser is redirected back to claude.ai's `redirect_uri` with an authorization code and the original `state` value intact; claude.ai exchanges the code for an access/refresh token pair at `/token`. Every token in that family records which access key it came from. From then on, its tool calls carry `Authorization: Bearer <access token>` to `/mcp`.

This exact chain — dynamic registration, `/authorize`, the access-key page, the `/token` exchange, a real tool call, and a 401 both for a missing and for a forged token — is exercised end to end on a real port by `tests/unit/server/http-e2e.test.ts`.

Each person's sessions are bound to their access key: a `session_id` (or MCP session id) obtained under one key is treated as nonexistent under any other.

### 6. Revoking access

- **One person** — on `/admin`, disable or destroy their key. Either one immediately revokes every token issued under that key, destroys every session it created (closing the IMAP/SMTP connections on the spot), and closes its MCP transports; nobody else is affected. A disabled key can be re-enabled, after which its holder authorizes again — the old tokens do not come back. Destroying also deletes the record.
- **A specific token you hold** (typically because you're testing your own deployment with `curl`) — `POST /revoke` (RFC 7009) with that token invalidates it immediately: revoking either the access or the refresh token revokes the whole family (both), and **immediately destroys any live MCP session that token had authorized** — that session's `session_id` stops working on its very next call, and its IMAP/SMTP connections are closed on the spot rather than staying open until the idle TTL expires. The session is matched to the token by the token family recorded on it when `apple_login` ran; `tests/unit/server/http-e2e.test.ts` asserts the session is really gone from the session store after `POST /revoke`, not merely that `/mcp` now answers 401 — that is the token check, and it passes whether or not any session was destroyed.
- **Everyone at once** — e.g. you suspect `TOKEN_ENCRYPTION_KEY` leaked, or you just want a clean slate — `docker compose down` plus `docker volume rm <project>_token_store`, then bring it back up. That deletes the store (every access key, client, token and setting) and the envelope key pair: recreate keys on `/admin`, redistribute them and the new public key, and every client redoes the authorization flow. No iCloud data is touched.

### Sharing one server: access keys and envelope login

The owner of the server decides **who can connect** (one access key per person); each person decides **which iCloud account and which permissions** — in their own Claude Routine environment, with the same variables as always. The server stores nobody's iCloud password. Instead, the routine's sandbox runs a script that seals the account into an envelope only the server can open, and the model passes it to `apple_login`:

1. **Owner:** on `/admin`, create a key for the person and send it to them privately, together with the envelope public key shown on the same page. Keep ".env 账号" off — with it on, anyone holding a key who calls `apple_login` without an envelope lands in *your* iCloud account.
2. **Person:** add the connector in claude.ai and authorize with the access key. In the routine's environment set `ICLOUD_ACCOUNT_1`, `ICLOUD_APP_PASSWORD_1` (plus `ICLOUD_SENDER_1` / `ALLOW_*_1` as needed) and `MCP_ENVELOPE_PUBKEY=<the amp1_… line>`, as environment variables or a UTF-8 `.env` at the repo root. Have the routine check out this repo and read `SKILL.md` — or, for a Routine that lives in another repository, copy just `scripts/make-envelope.mjs` (or download it pinned to a commit and hash-checked) and paste the short instructions from [`docs/远程连接-单脚本接入.md`](docs/远程连接-单脚本接入.md) into it.
3. **The model**, per `SKILL.md`: run `node scripts/make-envelope.mjs` (zero dependencies, Node 20+, no build needed), pass its single line of stdout, `ame1.…`, as `apple_login({ envelope })`, work, then `work_done`.

The script reads `.env` in the current directory if present, with process environment variables taking precedence; for another file use `node scripts/make-envelope.mjs -- --env-file <path>` (without the `--`, Node 24+ intercepts `--env-file` itself and exits 9 when the file is missing). It seals only the twelve `_1` account variables, refuses a config with `ICLOUD_ACCOUNT_2`+, writes errors to stderr naming variables but never values, and never touches the network. An envelope is valid for 5 minutes and only once — it is spent the moment the server accepts it, even if the iCloud login that follows fails. The account it carries goes through exactly the same parsing as a `.env` account: writes off unless enabled, the iCloud sender-domain guard, strict booleans. Any adjustment shows up in `apple_login`'s `notices`.

Read the trust caveat under [Limitations](#limitations-to-know-before-you-rely-on-this) before using someone else's server. The full owner and user walkthrough, including what to do if the server is compromised, is in Chinese in [`docs/部署与-Routine-接入.md`](docs/部署与-Routine-接入.md).

### Behind an existing nginx

When ports 80/443 already belong to an nginx (a BT-Panel / 宝塔 host is the case these were written for), use the two templates in `deploy/` instead of Caddy: `deploy/compose.vps.yml.example` runs only `app`, bound to `127.0.0.1:17733` with `TRUST_PROXY` on, and `deploy/nginx-site.conf.example` proxies `https://mcp.example.com` to it. Each override in the nginx template is there for a reason stated next to it: `proxy_cache off` (BT's global config caches proxied responses — OAuth and MCP responses must never be served to someone else), `proxy_next_upstream off` (a retried request replays a `mail_send`), long read/send timeouts and no buffering (the SSE stream on `GET /mcp`), and `X-Forwarded-For $remote_addr` *overwriting* rather than appending (with `TRUST_PROXY` on, express takes the leftmost entry, so appending lets a caller pick their own rate-limit bucket). Step-by-step instructions are in `docs/部署与-Routine-接入.md`.

### Upgrading from the admin-password version

Before access keys, the authorization page took the admin password. After upgrading:

- **Existing connector authorizations stop working.** Their tokens belong to no access key and are rejected. Log in to `/admin`, create a key for yourself, and reconnect the connector in claude.ai with it.
- **Accounts in the server's `.env` are off by default.** The server logs a warning at startup when it has accounts configured but ".env 账号" is off. Turn it on at `/admin` to keep using them, or move to envelope login and remove them.
- **The admin password only opens `/admin`** now.

The stdio and sandbox CLI entrypoints are unaffected and need no change.

### Notes

- **CORS** on `/mcp` allows only `PUBLIC_URL`'s own origin and `https://claude.ai` — a browser-based client at any other origin will be blocked by the server itself, not just by the client's own same-origin policy.
- Local testing without Docker or a domain: `PUBLIC_URL=http://localhost:17733` is allowed (localhost/127.0.0.1 are exempted from the https requirement) — set the three required variables in `.env` and run `npm run build && npm run serve:http` (or `npm run start:http` from source, no build step).

## Testing

```bash
npm test                 # unit tests: no network, no credentials, always safe to run
npm run test:integration # live iCloud tests: requires .env.test, see below
```

`npm test` runs the unit suite only (`vitest.config.ts`, `tests/unit/**`) — no network access, nothing to configure.

`npm run test:integration` runs `tests/integration/live.test.ts` against a **real** iCloud account, using `vitest.integration.config.ts`. It is skipped entirely — cleanly, with no failure — unless a `.env.test` file exists at the repo root. To run it:

1. Create a dedicated calendar and a dedicated reminder list in iCloud for testing (e.g. both named `MCP-Test`) — the suite only ever writes to these, never your real ones. If either is missing, its test fails with a message telling you to create it; it never falls back to writing into another calendar or list. Contacts have no equivalent "dedicated address book" a real user would create just for testing, so contact writes are isolated by name instead: every contact the suite creates has `FN` starting with `INTEGRATION_CONTACT_PREFIX` (default `MCP-Test-`), and deletion re-checks that prefix before it deletes anything.
2. `cp .env.test.example .env.test` and fill in real credentials plus `INTEGRATION_CALENDAR_NAME` and `INTEGRATION_REMINDER_LIST_NAME` matching what you just created.
3. `npm run test:integration`.

`.env.test` is gitignored; never commit it.
