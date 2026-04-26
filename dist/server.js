import express from 'express';
import cors from 'cors';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPort } from './config.js';
import { login, logout, getSession } from './services/auth.js';
import { listEmails, readEmail, sendEmail, deleteEmail } from './services/mail.js';
import { listEvents, createEvent, updateEvent, deleteEvent } from './services/calendar.js';
const app = express();
app.use(cors());
// No app.use(express.json()) globally because SSEServerTransport might handle the body stream itself,
// but actually handlePostMessage usually needs req body?
// Let's check: in MCP express examples, standard body-parser is not used on the /message endpoint if handlePostMessage expects a raw req/res.
const server = new Server({
    name: 'apple-icloud-mcp',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
let transport = null;
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'apple_login',
                description: 'Login to an iCloud account configured in the environment variables. Must call this first to get a session_id.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        email: { type: 'string', description: 'The iCloud email address configured in the server' },
                    },
                    required: ['email'],
                },
            },
            {
                name: 'work_done',
                description: 'Destroy the current session and clear credentials from memory.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                    },
                    required: ['session_id'],
                },
            },
            // Mail Tools
            {
                name: 'mail_list',
                description: 'List recent emails from a folder.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        folder: { type: 'string', description: 'Default is INBOX' },
                        limit: { type: 'number', description: 'Default is 10' },
                    },
                    required: ['session_id'],
                },
            },
            {
                name: 'mail_read',
                description: 'Read the contents of a specific email by UID.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        uid: { type: 'number' },
                        folder: { type: 'string', description: 'Default is INBOX' },
                    },
                    required: ['session_id', 'uid'],
                },
            },
            {
                name: 'mail_send',
                description: 'Send a new email.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        to: { type: 'string' },
                        subject: { type: 'string' },
                        text: { type: 'string' },
                    },
                    required: ['session_id', 'to', 'subject', 'text'],
                },
            },
            {
                name: 'mail_delete',
                description: 'Delete an email by UID.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        uid: { type: 'number' },
                        folder: { type: 'string', description: 'Default is INBOX' },
                    },
                    required: ['session_id', 'uid'],
                },
            },
            // Calendar Tools
            {
                name: 'calendar_list_events',
                description: 'List calendar events. Optionally filter by time range.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        start: { type: 'string', description: 'ISO string format, e.g. 2026-05-01T00:00:00Z' },
                        end: { type: 'string', description: 'ISO string format, e.g. 2026-05-31T23:59:59Z' },
                    },
                    required: ['session_id'],
                },
            },
            {
                name: 'calendar_create_event',
                description: 'Create a new calendar event using iCalendar (.ics) string format.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        filename: { type: 'string', description: 'e.g. event.ics' },
                        ical_string: { type: 'string', description: 'The complete iCalendar string' },
                    },
                    required: ['session_id', 'filename', 'ical_string'],
                },
            },
            {
                name: 'calendar_update_event',
                description: 'Update an existing calendar event.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        calendar_url: { type: 'string' },
                        event_url: { type: 'string' },
                        etag: { type: 'string' },
                        ical_string: { type: 'string' },
                    },
                    required: ['session_id', 'calendar_url', 'event_url', 'etag', 'ical_string'],
                },
            },
            {
                name: 'calendar_delete_event',
                description: 'Delete an existing calendar event.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        event_url: { type: 'string' },
                        etag: { type: 'string' },
                    },
                    required: ['session_id', 'event_url', 'etag'],
                },
            },
        ],
    };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args) {
        throw new Error(`Missing arguments for tool ${name}`);
    }
    try {
        if (name === 'apple_login') {
            const res = await login(args.email);
            return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
        }
        if (name === 'work_done') {
            const success = logout(args.session_id);
            return { content: [{ type: 'text', text: JSON.stringify({ success }) }] };
        }
        // Require valid session for other tools
        const session = getSession(args.session_id);
        if (!session) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid or expired session_id. Please call apple_login first.' }) }] };
        }
        let result;
        switch (name) {
            // Mail
            case 'mail_list':
                result = await listEmails(session.account, args.folder, args.limit);
                break;
            case 'mail_read':
                result = await readEmail(session.account, args.uid, args.folder);
                break;
            case 'mail_send':
                result = await sendEmail(session.account, args.to, args.subject, args.text);
                break;
            case 'mail_delete':
                result = await deleteEmail(session.account, args.uid, args.folder);
                break;
            // Calendar
            case 'calendar_list_events':
                result = await listEvents(session.account, args.start, args.end);
                break;
            case 'calendar_create_event':
                result = await createEvent(session.account, args.ical_string, args.filename);
                break;
            case 'calendar_update_event':
                result = await updateEvent(session.account, args.calendar_url, args.event_url, args.ical_string, args.etag);
                break;
            case 'calendar_delete_event':
                result = await deleteEvent(session.account, args.event_url, args.etag);
                break;
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error.message || String(error) }) }], isError: true };
    }
});
app.get('/sse', async (req, res) => {
    transport = new SSEServerTransport('/message', res);
    await server.connect(transport);
    res.on('close', () => {
        // Handle cleanup if necessary
    });
});
app.post('/message', async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    }
    else {
        res.status(503).send('SSE not initialized');
    }
});
const startServer = () => {
    const port = getPort();
    const certPath = process.env.SSL_CERT;
    const keyPath = process.env.SSL_KEY;
    let httpServer;
    if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const options = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
        };
        httpServer = https.createServer(options, app);
        console.log('Starting with HTTPS support');
    }
    else {
        httpServer = http.createServer(app);
        console.log('Starting with HTTP support');
    }
    httpServer.listen(port, () => {
        console.log(`Apple iCloud MCP Server listening on port ${port}`);
        console.log(`SSE Endpoint: http(s)://localhost:${port}/sse`);
    });
};
startServer();
