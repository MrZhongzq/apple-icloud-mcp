---
name: apple-icloud-mcp-skill
description: Guide for AI agents to interact with the Apple iCloud MCP Server.
---

# Apple iCloud MCP Server AI Skill

This skill documents how to properly use the Apple iCloud MCP tools to access a user's Mail and Calendar.

## Workflow

1. **Login First:** You MUST start by calling the `apple_login` tool.
   - You need to know the user's iCloud email address to login. If the user hasn't provided it, ask them, or assume they are using their primary account.
   - Example: `apple_login({ email: "example@gmail.com" })`
   - The server will validate the configuration and return a `sessionId` inside a JSON object.

2. **Include Session ID:** Every subsequent tool call (`mail_list`, `calendar_list_events`, etc.) MUST include the `session_id` returned from step 1.

3. **Log Out:** When you have completely finished all your tasks for the user and no longer need access to iCloud, you MUST call `work_done({ session_id })`. This destroys the session on the server for security.

## Tools Available

### Mail
- `mail_list(session_id, folder, limit)`: Fetches a list of recent emails (headers only). Use this to find the UID of an email.
- `mail_read(session_id, uid, folder)`: Reads the full text body and complete headers of a specific email.
- `mail_send(session_id, to, subject, text)`: Sends a new email.
- `mail_delete(session_id, uid, folder)`: Deletes an email.

### Calendar
- `calendar_list_events(session_id, start, end)`: Lists events within an ISO timestamp range (e.g. `2026-05-01T00:00:00Z`). Returns raw CalDAV objects which contain iCal `.ics` data.
- `calendar_create_event(session_id, filename, ical_string)`: Creates a new event. You MUST provide valid iCal syntax for `ical_string`.
- `calendar_update_event(session_id, calendar_url, event_url, etag, ical_string)`: Updates an event. You need the `calendar_url`, `event_url`, and `etag` obtained from `calendar_list_events`.
- `calendar_delete_event(session_id, event_url, etag)`: Deletes an event.

## Important Notes
- **Permissions:** The server administrator can disable read or write access for Mail and Calendar via environment variables. If your tool call returns a "permission denied" error, gracefully inform the user.
- **iCloud Notes:** iCloud Notes are NOT supported by this tool because Apple does not provide a standard API for them that works with App-Specific Passwords. Do not attempt to use IMAP to read Notes.
