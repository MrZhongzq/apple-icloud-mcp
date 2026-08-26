import { describe, it, expect, vi } from 'vitest';
import { executeOnce } from '../../../src/cli/execute.js';
import type { SessionFactory } from '../../../src/cli/execute.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import { z } from 'zod';

function makeFakeSessionFactory(closed: string[]): SessionFactory {
  let counter = 0;
  return () => ({
    create: () => {
      counter += 1;
      return { id: `fake-session-${counter}` };
    },
    destroy: async (id: string) => {
      closed.push(id);
      return true;
    },
  });
}

const logger = createLogger('error', () => {});

const config = {
  accounts: [
    {
      id: 'account_1', label: 'a@icloud.com', email: 'a@icloud.com', sender: 'a@icloud.com',
      appPassword: 'x',
      capabilities: {
        mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
        remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
      },
    },
  ],
  sessionTtlMs: 60_000, imapIdleTimeoutMs: 60_000, logLevel: 'error',
  deprecations: [], notices: [],
} as AppConfig;

function toolsWith(overrides: Partial<Record<string, CollectedTool>> = {}): Map<string, CollectedTool> {
  const seen: { sessionId?: unknown } = {};
  const withSession: CollectedTool = {
    name: 'mail_search',
    config: { description: 'x', inputSchema: { session_id: z.string(), folder: z.string().optional() } },
    handler: async (args) => {
      seen.sessionId = (args as { session_id?: string }).session_id;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, got: args }) }] };
    },
  };
  const noSession: CollectedTool = {
    name: 'apple_accounts',
    config: { description: 'x', inputSchema: {} },
    handler: async () => ({ content: [{ type: 'text', text: JSON.stringify([{ email: 'a@icloud.com' }]) }] }),
  };
  const map = new Map<string, CollectedTool>([
    ['mail_search', withSession],
    ['apple_accounts', noSession],
  ]);
  for (const [k, v] of Object.entries(overrides)) if (v) map.set(k, v);
  (map as unknown as { __seen: typeof seen }).__seen = seen;
  return map;
}

describe('executeOnce', () => {
  it('injects a session_id for a tool whose schema asks for one', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'mail_search', args: { folder: 'INBOX' } });
    const got = (res.value as { got: { session_id?: string; folder?: string } }).got;
    expect(got.session_id, 'schema 里有 session_id 就必须注入').toBeTruthy();
    expect(got.folder).toBe('INBOX');
  });

  it('does not invent a session for a tool that does not ask for one', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'apple_accounts', args: {} });
    expect(Array.isArray(res.value)).toBe(true);
    expect(res.isError).toBe(false);
  });

  it('unwraps the MCP content envelope', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'apple_accounts', args: {} });
    expect(res.value, 'content 信封是协议的东西，CLI 调用方不该看到').not.toHaveProperty('content');
  });

  it('reports a structured tool error without throwing', async () => {
    const failing: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'AUTH_FAILED', message: '认证失败', retryable: false } }) }],
        isError: true,
      }),
    };
    const res = await executeOnce({ config, logger, tools: toolsWith({ mail_search: failing }) },
      { tool: 'mail_search', args: {} });
    expect(res.isError).toBe(true);
    expect((res.value as { error: { code: string } }).error.code).toBe('AUTH_FAILED');
  });

  it('destroys the session even when the handler throws', async () => {
    const closed: string[] = [];
    const sessionFactory = makeFakeSessionFactory(closed);   // 记录销毁
    const throwing: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => { throw new Error('boom'); },
    };
    await expect(
      executeOnce({ config, logger, tools: toolsWith({ mail_search: throwing }), sessionFactory },
        { tool: 'mail_search', args: {} }),
    ).rejects.toThrow();
    expect(closed, 'handler 抛异常时会话仍必须销毁，否则会漏一条 IMAP 连接').toHaveLength(1);
  });

  it('rejects an unknown tool name', async () => {
    await expect(
      executeOnce({ config, logger, tools: toolsWith() }, { tool: 'no_such_tool', args: {} }),
    ).rejects.toThrow();
  });
});
