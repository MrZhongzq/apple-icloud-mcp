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

  it('rejects a wrong-typed argument against the tool own schema, without running the handler', async () => {
    // stdio 和 HTTP 两个入口的这道检查是 MCP SDK 做的：SDK 拿 inputSchema 解析完
    // 才调 handler。CLI 直接调 handler，SDK 不在路径上——所以同一批 handler 在
    // 两个入口有前置条件、在第三个入口没有，而它们是按"有"写的。
    let ran = false;
    const typed: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string(), limit: z.number().optional() } },
      handler: async () => {
        ran = true;
        return { content: [{ type: 'text', text: '{}' }] };
      },
    };
    await expect(
      executeOnce({ config, logger, tools: toolsWith({ mail_search: typed }), sessionFactory: makeFakeSessionFactory([]) },
        { tool: 'mail_search', args: { limit: 'five' } }),
    ).rejects.toThrow(/limit/);
    expect(ran, '参数没通过校验时 handler 一次都不该被调用').toBe(false);
  });

  it('rejects an unknown argument key rather than silently dropping it', async () => {
    // 剥离而不是拒绝，就是"参数悄悄没生效"——这一阶段一直在清除的形状。
    // 上游（flags.ts 只按 schema 生成 flag、batch 的整批校验查键名）已经各挡过
    // 一次，所以这条兜底正常永远不该被触发。
    let ran = false;
    const typed: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string(), limit: z.number().optional() } },
      handler: async () => {
        ran = true;
        return { content: [{ type: 'text', text: '{}' }] };
      },
    };
    await expect(
      executeOnce({ config, logger, tools: toolsWith({ mail_search: typed }), sessionFactory: makeFakeSessionFactory([]) },
        { tool: 'mail_search', args: { limt: 5 } }),
    ).rejects.toThrow(/limt/);
    expect(ran).toBe(false);
  });

  it('validates the injected session_id too, not just what the caller passed', async () => {
    // 校验必须发生在注入**之后**：否则 session_id 会是全场唯一没人验过的字段。
    let ran = false;
    const typed: CollectedTool = {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => {
        ran = true;
        return { content: [{ type: 'text', text: '{}' }] };
      },
    };
    const badFactory = () => ({
      create: () => ({ id: 12345 as unknown as string }),
      destroy: async () => true,
    });
    await expect(
      executeOnce({ config, logger, tools: toolsWith({ mail_search: typed }), sessionFactory: badFactory },
        { tool: 'mail_search', args: {} }),
    ).rejects.toThrow(/session_id/);
    expect(ran).toBe(false);
  });

  it('passes valid arguments through unchanged', async () => {
    const tools = toolsWith();
    const res = await executeOnce({ config, logger, tools }, { tool: 'mail_search', args: { folder: 'INBOX' } });
    const got = (res.value as { got: Record<string, unknown> }).got;
    expect(Object.keys(got).sort(), '合法输入必须和从前一模一样地到达 handler').toEqual(['folder', 'session_id']);
    expect(got.folder).toBe('INBOX');
  });

  it('rejects an unknown tool name', async () => {
    await expect(
      executeOnce({ config, logger, tools: toolsWith() }, { tool: 'no_such_tool', args: {} }),
    ).rejects.toThrow();
  });
});
