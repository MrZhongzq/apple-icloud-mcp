---
name: apple-icloud-mcp-skill
description: Usage contract for AI clients calling the Apple iCloud MCP server (Mail + Calendar + Reminders + Contacts) — over stdio, over remote Streamable HTTP + OAuth (including envelope login with `node scripts/make-envelope.mjs`), or from a shell via the sandbox CLI — including the rules that replace it when running unattended in a scheduled routine.
---

# Apple iCloud MCP Server — AI Client Contract

This server exposes the same tools for Apple iCloud Mail, Calendar, Reminders, and Contacts across three ways of reaching it: as a local **stdio** subprocess, as a remote **Streamable HTTP** server behind OAuth 2.1 (see the host project's README → "Remote deployment"; there you may log in with a sealed **envelope** of your own credentials), and as a **sandbox CLI** you drive from a shell (`node dist/bin/cli.js`, documented in `docs/沙盒-CLI-用法.md`). All three share every tool and all business logic. Read this before calling any of them.

## Which of these are you?

**Everything in this document applies to you either way** — what each tool does, its arguments, its return shape, the error codes, the recovery table, and the unattended rules. What differs is only who owns the session, how you log in, and the two tools that exist solely to manage the session. Find your column before you read anything else:

| | **MCP client** (stdio, or remote HTTP) | **Remote connector + a shell and this repo** (envelope login) | **Sandbox CLI** (`node dist/bin/cli.js`) |
|---|---|---|---|
| How many tools | **25** | **25** | **at most 23** — the same list, minus `apple_login` and `work_done`. Fewer when capabilities are off: `--list` shows exactly what is available now, and `apple_accounts` shows why |
| Sessions | **You manage them.** `apple_login` → work → `work_done`, passing `session_id` on every call in between | **You manage them**, exactly as in the first column | **The CLI manages them.** Every command creates a session, runs, and destroys it. There is no `session_id` argument, ever |
| `apple_login` / `work_done` | Required — see the workflow below | Required. `apple_login` takes an `envelope` you generate in your shell — see "Envelope login" below | **They do not exist.** Calling either exits 1 with an error saying so; there is nothing for them to do |

The middle column is you when the iCloud tools reach you through a **remote** MCP connector *and* you also have a shell with this repository checked out — typically a Claude Routine whose cloud sandbox cloned the repo and whose environment holds the user's own `.env` or environment variables. The credentials live in your environment, not on the server; you hand them to the server sealed, as an envelope. Everything said about MCP clients below applies to you too.

So: paragraphs below marked **(MCP only)** are about a session lifecycle the CLI already handles for you — read them as background, do not try to execute them. Everything else is yours regardless.

Reading a tool signature as a CLI caller: each tool is a subcommand and each argument is a `--flag` (`node dist/bin/cli.js mail_search --folder INBOX --limit 5`); nested objects and arrays are passed as one JSON string (`--query '{"unseen":true}'`); `session_id` is never a flag. `cli <tool> --help` prints that tool's flags straight from its schema, and `cli --list` prints the ones available under the current configuration (23 with everything enabled — fewer is configuration, not breakage). Boolean arguments are `--flag` for true and `--no-flag` for false, and take no value. Arguments are checked against the same schema before the tool runs, so a wrong type, a missing required argument, or a misspelled one fails with **exit 1** and the tool does not run at all — distinct from exit 2, which means the tool ran and iCloud answered with an error. To run several calls in one session, see `cli start` / `cli stop` and `cli batch` in `docs/沙盒-CLI-用法.md`. From a Claude Routine's cloud sandbox the CLI cannot reach mail at all — see "(CLI in a Claude Routine's cloud sandbox)" under "Running unattended" before you call any `mail_*` command there.

For MCP clients specifically: the remote HTTP entrypoint adds an authorization step (a browser-based login with a per-person access key, handled entirely outside this contract) before your first call, and its `apple_login` has one extra argument, `envelope`. A remote server shares one machine among several people, so by default it does **not** let anyone log in to accounts configured on the server itself — `apple_login` without an `envelope` then fails with `INVALID_INPUT` ("这台服务器只接受加密信封登录"), and `apple_accounts` returns `[]`. Both are normal; they mean "use envelope login", not "the server is broken". Otherwise `apple_login`'s semantics and return shape are identical on every entrypoint: it still connects live to verify credentials and still returns the same `session_id` shape, regardless of which entrypoint issued it.

### Envelope login (remote connector + shell)

1. From the repository root, run `node scripts/make-envelope.mjs`. (If your instructions say the script was copied into a different repository — the single-file setup — run it from the path they give; it behaves identically.) On success it exits 0 and writes exactly one line to stdout, starting with `ame1.`. Pass that whole line, unchanged, as the `envelope` argument: `apple_login({ envelope: "<that line>" })`. Do not pass `account` alongside it. The line will show up in your shell tool's output when the script runs — that is expected and fine: it is ciphertext only the server can open, and it is spent on first use. What you must not do is repeat it anywhere beyond that output and the one argument: do not echo it again, quote it back in your reply, summarize, or edit it.
2. Call the other tools normally, with the `session_id` that `apple_login` returned.
3. Call `work_done` at the end.

If the script exits 1, its one line on stderr names what is missing or wrong (for example `缺少环境变量 MCP_ENVELOPE_PUBKEY`) — it names variables, never their values. That is a configuration problem for a human to fix in the routine's environment; report it and stop rather than improvising a workaround. Never "check" the configuration by printing it — see the last rules under "Running unattended".

An envelope is valid for 5 minutes from the moment the script ran, and only once: the server marks it used the moment it accepts it, **even if the iCloud login that follows fails**. So generate it right before `apple_login`, never ahead of time, and never reuse one. If `apple_login` rejects it as expired (`信封已过期`), already used (`这个信封已经用过`), or mangled (`信封格式不对`), run the script again and retry **once**. "Once" is one regeneration in total for the login, not once per kind of refusal: if the regenerated envelope is refused too — for the same reason or a different one — stop and report.

## Workflow (MCP only)

On the CLI this whole sequence collapses to "run the command you want" — steps 2 and 4 are done for you, per command, and step 3 needs no `session_id`. Read it for what step 3's tools do; do not run steps 2 or 4.

1. **(Optional) `apple_accounts`** — no session needed. Lists configured accounts and their capabilities. Call this first if you don't already know which account/email to use, especially in multi-account setups. With envelope login, skip it: the account is inside the envelope, and the list is empty on a server that only accepts envelopes.
2. **`apple_login`** — establish a session. This actually connects to verify the credentials, so a bad password fails here, immediately, not later. Only the protocols the account's enabled capabilities need are contacted — IMAP for mail, CalDAV for calendar and reminders, CardDAV for contacts — so an account whose mail tools are disabled still logs in fine. Returns `session_id`. If there is exactly one configured account, `account` may be omitted. With envelope login, pass `envelope` instead of `account` (see "Envelope login" above).
3. **Do the work** — every other tool call requires the `session_id` from step 2, passed as the `session_id` argument.
4. **`work_done`** — call this once you have completely finished the user's task and no longer need iCloud access. It destroys the session and closes the underlying connections. Do not skip this at the end of a task.

## The 25 tools

(at most 23 on the CLI: everything below except `apple_login` and `work_done`, minus whatever the account's capabilities disable. Where a signature shows `session_id`, the CLI fills it in for you and offers no flag for it.)

### Session (no `session_id` needed for the first one)

- `apple_accounts()` → list of `{ email, label, capabilities }`. Lists only accounts configured on the server. On a remote server that only accepts envelope login it returns `[]` — that is normal, not a failure, and it says nothing about whether your envelope will work.
- `apple_login({ account?, envelope? })` → `{ session_id, account, label, capabilities, notices? }`. `account` is the iCloud email; omit only when a single account is configured. `envelope` exists only on the remote HTTP entrypoint: the one line printed by `node scripts/make-envelope.mjs`, passed unchanged; give `account` or `envelope`, never both. `notices` appears only when the server adjusted the account while logging in — for example, mail turned off because the sender is not an iCloud address; read it, and tell the user if it explains a tool that later refuses.
- `work_done({ session_id })` → `{ success }`.

### Mail (all require `session_id`)

- `mail_folders({ session_id })` → `{ folders: FolderInfo[], partial_failures?: { path, reason }[] }` — folder list with unread counts and `specialUse` (inbox/trash/sent/…). `partial_failures` appears only when at least one folder's status could not be read; the rest of `folders` is still complete.
- `mail_search({ session_id, folder?, query?, limit?, cursor? })` → `{ messages: MessageSummary[], nextCursor? }`. `query` fields: `from`, `to`, `subject`, `text`, `since`, `before` (ISO 8601), `unseen`, `flagged`. Headers/summary only — use `mail_read` for body. Page with `cursor`.
- `mail_read({ session_id, uid, folder?, format? })` → full decoded body, headers, attachment metadata. `format` is `text` | `html` | `both`, default `text`. `uid` comes from `mail_search`. If the message itself cannot be decoded (malformed MIME), the call still succeeds and returns `parse_error: true` with empty body fields, rather than failing — tell the user this particular message could not be decoded instead of retrying.
- `mail_send({ session_id, to[], cc?, bcc?, subject, text?, html?, in_reply_to? })` → send confirmation. At least one of `text`/`html` required.
- `mail_mark({ session_id, uid[], folder?, flags: { seen?, flagged? } })` → batch flag update.
- `mail_move({ session_id, uid[], from_folder, to_folder })` → batch move.
- `mail_delete({ session_id, uid[], folder?, permanent? })` → moves to trash by default; `permanent: true` expunges immediately and cannot be undone.

### Calendar (all require `session_id`)

- `calendar_list({ session_id })` → `{ calendar_id, name, color?, writable, supports }[]`. `supports` lists the CalDAV component types the calendar holds (e.g. `["VEVENT"]`).
- `calendar_list_events({ session_id, start, end, calendar_ids?, expand_recurring? })` → `{ events: CalendarEvent[], truncated?: true, partial_failures?: { calendar_id, name, reason }[] }`, `events` sorted by start. There is no `limit` parameter, but the result is capped at **1000** events; when more matched, `truncated: true` is set and you hold only the earliest-starting slice — so **never** answer "you have nothing on X" from a truncated result: narrow `start`/`end`, pass `calendar_ids`, or set `expand_recurring: false` (one daily event expands into one entry per day and eats the cap fast), then look again. Overlap semantics: an event starting before `start` that runs into the window is included. Recurring events expand into one entry per occurrence by default (`expand_recurring` default `true`); each occurrence carries a `recurrence_id`. `partial_failures` appears only when at least one queried calendar failed (e.g. a stale subscribed/shared calendar returning 403) — `events` still contains every successfully-read calendar's results, so tell the user which calendar(s) named in `partial_failures` are broken rather than treating the whole call as failed.
- `calendar_create_event({ session_id, calendar_id?, event })` → the created `CalendarEvent`. `event.start`/`event.end` **must carry an explicit UTC offset** (e.g. `2026-09-10T14:00:00+08:00`) — there is no `timezone` field; a bare local time is read as UTC. `calendar_id` omitted → written to the first writable calendar. See "Recurring event caveat" below.
- `calendar_update_event({ session_id, event_id, patch, scope?, recurrence_id?, expected_etag? })` → the updated `CalendarEvent`. `patch` carries only the fields to change. See "scope and recurrence_id" below.
- `calendar_delete_event({ session_id, event_id, scope?, recurrence_id?, expected_etag? })` → `{ deleted: true }`. Cannot be undone. Same `scope`/`recurrence_id` rules as update.

### Reminders (all require `session_id`)

- `reminders_lists({ session_id })` → `{ list_id, name, color?, writable }[]`. `list_id` is opaque, for use with the other reminder tools.
- `reminders_list({ session_id, list_ids?, completed?, due_before?, due_after?, limit? })` → `{ reminders: Reminder[], truncated?: true, partial_failures?: { list_id, name, reason }[] }`. Leave `list_ids` empty to query every list. `reminders` is sorted by `due` ascending, with reminders that have **no** due date last and `title` as the tiebreak. `limit` defaults to **100** (max 1000); when more reminders matched than `limit`, `truncated: true` is set — the result is then only the earliest-due slice, so **never** answer "you have no reminder about X" from a truncated result: narrow the query (`list_ids`, `completed: false`, a due range) or raise `limit`, then look again. One list failing to read (subscribed/shared list gone stale, 403, timeout) never blocks the rest — that list shows up in `partial_failures` instead, so tell the user which list is broken rather than treating the whole call as failed.
- `reminders_create({ session_id, list_id?, reminder })` → the created `Reminder`. `list_id` omitted → written to the first writable list. `reminder.priority` and `reminder.due` follow the rules below.
- `reminders_update({ session_id, reminder_id, patch, expected_etag? })` → the updated `Reminder`. `patch` carries only the fields to change.
- `reminders_delete({ session_id, reminder_id, expected_etag? })` → `{ deleted: true }`. Cannot be undone.

**`priority` is iCal's 0–9 scale, and it runs backwards from intuition:** smaller numbers are *higher* priority. Apple's own clients use `1` = high, `5` = medium, `9` = low, `0` = unset/none. Do not map "priority 9" to "urgent" — that is exactly reversed. When a user says "high priority," send `1`, not `9`.

**`due` is three-state, not the usual optional field.** Omitting it from `patch` leaves the existing due date untouched; sending an ISO 8601 string sets it; sending `null` explicitly *clears* it (Apple's Reminders lets you remove a due date without deleting the reminder, and `undefined` was already taken to mean "don't touch this field"). `reminders_create`'s `reminder.due` also accepts `null` alongside a string or omission — all leave the reminder with no due date except a string, which sets one; it's `reminders_update`'s `patch.due` where `null` carries the extra meaning of clearing an existing due date.

**`completed` is how you check a reminder off — it is the main thing `reminders_update` is for.** Send `patch: { completed: true }` to mark a reminder done and `{ completed: false }` to un-do it; there is no separate "complete" tool, and deleting is *not* completing. `reminders_create` accepts `completed` too, for importing something already finished. Omitting it leaves the current state alone. The returned `Reminder` carries `completed` and, when done, `completed_at`.

**`all_day_due` makes the due date a whole day rather than a moment.** With `all_day_due: true` the time-of-day in `due` is discarded and only the calendar date is kept, read in the offset written on that timestamp — see "All-day values" under the interface conventions. Omitting it on `reminders_update` keeps whatever the reminder already is.

**Reminder due bounds are inclusive; event time ranges are not.** `reminders_list`'s `due_after`/`due_before` are inclusive on **both** ends — a reminder due at exactly `due_before` is returned. `calendar_list_events`'s `start`/`end` are the usual half-open `[start, end)` window with overlap semantics. Do not carry one convention over to the other.

**Any due bound excludes every reminder that has no due date.** Passing `due_after` and/or `due_before` filters out undated reminders entirely — they are not "unknown, keep them", they are dropped. This has no calendar equivalent (an event always has a start). So a due-range query can never be used to prove a reminder does not exist; to see undated reminders, call `reminders_list` with no due bounds at all.

**`list_id` and `reminder_id` are opaque strings**, exactly like `calendar_id`/`event_id` — never parsed, constructed, or truncated; always the exact value a previous tool call returned. Same etag rule too: `expected_etag` is an optional optimistic-concurrency input, but neither id ever contains one.

### Contacts (all require `session_id`)

- `contacts_search({ session_id, query?, address_book_ids?, limit? })` → `{ contacts: Contact[], truncated?: true, partial_failures?: { address_book_id, name, reason }[] }`. `query` matches name (full/family/given), organization, department, title, nickname, every email, every phone (also matched after stripping non-digit characters, so `13800000000` and `+86 138 0000 0000` match each other), and note — case-insensitively. Leave `query` empty to list every contact (still subject to `limit`). Address-book groups (iCloud's "Coworkers", "Family" and the like, stored as group vCards) are not contacts and are never returned. Results are sorted by `name.full` ascending; `limit` defaults to **50** (max 500), and when more contacts matched than `limit`, `truncated: true` is set on the earliest-sorted slice — never answer "there's no contact named X" from a truncated result. One address book failing to sync never blocks the rest — it shows up in `partial_failures` instead. Matching is against a session-local cache, not a live server query (iCloud's CardDAV has no server-side filtering): the first search in a session pays for a full pull of everything visible (observed ~4.5s for 1,429 cards); later searches in the same session sync incrementally (~0.4s with no changes). Expect the first call to be slower — that's expected, not a failure to retry.
- `contacts_read({ session_id, contact_id })` → the full `Contact`.
- `contacts_create({ session_id, address_book_id?, contact })` → the created `Contact`. `address_book_id` omitted → written to the first writable address book. `contact.name` needs at least one of `full` or `family`/`given`.
- `contacts_update({ session_id, contact_id, patch, expected_etag? })` → the updated `Contact`. `patch` carries only the fields to change.
- `contacts_delete({ session_id, contact_id, expected_etag? })` → `{ deleted: true }`. Cannot be undone.

**`has_photo` is a boolean only — no tool ever returns photo bytes or a URL.** It tells you whether the contact has a `PHOTO` property set, nothing more. Do not call any contacts tool expecting image data back, and never expect base64 image content to appear in a response.

**Clearing rules on `patch` (and on `contacts_create`'s scalar fields) mirror reminders' `due`, extended to two shapes.** Scalar fields (`nickname`, `organization`, `department`, `title`, `birthday`, `note`) are three-state: omit to leave unchanged, send a string to set it, send `null` to clear it. Array fields (`emails`, `phones`, `addresses`, `urls`, `impp`) are whole-value replacement, not append: omit to leave unchanged, send the full new array to replace every existing entry, send `[]` to clear all of them. There is no operation to add or remove a single email/phone/address in place — send the complete array you want.

**`birthday` takes exactly two shapes: `1990-05-20` (`YYYY-MM-DD`) or `--05-20` (`--MM-DD`, when the year is unknown).** Anything else — a natural-language date like `next tuesday`, a year on its own, `1990/05/20` — is rejected with `INVALID_INPUT`, on both `contacts_create` and `contacts_update`. Convert whatever the user said into one of those two forms before sending it; do not pass their words through. Reading a contact back, `birthday` is absent when the stored value is not one of these shapes, and a birthday Apple stored with no year comes back as `--MM-DD` (never with a placeholder year such as 1604).

**`contact_id` and `address_book_id` are opaque strings**, exactly like every other id in this server — never parsed, constructed, or truncated; always the exact value a previous tool call returned. Same etag rule too: `expected_etag` is an optional optimistic-concurrency input, but neither id ever contains one.

## Three interface conventions

1. **All ids are opaque strings.** `session_id`, `calendar_id`, `event_id`, `list_id`, `reminder_id`, `contact_id`, `address_book_id` are not meant to be parsed, constructed, or truncated — always pass through the exact value a previous tool call returned. These are stable identifiers for the resource; they never contain a CalDAV/CardDAV etag (etags are used internally for optimistic-concurrency checks via `expected_etag`, but they never appear as, or inside, an id you handle).
2. **Calendar events are structured objects, not iCal text.** Build/read events through fields (`title`, `start`, `end`, `all_day`, `location`, `description`, `url`, `recurrence`, `alarms`), never by hand-writing `.ics`/VEVENT data. This applies to both `calendar_create_event`'s `event` and `calendar_update_event`'s `patch`.
3. **Every timestamp is ISO 8601 with an explicit offset**, e.g. `2026-09-10T14:00:00+08:00` or `...Z` for UTC. This applies to `mail_search`'s `since`/`before`, and to `calendar_list_events`'s `start`/`end`, and to event `start`/`end`, and to reminder `due`. Do not send a bare local time with no offset.

**All-day values use the calendar date in the offset you supply.** With `all_day: true` (events) or `all_day_due: true` (reminders), only the date part of the timestamp is kept, read in the offset written on that timestamp — not converted to UTC first. So `2026-09-01T00:00:00+08:00` is September 1, and so is `2026-09-01T23:00:00-05:00`; neither slides to August 31 or September 2. To make an all-day item for a given day, send that day's date with the user's own offset and any time of day.

## scope and recurrence_id, for recurring events

`calendar_update_event` and `calendar_delete_event` accept `scope`:

- `scope: 'all'` (default) — the change applies to the whole recurring series.
- `scope: 'this'` — the change applies to a single occurrence only. **`recurrence_id` is then required**, and must be the exact `recurrence_id` value from the specific occurrence object returned by `calendar_list_events` (each expanded occurrence carries its own). Editing `start` under `scope: 'this'` moves that one occurrence without touching the rest of the series or the `recurrence_id` used to look it up.

## Recurring event caveat (UTC anchoring)

Events are created UTC-anchored: there is no `timezone` parameter, so a **recurring** event's local time will drift by an hour across a daylight-saving transition, for users in a DST-observing zone. A one-off (non-recurring) event is unaffected — its ISO timestamp is already an absolute instant. If a user in a DST zone needs a recurring meeting to hold a fixed local time across a DST boundary, tell them this is a known limitation rather than silently producing a wrong time.

## Attendees on update

`calendar_update_event` patches the event in place — it does not add or remove attendees, and does not touch RSVP/invitation status. `ATTENDEE`, `ORGANIZER`, `CATEGORIES`, `STATUS`, and `X-APPLE-*` properties on the existing event are preserved untouched by any edit made through this tool.

## Error codes and recovery

Every failed call returns `{ error: { code, message, hint?, retryable } }` with `isError: true`. Recovery action per code:

| Code | Meaning | Recovery |
|---|---|---|
| `SESSION_EXPIRED` | `session_id` is invalid, unknown, or has been idle past `SESSION_TTL_MINUTES`. | *MCP:* call `apple_login` again to get a fresh `session_id`, then retry the failed call with the new id. Do this automatically — don't ask the user first. With envelope login, that new `apple_login` needs a newly generated envelope — the one you logged in with is already used. *CLI:* there is no login to redo — just run the same command again; each command builds its own session. If a resident daemon (`cli start`) held the stale one, it destroys and rebuilds its session in place and retries your call transparently, so you may never see this code at all. |
| `PERMISSION_DENIED` | Two distinct causes, told apart by `hint` — (1) the account's config has the relevant read/write capability turned off entirely (e.g. `ALLOW_CALENDAR_WRITE_1=false`, `ALLOW_REMINDERS_WRITE_1=false`, `ALLOW_CONTACTS_WRITE_1=false`), `hint` names an env var; or (2) iCloud itself refused a write on one specific calendar, reminder list, **or address book** (a shared one you can read but not write, or privilege detection guessed wrong), `hint` says to try a different id. | For (1): do not retry. Tell the user which environment variable to set to `true` (for contacts, check `ALLOW_CONTACTS_WRITE_n`) and what `hint` says to do after: for an account configured on the server, restart the server; for an envelope login, the variable is in the user's own `.env` / environment, and a new envelope must be generated and logged in with after changing it. For (2): call `calendar_list` / `reminders_lists` / `contacts_search` and retry the write against a different `calendar_id` / `list_id` / `address_book_id` — `calendar_create_event`, `reminders_create`, and `contacts_create` each already do this once automatically when the id was omitted, so seeing this error from them means every writable collection was tried. |
| `AUTH_FAILED` | iCloud rejected the App-Specific Password (IMAP/SMTP/CalDAV). | Do not retry blindly. Tell the user their App-Specific Password may be wrong/revoked; a new one must be generated at appleid.apple.com. |
| `NOT_FOUND` | The `uid`/`event_id`/`calendar_id`/`reminder_id`/`list_id`/`contact_id`/`address_book_id`/folder no longer exists (e.g. deleted elsewhere). From `reminders_list` it specifically means a `list_id` you passed matches no current list — the message names the offending id rather than quietly returning nothing. | Re-fetch the current state (`mail_search`, `calendar_list_events`, `calendar_list`, `reminders_list`, `reminders_lists`, or `contacts_search`) and use a fresh id. Do not reuse an id from before the failure. |
| `INVALID_INPUT` | Arguments are malformed — bad timestamp, missing required field, malformed id, `end` not after `start`, etc. From `apple_login` it can also mean the envelope was refused: expired (`信封已过期`), already used (`这个信封已经用过`), sealed with a different public key (`信封是用另一把公钥加密的` / `信封无法解密`), mangled in transit (`信封格式不对`), or made by an incompatible copy of the script (`信封内容不完整`); or that the server only accepts envelope login (`这台服务器只接受加密信封登录`). | Fix the argument per `message`/`hint` and retry; do not repeat the same call unchanged. Envelope expired or already used: run `node scripts/make-envelope.mjs` again and retry with the new envelope **once only**; a second refusal ends the attempt — report it. That one regeneration is shared by the expired, already-used, mangled and incompatible-script cases below: it is one retry per login in total, never one per case. Different public key: do not retry; the user must get the server's current public key from its owner and update `MCP_ENVELOPE_PUBKEY`. Mangled: the line was altered on its way to the argument (quotes added, cut short, wrapped) — regenerate and pass it exactly as printed, once. Incompatible script: regenerate once with the repository's current `scripts/make-envelope.mjs`. Envelope-only server and you have a shell with this repo: switch to envelope login; without one, report that this server needs envelope login. |
| `CONFLICT` | The event, reminder, or contact changed on the server since it was last read (etag mismatch), or `expected_etag` was stale. | Re-read it (`calendar_list_events` for an event, `reminders_list` for a reminder, `contacts_search`/`contacts_read` for a contact) to get the current state, then reapply the intended change and retry. Never resend the old `expected_etag`. |
| `RATE_LIMITED` | iCloud is throttling requests. | Wait briefly and retry; `retryable` is `true`. Do not tight-loop. |
| `UPSTREAM_ERROR` | iCloud itself is unavailable or returned an unexpected error. | If `retryable` is `true`, retry once after a short delay; otherwise report the failure to the user. |
| `INTERNAL` | Unexpected server-side failure. | Do not retry more than once. Report the failure; details are intentionally not exposed here (they're in the server's stderr log). |

## Running unattended (routines, schedules, background jobs)

Everything above assumes a person is reading your output and can answer a question. In a scheduled routine nobody is. The rules below replace, not supplement, the "tell the user" wording in the error table when you are running unattended.

**There is nobody to ask, so never wait for an answer.** If a decision would normally need confirmation, either take the safe branch and say so in your output, or stop and report. Do not proceed on a guess and do not stall.

**(MCP only) Always reach `work_done`, including on failure.** A session holds a live IMAP connection. If you abandon a run without calling it, that connection stays open until the idle TTL expires, and a routine that runs every hour with a 30-minute TTL will stack sessions. Treat it the way you would a `finally` block: whatever happened, close the session before your run ends.

**The CLI's version of that rule.** There is no `work_done` to reach — each command destroys its own session before the process exits, on the failure path too, so a run that dies halfway leaves nothing open. The one thing that *is* yours: if the run called `cli start` (the resident daemon, which holds one session across commands), it must call `cli stop` before it ends, for exactly the reason above. `cli stop` is safe to call when no daemon is running — it exits 0 and says so — so put it at the end of the run unconditionally rather than trying to remember whether you started one.

**(MCP only) One login per run.** `session_id` does not survive between runs — a routine that stored one from last time will get `SESSION_EXPIRED` on its first call. Call `apple_login` at the start of each run and `work_done` at the end of it.

**(Envelope login) A new envelope every run.** Run `node scripts/make-envelope.mjs` in each run, right before that run's `apple_login`. Never save an envelope for later and never reuse one from a previous run or an earlier step: it expires five minutes after it was made and is spent the first time the server sees it, so a reused envelope fails every time. On an expired, already-used or mangled refusal, regenerate and retry once — one retry in total, whichever refusal came first or second, not in a loop.

**(CLI) If you start a daemon, its configuration is frozen at that moment.** `cli start` snapshots the tool list, the read/write permissions and the credentials; ordinary commands re-read `.env` every time. If anything about the configuration changes mid-run, the daemon refuses to answer rather than answering from the stale snapshot, and tells you to `cli stop` and `cli start` again. Do not work around that refusal — an answer from a stale snapshot is wrong in ways that look right.

**(CLI in a Claude Routine's cloud sandbox) Mail cannot connect there — do not try it, and do not retry it.** That sandbox blocks the IMAP (993) and SMTP (587) ports, on both its restricted and its full network setting, so every `mail_*` command fails to reach iCloud — typically `UPSTREAM_ERROR` with `无法连接 iCloud 邮件服务器`. Its `retryable: true` does not apply there: a retry meets the same blocked port. Calendar, reminders and contacts go over HTTPS (443) and work normally. So in that sandbox use the `calendar_*`, `reminders_*` and `contacts_*` commands; if the task needs mail, it has to go through the remote MCP connector instead (envelope login, the middle column at the top), and if no connector is available, report that mail cannot be reached from this sandbox. It is the sandbox's network, not the credentials — do not tell the user their password is wrong.

**On the CLI there is nothing to store and nothing to reuse.** No command hands you a `session_id` and none accepts one, so the failure this rule exists to prevent cannot be written down in the first place. If a run needs several calls to share one session — and the main reason to want that is `contacts_search`, whose cache is per-session — the way to get it is `cli start` … commands … `cli stop`, not carrying an id between calls. A run that needs a fixed list of calls made in one session can also put them in an ops file and use `cli batch ops.json`, which uses a single session for the whole file.

**Writes need a guard against repeating themselves.** A routine runs again tomorrow with the same instructions. Nothing in this server deduplicates, so "create an event for the standup" run daily creates a new event daily. Before any create, search for what you are about to create and skip if it is already there. If you cannot search for it reliably, prefer reporting what you would have created over creating it.

**Failure is a report, not a retry loop.** The recovery column tells you when a retry is appropriate (`retryable: true`, `SESSION_EXPIRED` after a fresh login) and those still apply — once. Everything else ends the run with a clear statement of what failed and what a human would need to do. Repeatedly hammering a failing call across scheduled runs is how an account gets rate-limited or locked.

**Errors that need a human are the end of the run.** `AUTH_FAILED` means the App-Specific Password is dead — every later run will fail the same way, so say exactly that rather than retrying. `PERMISSION_DENIED` naming an environment variable means a configuration has to change — the server's (and a restart) for an account configured there, the routine's own environment for an envelope login; no amount of retrying inside the routine will help. In both cases, name the specific thing a person must do.

**The first `contacts_search` in a session is slow by design.** iCloud cannot filter contacts server-side, so the first call pulls everything into a session-local cache — measured at about 4.5 seconds for 1,429 contacts, with later searches in the same session around 0.4 seconds. Do not treat that first call as a hang or a timeout, and do not retry it while it is running.

**Prefer reads, and be explicit about writes.** A routine that only reads is safe to run on any schedule. A routine that writes is changing the user's real mail, calendar, reminders, or contacts on a timer they are not watching. Say in your output exactly what you changed — what was created, modified, or deleted, with the ids — so the run is auditable after the fact.

**Never print the credential file or the variables it sets.** In a sandbox the password stays out of the conversation only because nothing echoes it — `cat .env`, `env`, `echo $ICLOUD_APP_PASSWORD_1`, and printing a command that embeds it all defeat that. If you need to check whether a variable is set, test that it is non-empty; do not print its value. `node scripts/make-envelope.mjs` is the one sanctioned way to read those variables: it prints only the sealed envelope, which goes into `apple_login` and nowhere else.

That rule is worth stating as a rule because **nothing enforces it**. There is no redaction step between your shell and the transcript, no filter that recognizes an App-Specific Password on its way past, and no mechanism anywhere in this project that can un-print one. "The credentials stayed out of the conversation" is not a property the server provides you — it is only ever the accumulated result of every command you chose to run not being one that printed them. One `cat .env` in a routine that runs daily puts the password into every day's transcript from then on, and the recovery is not a code change: it is the user revoking that password at appleid.apple.com and issuing a new one.

## Not supported

iCloud Notes cannot be accessed by this server — Apple provides no standard protocol for Notes that works with an App-Specific Password. Do not attempt to read them via `mail_*` tools. Attachments cannot be downloaded (`mail_read` reports metadata only) or sent (`mail_send` has no attach parameter). Contact photos cannot be retrieved — `has_photo` only reports whether one exists.
