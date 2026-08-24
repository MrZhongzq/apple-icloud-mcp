---
name: apple-icloud-mcp-skill
description: Usage contract for AI clients calling the Apple iCloud MCP server (Mail + Calendar + Reminders over stdio).
---

# Apple iCloud MCP Server — AI Client Contract

This server exposes 20 tools for Apple iCloud Mail, Calendar, and Reminders. Read this before calling any of them.

## Workflow

1. **(Optional) `apple_accounts`** — no session needed. Lists configured accounts and their capabilities. Call this first if you don't already know which account/email to use, especially in multi-account setups.
2. **`apple_login`** — establish a session. This actually connects to IMAP and CalDAV to verify the credentials, so a bad password fails here, immediately, not later. Returns `session_id`. If there is exactly one configured account, `account` may be omitted.
3. **Do the work** — every other tool call requires the `session_id` from step 2, passed as the `session_id` argument.
4. **`work_done`** — call this once you have completely finished the user's task and no longer need iCloud access. It destroys the session and closes the underlying connections. Do not skip this at the end of a task.

## The 20 tools

### Session (no `session_id` needed for the first one)

- `apple_accounts()` → list of `{ email, label, capabilities }`.
- `apple_login({ account? })` → `{ session_id, account, label, capabilities }`. `account` is the iCloud email; omit only when a single account is configured.
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
- `calendar_list_events({ session_id, start, end, calendar_ids?, expand_recurring? })` → `{ events: CalendarEvent[], partial_failures?: { calendar_id, name, reason }[] }`, `events` sorted by start. Overlap semantics: an event starting before `start` that runs into the window is included. Recurring events expand into one entry per occurrence by default (`expand_recurring` default `true`); each occurrence carries a `recurrence_id`. `partial_failures` appears only when at least one queried calendar failed (e.g. a stale subscribed/shared calendar returning 403) — `events` still contains every successfully-read calendar's results, so tell the user which calendar(s) named in `partial_failures` are broken rather than treating the whole call as failed.
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

## Three interface conventions

1. **All ids are opaque strings.** `session_id`, `calendar_id`, `event_id`, `list_id`, `reminder_id` are not meant to be parsed, constructed, or truncated — always pass through the exact value a previous tool call returned. These are stable identifiers for the resource; they never contain a CalDAV etag (etags are used internally for optimistic-concurrency checks via `expected_etag`, but they never appear as, or inside, an id you handle).
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
| `SESSION_EXPIRED` | `session_id` is invalid, unknown, or has been idle past `SESSION_TTL_MINUTES`. | Call `apple_login` again to get a fresh `session_id`, then retry the failed call with the new id. Do this automatically — don't ask the user first. |
| `PERMISSION_DENIED` | Two distinct causes, told apart by `hint` — (1) the account's config has the relevant read/write capability turned off entirely (e.g. `ALLOW_CALENDAR_WRITE_1=false`, `ALLOW_REMINDERS_WRITE_1=false`), `hint` names an env var; or (2) iCloud itself refused a write on one specific calendar **or reminder list** (a shared one you can read but not write, or privilege detection guessed wrong), `hint` says to try a different id. | For (1): do not retry. Tell the user which environment variable to set to `true` and that the server must be restarted after. For (2): call `calendar_list` / `reminders_lists` and retry the write against a different `calendar_id` / `list_id` — `calendar_create_event` and `reminders_create` each already do this once automatically when the id was omitted, so seeing this error from them means every writable collection was tried. |
| `AUTH_FAILED` | iCloud rejected the App-Specific Password (IMAP/SMTP/CalDAV). | Do not retry blindly. Tell the user their App-Specific Password may be wrong/revoked; a new one must be generated at appleid.apple.com. |
| `NOT_FOUND` | The `uid`/`event_id`/`calendar_id`/`reminder_id`/`list_id`/folder no longer exists (e.g. deleted elsewhere). From `reminders_list` it specifically means a `list_id` you passed matches no current list — the message names the offending id rather than quietly returning nothing. | Re-fetch the current list (`mail_search`, `calendar_list_events`, `calendar_list`, `reminders_list`, or `reminders_lists`) and use a fresh id. Do not reuse an id from before the failure. |
| `INVALID_INPUT` | Arguments are malformed — bad timestamp, missing required field, malformed id, `end` not after `start`, etc. | Fix the argument per `message`/`hint` and retry; do not repeat the same call unchanged. |
| `CONFLICT` | The event or reminder changed on the server since it was last read (etag mismatch), or `expected_etag` was stale. | Re-read it (`calendar_list_events` for an event, `reminders_list` for a reminder) to get the current state, then reapply the intended change and retry. Never resend the old `expected_etag`. |
| `RATE_LIMITED` | iCloud is throttling requests. | Wait briefly and retry; `retryable` is `true`. Do not tight-loop. |
| `UPSTREAM_ERROR` | iCloud itself is unavailable or returned an unexpected error. | If `retryable` is `true`, retry once after a short delay; otherwise report the failure to the user. |
| `INTERNAL` | Unexpected server-side failure. | Do not retry more than once. Report the failure; details are intentionally not exposed here (they're in the server's stderr log). |

## Not supported

iCloud Notes cannot be accessed by this server — Apple provides no standard protocol for Notes that works with an App-Specific Password. Do not attempt to read them via `mail_*` tools. Attachments cannot be downloaded (`mail_read` reports metadata only) or sent (`mail_send` has no attach parameter). Contacts is not available in this phase.
