import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function run() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:17733/sse"));
    const client = new Client(
        { name: "user-task-client", version: "1.0.0" },
        { capabilities: { prompts: {}, resources: {}, tools: {} } }
    );
    await client.connect(transport);
    
    console.log("=== Login ===");
    const loginResult = await client.callTool({ name: "apple_login", arguments: { email: "zzqhmbb@gmail.com" } });
    const sessionData = JSON.parse(loginResult.content[0].text as string);
    const sessionId = sessionData.sessionId;

    console.log("=== Latest Email ===");
    const mailListResult = await client.callTool({ name: "mail_list", arguments: { session_id: sessionId, limit: 3 } });
    console.log("Mail List:", mailListResult.content[0].text);

    console.log("=== Next Events ===");
    const calListResult = await client.callTool({ name: "calendar_list_events", arguments: { session_id: sessionId, start: "2026-04-26T00:00:00Z", end: "2026-12-31T23:59:59Z" } });
    console.log("Calendar Events:", calListResult.content[0].text);

    console.log("=== Create Event ===");
    const icalStr = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${Date.now()}@mcp\r\nSUMMARY:MCP Final Verification Meeting\r\nDTSTART:20260427T050000Z\r\nDTEND:20260427T060000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const createEventResult = await client.callTool({ name: "calendar_create_event", arguments: { session_id: sessionId, filename: "final_verification.ics", ical_string: icalStr } });
    console.log("Create Event Result:", createEventResult.content[0].text);

    await client.callTool({ name: "work_done", arguments: { session_id: sessionId } });
    process.exit(0);
}

run().catch(console.error);
