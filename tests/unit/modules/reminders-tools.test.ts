import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerReminderTools } from '../../../src/modules/reminders/tools.js';
import { createLogger } from '../../../src/core/logger.js';
import { AppError } from '../../../src/core/errors.js';
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
  return { sessions: fakeSessions, logger: silentLogger, reminderFor: () => service as never };
}

describe('registerReminderTools', () => {
  it('registers every reminder tool', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'reminders_create',
      'reminders_delete',
      'reminders_list',
      'reminders_lists',
      'reminders_update',
    ]);
  });

  it('carries the specified annotations', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    expect(tools.get('reminders_lists')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('reminders_list')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('reminders_create')!.config.annotations?.destructiveHint).toBe(false);
    expect(tools.get('reminders_update')!.config.annotations?.idempotentHint).toBe(true);
    expect(tools.get('reminders_delete')!.config.annotations?.destructiveHint).toBe(true);
  });

  it('requires session_id in every schema', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    for (const [name, tool] of tools) {
      const shape = tool.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.session_id, `${name} 缺少 session_id`).toBeDefined();
    }
  });

  it('never exposes an etag as a required input', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    for (const name of ['reminders_update', 'reminders_delete']) {
      const shape = tools.get(name)!.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.expected_etag!.isOptional()).toBe(true);
    }
  });

  it('documents that a lower priority number means higher priority', () => {
    const { server, tools } = collect();
    registerReminderTools(server, depsWith({}));
    const shape = tools.get('reminders_create')!.config.inputSchema as Record<string, z.ZodTypeAny>;
    const described = shape.priority!.description ?? '';
    expect(described).toMatch(/1/);
    expect(described).toMatch(/9/);
  });

  it('forwards the list query verbatim', async () => {
    const { server, tools } = collect();
    const list = vi.fn().mockResolvedValue({ reminders: [] });
    registerReminderTools(server, depsWith({ list }));

    await tools.get('reminders_list')!.handler({
      session_id: 's1',
      list_ids: ['abc'],
      completed: false,
      due_before: '2026-09-01T00:00:00Z',
      limit: 50,
    });

    expect(list).toHaveBeenCalledWith({
      list_ids: ['abc'],
      completed: false,
      due_before: '2026-09-01T00:00:00Z',
      due_after: undefined,
      limit: 50,
    });
  });

  it('passes the session through when listing lists', async () => {
    const { server, tools } = collect();
    const listLists = vi.fn().mockResolvedValue([{ list_id: 'l1', name: '提醒', writable: true }]);
    registerReminderTools(server, depsWith({ listLists }));

    const result = await tools.get('reminders_lists')!.handler({ session_id: 's1' });
    expect(listLists).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0]!.text)[0].name).toBe('提醒');
  });

  it('forwards the reminder object and list_id on create', async () => {
    const { server, tools } = collect();
    const create = vi.fn().mockResolvedValue({ reminder_id: 'r1', title: '新待办' });
    registerReminderTools(server, depsWith({ create }));

    await tools.get('reminders_create')!.handler({
      session_id: 's1',
      list_id: 'l1',
      reminder: { title: '新待办', due: '2026-09-10T02:00:00Z', priority: 1 },
    });

    expect(create).toHaveBeenCalledWith(
      { title: '新待办', due: '2026-09-10T02:00:00Z', priority: 1 },
      'l1',
    );
  });

  it('forwards patch and expected_etag on update', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ reminder_id: 'r1' });
    registerReminderTools(server, depsWith({ update }));

    await tools.get('reminders_update')!.handler({
      session_id: 's1',
      reminder_id: 'r1',
      patch: { completed: true },
      expected_etag: 'e1',
    });

    expect(update).toHaveBeenCalledWith('r1', { completed: true }, { expected_etag: 'e1' });
  });

  it('accepts a null due as an explicit clear', async () => {
    const { server, tools } = collect();
    const update = vi.fn().mockResolvedValue({ reminder_id: 'r1' });
    registerReminderTools(server, depsWith({ update }));

    const result = await tools.get('reminders_update')!.handler({
      session_id: 's1',
      reminder_id: 'r1',
      patch: { due: null },
    });

    expect(result.isError).toBeUndefined();
    expect(update).toHaveBeenCalledWith('r1', { due: null }, { expected_etag: undefined });
  });

  it('forwards the id and expected_etag on delete', async () => {
    const { server, tools } = collect();
    const remove = vi.fn().mockResolvedValue({ deleted: true });
    registerReminderTools(server, depsWith({ remove }));

    await tools.get('reminders_delete')!.handler({
      session_id: 's1',
      reminder_id: 'r1',
      expected_etag: 'e1',
    });

    expect(remove).toHaveBeenCalledWith('r1', { expected_etag: 'e1' });
  });

  it('converts an AppError into a structured payload', async () => {
    const { server, tools } = collect();
    const list = vi.fn().mockRejectedValue(
      new AppError('PERMISSION_DENIED', '提醒读取权限未开启', { hint: '设置 ALLOW_REMINDERS_READ_1=true' }),
    );
    registerReminderTools(server, depsWith({ list }));

    const result = await tools.get('reminders_list')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_REMINDERS_READ_1');
  });
});
