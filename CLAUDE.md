# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`apple-icloud-mcp`: an MCP server exposing Apple iCloud Mail (IMAP/SMTP) and Calendar (CalDAV) as tools, over the **stdio** transport. TypeScript, ESM (`"type": "module"`, `module: NodeNext`), `strict` + `noUncheckedIndexedAccess` on. Phase one covers Mail + Calendar only; Reminders/Contacts are phase two, a remote HTTP+OAuth transport is phase three — neither exists in this repo yet.

## Commands

```bash
npm start               # dev: tsx runs src/bin/stdio.ts directly, no build step
npm run build            # tsc -> dist/
npm run serve             # prod: node dist/bin/stdio.js (requires a prior build)
npm run typecheck         # npx tsc --noEmit
npm test                  # unit suite: vitest.config.ts, tests/unit/**, no network
npm run test:integration  # live-iCloud suite: vitest.integration.config.ts, tests/integration/**
                           # skipped entirely unless .env.test exists at repo root
```

`npx vitest run` (no config flag) runs the unit config and therefore never touches real iCloud. The integration suite is opt-in only — see `README.md` → Testing.

## Architecture

Strict layering, request path `bin → server → modules → providers`, with `parsers` as a separate pure-function layer consumed by `modules`:

- **`src/core/`** — cross-cutting, no I/O of its own. `config.ts` is the single source of credentials: `loadConfig(env)` scans `ICLOUD_ACCOUNT_1..5` etc. and builds `AccountConfig[]`, mapping legacy lowercase v1 variable names with a deprecation warning. `errors.ts` defines `AppError`/`ErrorCode` and `toErrorPayload()`, the only thing that ever crosses the tool boundary on failure. `session.ts` is an in-memory `Map`-backed session store (TTL-based expiry, swept periodically). `ids.ts` encodes/decodes opaque resource ids as base64url.
- **`src/providers/icloud/`** — thin wrappers around `imapflow`, `nodemailer`, and `tsdav`, one file per protocol plus `index.ts` (`createProviders`) that assembles all three for a session. Each provider maps raw client errors to `AppError` via a local `mapXError()` function (`mapImapError`, `mapSmtpError`, `mapCalDavError`). No knowledge of MCP or tool schemas belongs here.
- **`src/parsers/`** — pure functions, no I/O: `mime.ts` decodes MIME/RFC 2047 email content, `ical.ts` converts between iCal text and the `CalendarEvent`/`EventInput` domain types (parsing, building, patching, recurrence expansion). Because they're pure, these are the easiest layer to unit test exhaustively and where most of the calendar edge-case tests live (`tests/unit/parsers/ical*.test.ts`).
- **`src/modules/{mail,calendar,session}/`** — one module per domain, each split into `service.ts` (business logic: permission gates, calls into providers/parsers, maps to response shapes) and `tools.ts` (zod input schemas + `registerTool` wiring; thin — delegates straight to the service).
- **`src/server/`** — `createServer.ts` builds the `McpServer` and calls each module's `register*Tools`, gated on whether *any* configured account has that capability at all (an account-level filter, not per-call). `wrap.ts` is the tool boundary: serializes success as JSON text, catches anything and turns it into the `{ error: {...}, isError: true }` shape via `toErrorPayload`. `types.ts` defines the minimal `ToolRegistrar` interface the modules depend on, so tool-registration logic can be unit-tested without booting a real `McpServer`.
- **`src/bin/stdio.ts`** — the only entrypoint. Loads config, builds the session store and server, connects a `StdioServerTransport`, installs `SIGINT`/`SIGTERM` handlers with a bounded shutdown timeout. Any startup failure (bad config, etc.) writes to **stderr** and exits non-zero — never stdout.

