import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerCalendarTools } from '../../../src/modules/calendar/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ToolConfig, ToolResult } from '../../../src/server/types.js';
import type { SessionStore } from '../../../src/core/session.js';

interface Registered {
  config: ToolConfig;
  handler: (args: any) => Promise<ToolResult>;
}

function collect(): { server: any; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: (args: any) => Promise<ToolResult>) {
      tools.set(name, { config, handler });
    },
  };
  return { server, tools };
}

const silentLogger = createLogger('error', () => {});
const fakeSessions = {
  get: vi.fn().mockReturnValue({ id: 's1', account: { id: 'account_1' }, providers: {} }),
} as unknown as SessionStore;

function depsWith(service: Record<string, unknown>) {
  return { sessions: fakeSessions, logger: silentLogger, calendarFor: () => service as never };
}

describe('registerCalendarTools', () => {
  it('registers every calendar tool', () => {
    const { server, tools } = collect();
    registerCalendarTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'calendar_create_event',
      'calendar_delete_event',
      'calendar_list',
      'calendar_list_events',
      'calendar_update_event',
    ]);
  });

  it('marks deletion as destructive and listing as read-only', () => {
    const { server, tools } = collect();
    registerCalendarTools(server, depsWith({}));
    expect(tools.get('calendar_delete_event')!.config.annotations?.destructiveHint).toBe(true);
    expect(tools.get('calendar_list_events')!.config.annotations?.readOnlyHint).toBe(true);
  });

  it('does not expose calendar_url or etag as required inputs', () => {
    const { server, tools } = collect();
    registerCalendarTools(server, depsWith({}));
    const shape = tools.get('calendar_update_event')!.config.inputSchema as Record<string, z.ZodTypeAny>;
    expect(shape.calendar_url).toBeUndefined();
    expect(shape.event_id).toBeDefined();
    expect(shape.expected_etag!.isOptional()).toBe(true);
  });

  it('passes the structured event object straight through', async () => {
    const { server, tools } = collect();
    const createEvent = vi.fn().mockResolvedValue({ event_id: 'e1', title: '新会议' });
    registerCalendarTools(server, depsWith({ createEvent }));

    const result = await tools.get('calendar_create_event')!.handler({
      session_id: 's1',
      event: { title: '新会议', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
    });

    expect(createEvent).toHaveBeenCalledWith(
      { title: '新会议', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
      undefined,
    );
    expect(JSON.parse(result.content[0]!.text).title).toBe('新会议');
  });

  it('forwards scope and recurrence_id when updating', async () => {
    const { server, tools } = collect();
    const updateEvent = vi.fn().mockResolvedValue({ event_id: 'e1' });
    registerCalendarTools(server, depsWith({ updateEvent }));

    await tools.get('calendar_update_event')!.handler({
      session_id: 's1',
      event_id: 'e1',
      patch: { title: '改了' },
      scope: 'this',
      recurrence_id: '2026-08-17T09:00:00.000Z',
    });

    expect(updateEvent).toHaveBeenCalledWith(
      'e1',
      { title: '改了' },
      { expected_etag: undefined, scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' },
    );
  });
});
