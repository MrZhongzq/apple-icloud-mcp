import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function run() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:17733/sse"));
    const client = new Client(
        {
            name: "test-client",
            version: "1.0.0"
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {}
            }
        }
    );

    await client.connect(transport);
    console.log("Connected to MCP");

    const toolsResult = await client.listTools();
    console.log("Available tools:", toolsResult.tools.map(t => t.name));

    console.log("Attempting login...");
    const loginResult = await client.callTool({
        name: "apple_login",
        arguments: { email: "zzqhmbb@gmail.com" }
    });
    console.log("Login Result:", JSON.stringify(loginResult));

    const sessionIdStr = JSON.parse(loginResult.content[0].text as string);
    if(sessionIdStr.error) {
        console.error("Login failed:", sessionIdStr.error);
        process.exit(1);
    }
    const sessionId = sessionIdStr.sessionId;
    console.log("Session ID obtained:", sessionId);

    console.log("Attempting to send an email...");
    try {
        const sendMailResult = await client.callTool({
            name: "mail_send",
            arguments: {
                session_id: sessionId,
                to: "zzqhmbb@gmail.com",
                subject: "Test from Apple iCloud MCP",
                text: "Hello! This is a test message from your newly developed Apple iCloud MCP server. Sender works!"
            }
        });
        console.log("Send Mail Result:", JSON.stringify(sendMailResult));
    } catch (e: any) {
        console.error("Failed to send email:", e.message);
    }

    console.log("Logging out...");
    const logoutResult = await client.callTool({
        name: "work_done",
        arguments: { session_id: sessionId }
    });
    console.log("Logout Result:", JSON.stringify(logoutResult));
    
    process.exit(0);
}

run().catch(console.error);
