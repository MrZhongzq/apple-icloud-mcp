# Apple iCloud MCP Server

A Model Context Protocol (MCP) server that exposes Apple iCloud **Mail** (IMAP/SMTP), **Calendar** (CalDAV), **Reminders** (CalDAV), and **Contacts** (CardDAV) as tools for AI agents, over the stdio transport. Supports up to 5 iCloud accounts at once, each with independent read/write permissions.

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
- **Contact photos are reported as a boolean only.** `has_photo` tells you whether a `PHOTO` property exists on the vCard; no tool returns photo bytes or a URL, and no response ever contains base64 image data.

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

## What's not here yet

- **Remote HTTP transport with OAuth 2.1** (phase three): this server currently only speaks stdio, for a single local trusted client. A `bin/http.ts` Streamable HTTP transport with a proper authorization server, plus Docker/deployment docs, is planned but not implemented in this repository yet.
