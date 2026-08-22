import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { registerMailTools } from '../../../src/modules/mail/tools.js';
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
  get: vi.fn().mockReturnValue({
    id: 's1',
    account: { id: 'account_1', email: 'me@icloud.com' },
    providers: {},
  }),
} as unknown as SessionStore;

/** 工具层通过注入的工厂拿到 service，因此这里可以直接塞一个假的。 */
function depsWith(service: Record<string, unknown>) {
  return {
    sessions: fakeSessions,
    logger: silentLogger,
    mailFor: () => service as never,
  };
}

describe('registerMailTools', () => {
  it('registers every mail tool', () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({}));
    expect([...tools.keys()].sort()).toEqual([
      'mail_delete',
      'mail_folders',
      'mail_mark',
      'mail_move',
      'mail_read',
      'mail_search',
      'mail_send',
    ]);
  });

  it('marks read-only tools and destructive tools with the right annotations', () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({}));
    expect(tools.get('mail_search')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('mail_delete')!.config.annotations?.destructiveHint).toBe(true);
    expect(tools.get('mail_send')!.config.annotations?.destructiveHint).toBe(false);
  });

  it('requires session_id in every schema', () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({}));
    for (const [name, tool] of tools) {
      const shape = tool.config.inputSchema as Record<string, z.ZodTypeAny>;
      expect(shape.session_id, `${name} 缺少 session_id`).toBeDefined();
    }
  });

  it('returns the service result as JSON text', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockResolvedValue({ messages: [{ uid: 1 }] });
    registerMailTools(server, depsWith({ search }));

    const result = await tools.get('mail_search')!.handler({ session_id: 's1', limit: 5 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ messages: [{ uid: 1 }] });
    expect(search).toHaveBeenCalledWith({ folder: undefined, query: undefined, limit: 5, cursor: undefined });
  });

  it('converts an AppError into a structured error payload', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockRejectedValue(
      new AppError('PERMISSION_DENIED', '读权限未开启', { hint: '设置 ALLOW_MAIL_READ_1=true' }),
    );
    registerMailTools(server, depsWith({ search }));

    const result = await tools.get('mail_search')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('PERMISSION_DENIED');
    expect(payload.error.hint).toContain('ALLOW_MAIL_READ_1');
  });

  it('hides internal failures behind a generic message', async () => {
    const { server, tools } = collect();
    const search = vi.fn().mockRejectedValue(new Error('imap socket died: pass=abcd-efgh'));
    registerMailTools(server, depsWith({ search }));

    const result = await tools.get('mail_search')!.handler({ session_id: 's1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('abcd-efgh');
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('INTERNAL');
  });

  it('never writes a raw error message to the log', async () => {
    const lines: string[] = [];
    const captureLogger = createLogger('warn', (l) => lines.push(l));
    const { server, tools } = collect();
    const search = vi.fn().mockRejectedValue(new Error('imap socket died: pass=abcd-efgh'));
    registerMailTools(server, { ...depsWith({ search }), logger: captureLogger });

    await tools.get('mail_search')!.handler({ session_id: 's1' });

    expect(lines.join('\n')).not.toContain('abcd-efgh');
    expect(lines.join('\n')).toContain('"detail":"Error"');
  });

  it('rejects a malformed date in the search query', async () => {
    const { server, tools } = collect();
    registerMailTools(server, depsWith({ search: vi.fn() }));

    const result = await tools.get('mail_search')!.handler({
      session_id: 's1',
      query: { since: 'yesterday' },
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe('INVALID_INPUT');
    expect(payload.error.hint).toContain('ISO 8601');
  });
});