`SKILL.md` is the usage contract an AI client reads (login → call with `session_id` → `work_done`, all 15 tools, error-code recovery table). **Adding or changing a tool touches at least three places**: the module's `tools.ts` (schema + registration), the module's `service.ts` (behavior), and `SKILL.md` (the contract). If it changes a documented limitation (see README's "Limitations" section), update the README too.

## Non-obvious constraints and why

- **ESM relative imports need an explicit `.js` extension**, even though the source files are `.ts` (`import { X } from '../core/config.js'`). This is `NodeNext` module resolution, not a typo — TypeScript resolves it to the `.ts` file at compile time but the emitted JS needs the extension to run.
- **stdout belongs entirely to the MCP protocol.** Nothing in this codebase writes to stdout directly; all logging goes through `core/logger.ts` to **stderr**, and startup failures in `bin/stdio.ts` are written to stderr explicitly. Never add a `console.log` — it would corrupt the stdio JSON-RPC stream.
- **IMAP/SMTP authenticate with `account.sender`; CalDAV authenticates with `account.email`.** These are two different fields on `AccountConfig` (`sender` falls back to `email` if `ICLOUD_SENDER_n` isn't set) because a user's IMAP/SMTP login identity can be an alias distinct from their Apple ID, while CalDAV always wants the Apple ID. This exact confusion caused real bugs in the v1 history (`Fix IMAP auth`, prior `Fix icloud email sender logic`) — when touching auth code in `providers/icloud/*.ts`, keep the two straight. It also caused a real misdiagnosis: an Apple ID that's a Gmail address falls back `sender = email`, Apple's IMAP server rejects a non-iCloud username outright, and the resulting `AUTHENTICATIONFAILED` looks exactly like a revoked App-Specific Password. `core/config.ts::loadConfig` now guards against this at config-load time: after parsing each account, if its effective `sender` isn't on an iCloud mail domain (`icloud.com` / `me.com` / `mac.com` / `icloud.com.cn`, exact-match on the domain — not a suffix check), that account's `mailRead`/`mailWrite` are forced to `false` regardless of `ALLOW_MAIL_*`, and an explanatory string is pushed onto `AppConfig.notices` (printed to stderr by `bin/stdio.ts`, alongside but separate from `deprecations`). Calendar capabilities are untouched — a calendar-only user on a non-iCloud address is unaffected. Don't "fix" this by relaxing or removing the domain check; it exists specifically because the fallback-to-email behavior above is otherwise a silent trap.
- **Write permissions default to OFF** (`ALLOW_MAIL_WRITE_n` / `ALLOW_CALENDAR_WRITE_n`), while read defaults to ON. This was deliberately flipped from v1, where write defaulted to on and a misspelled variable name silently granted delete access. `core/config.ts::readBool` takes an explicit `fallback` per call — don't change a write-capability default to `true` without a very good reason and a note in the README.
- **CalDAV etags never appear in a tool's public interface.** `expected_etag` is an *optional* optimistic-concurrency input a caller may supply, but `event_id`/`calendar_id` (built by `core/ids.ts`) never encode an etag, and no tool response surfaces one. Etags are read fresh from CalDAV (`loadForWrite` in `modules/calendar/service.ts`) immediately before every write and compared there — never trust or thread through a cached one.
- **`calendar_update_event` patches the existing VEVENT in place; it does not rebuild it from the `CalendarEvent` model.** `parsers/ical.ts::applyEventPatch` mutates the parsed iCal AST for only the fields present in the patch. This is deliberate: rebuilding from the domain model would silently drop every iCal property our model doesn't represent — `ATTENDEE`, `ORGANIZER`, `CATEGORIES`, `STATUS`, `X-APPLE-*` — which is real user data (invitee lists, RSVP state) this phase does not manage. The model is still used to *validate* the merged result (e.g. `end` after `start`) before the patch is written.
- **Event creation has no `timezone` field and never will in this phase** (`EventInput` in `parsers/ical.ts`). Emitting `DTSTART;TZID=` correctly requires shipping VTIMEZONE data this phase doesn't have, so created events are UTC-anchored; a recurring event drifts an hour across a DST transition for zones that observe it. This is documented in the README/SKILL, not a bug to silently "fix" by adding a timezone parameter without also solving VTIMEZONE.
- **Calendar privilege detection fails safe, not closed.** `providers/icloud/caldav.ts::applyPrivilegeFallback`: if `current-user-privilege-set` detection finds *no* writable calendar at all across the account, every calendar is reported `writable: true` rather than `false` — because iCloud accounts always have at least one genuinely writable calendar, so an all-read-only result more likely means detection broke than that the account can't write anywhere. The server's own 403 handling (`mapCalDavError`) is the real backstop in that case, not the `writable` flag.
- **`mail_delete` moves to trash by default; only `permanent: true` expunges.** Don't assume delete is immediate/irreversible unless that flag is set.

## Repository hygiene

`dist/`, `node_modules/`, and `.env` are gitignored and untracked — always run `npm run build` before `npm run serve` after touching `src/`. `.env.test` (real integration credentials) is gitignored too; only `.env.example` and `.env.test.example` (placeholders) are committed. Never read, print, or commit the contents of `.env`.
