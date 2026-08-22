# Apple iCloud MCP Server

A Model Context Protocol (MCP) server that exposes Apple iCloud **Mail** (IMAP/SMTP) and **Calendar** (CalDAV) as tools for AI agents, over the stdio transport. Supports up to 5 iCloud accounts at once, each with independent read/write permissions.

**Not supported, and not planned for this approach:** iCloud Notes. Apple provides no standard protocol for Notes (no IMAP/CalDAV equivalent) that works with an App-Specific Password, so there is no way to implement this without reverse-engineering a private, unsupported API. Reminders and Contacts are planned for phase two (they reuse the CalDAV/CardDAV machinery already in place here); they are not available yet.

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
| `ICLOUD_ACCOUNT_2` .. `_5`, `ICLOUD_APP_PASSWORD_2` .. `_5`, etc. | no | — | Same fields, repeated per account slot 2–5. |
| `SESSION_TTL_MINUTES` | no | `30` | A session (from `apple_login`) expires after this many minutes of inactivity. |
| `IMAP_IDLE_TIMEOUT_SECONDS` | no | `300` | IMAP idle/connection timeout. |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug`. All logging goes to **stderr** — stdout is reserved for the MCP protocol. |

**Write permissions default to OFF.** This is a deliberate change from the previous version of this server, which defaulted writes to on — a typo in a variable name there would silently grant delete-mail permission. Now, an unset or misspelled write-permission variable fails closed.

**The effective sender must be an iCloud mail address.** IMAP/SMTP authenticate with the effective sender (`ICLOUD_SENDER_n`, falling back to `ICLOUD_ACCOUNT_n` if unset) — not with `ICLOUD_ACCOUNT_n` itself, which CalDAV uses instead. Apple's IMAP/SMTP servers reject any username that isn't an Apple-assigned iCloud address, so if your Apple ID (or your `ICLOUD_SENDER_n`) is not `@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`, that account's mail tools are **automatically disabled at startup** — `mailRead`/`mailWrite` are forced to `false` regardless of `ALLOW_MAIL_READ_n`/`ALLOW_MAIL_WRITE_n`, and a notice explaining why is printed to stderr. Calendar is unaffected. If you do have an iCloud mail address, set `ICLOUD_SENDER_n` to it; if you don't, that account simply doesn't use iCloud Mail and only calendar tools are available for it.

**Legacy (v1) variable names still work**, mapped automatically with a deprecation warning on stderr: `icloud_account`, `icloud_app_pass`, `icloud_sender`, and the multi-account forms with the digit inside the name (`icloud_account2`, `allow_mail2_read`, `allow_calendar3_write`, …). `multiple_account_enable` is now a no-op — accounts 2–5 are detected by presence of `ICLOUD_ACCOUNT_n`, not by an enable flag.

## Install and run

```bash
npm install
npm run build
npm run serve      # runs the compiled dist/bin/stdio.js
```

For development, run the TypeScript source directly without a build step:

```bash
npm start           # tsx src/bin/stdio.ts
```

The server communicates over **stdio** only in this phase. If it starts with no accounts configured, or with an invalid `.env`, it exits non-zero and writes an actionable error to stderr (never to stdout, which belongs to the MCP protocol).

## Using it with Claude Code (stdio MCP server)

Register it in your MCP client config with an absolute path to the built entrypoint:

```json
{
  "mcpServers": {
    "apple-icloud": {
      "command": "node",
      "args": ["/absolute/path/to/apple_mcp/dist/bin/stdio.js"],
      "env": {
        "ICLOUD_ACCOUNT_1": "your-name@icloud.com",
        "ICLOUD_APP_PASSWORD_1": "abcd-efgh-ijkl-mnop",
        "ALLOW_CALENDAR_WRITE_1": "true"
      }
    }
  }
}
```

Run `npm run build` first so `dist/bin/stdio.js` exists. `SKILL.md` in this repo is the usage contract an AI client should read: it documents the login → call-with-`session_id` → `work_done` flow, all 15 tools, and how to recover from each error code.

## Tools

All tools except `apple_accounts` and `apple_login` require a `session_id` obtained from `apple_login`.

| Tool | Summary |
|---|---|
| `apple_accounts` | List configured accounts and their read/write capabilities. No session required. |
| `apple_login` | Authenticate (verifies IMAP + CalDAV live) and open a session; returns `session_id`. |
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

## Limitations to know before you rely on this

- **Event creation is UTC-anchored, with no timezone field.** `start`/`end` must carry an explicit offset (e.g. `2026-09-10T14:00:00+08:00`) — a bare local time is silently read as UTC. A one-off event created this way is fine, since the ISO timestamp is already an absolute instant. A **recurring** event, however, will drift by an hour across a daylight-saving transition, for users in DST-observing zones. Users in zones without DST (mainland China included) are unaffected. Reading events back still reports the correct source timezone.
- **Attendees are preserved, not managed.** `calendar_update_event` patches the existing event in place, so `ATTENDEE`, `ORGANIZER`, `CATEGORIES`, `STATUS`, and `X-APPLE-*` properties survive an edit untouched. Adding/removing invitees and anything about invitation/RSVP status is out of scope this phase.
- **Attachments are not supported.** `mail_read` reports attachment filename/type/size but cannot download content; `mail_send` cannot attach files.
- **`mail_delete` moves to trash, not permanently, unless `permanent: true`.**
- **iCloud Notes are unsupported**, and will remain so under this approach — see above.
- **Mail tools silently disappear for an account whose sender isn't an iCloud address.** Symptom: the `mail_*` tools are missing for that account (or, if you bypass this check by other means, IMAP/SMTP fail with `AUTHENTICATIONFAILED` / `AUTH_FAILED`). Cause: IMAP/SMTP authenticate with the effective sender (`ICLOUD_SENDER_n`, or `ICLOUD_ACCOUNT_n` as a fallback), and Apple's mail servers reject a non-iCloud username outright — a Gmail-based Apple ID is the common case. Fix: set `ICLOUD_SENDER_n` to your actual iCloud mail address (`@icloud.com` / `@me.com` / `@mac.com` / `@icloud.com.cn`); if you don't have one, you don't use iCloud Mail and only calendar is available for that account. Check stderr at startup for the exact notice naming the affected account.
- Range queries (`calendar_list_events`) use overlap semantics: an event that starts before the window but runs into it is included — this is what "what's on today" should mean for an overnight or multi-day event, and matches RFC 4791.

## Testing

```bash
npm test                 # unit tests: no network, no credentials, always safe to run
npm run test:integration # live iCloud tests: requires .env.test, see below
```

`npm test` runs the unit suite only (`vitest.config.ts`, `tests/unit/**`) — no network access, nothing to configure.

`npm run test:integration` runs `tests/integration/live.test.ts` against a **real** iCloud account, using `vitest.integration.config.ts`. It is skipped entirely — cleanly, with no failure — unless a `.env.test` file exists at the repo root. To run it:

1. Create a dedicated calendar in iCloud for testing (e.g. named `MCP-Test`) — the suite only ever writes to this calendar, never your real ones.
2. `cp .env.test.example .env.test` and fill in real credentials plus `INTEGRATION_CALENDAR_NAME` matching the calendar you just made.
3. `npm run test:integration`.

`.env.test` is gitignored; never commit it.

## What's not here yet

- **Reminders and Contacts** (phase two): planned to reuse this server's CalDAV provider and iCal parsing layer (Reminders are VTODO) plus a new CardDAV provider (Contacts).
- **Remote HTTP transport with OAuth 2.1** (phase three): this server currently only speaks stdio, for a single local trusted client. A `bin/http.ts` Streamable HTTP transport with a proper authorization server, plus Docker/deployment docs, is planned but not implemented in this repository yet.
