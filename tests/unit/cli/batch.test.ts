import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runBatch, parseBatchOps } from '../../../src/cli/batch.js';
import { createLogger } from '../../../src/core/logger.js';
import type { SessionFactory } from '../../../src/cli/execute.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import type { AppConfig } from '../../../src/core/config.js';

const logger = createLogger('error', () => {});

const config = {
  accounts: [
    {
      id: 'account_1',
      label: 'a',
      email: 'a@icloud.com',
      sender: 'a@icloud.com',
      appPassword: 'x',
      capabilities: {
        mailRead: true,
        mailWrite: false,
        calendarRead: true,
        calendarWrite: false,
        remindersRead: true,
        remindersWrite: false,
        contactsRead: true,
        contactsWrite: false,
      },
    },
  ],
  sessionTtlMs: 60_000,
  imapIdleTimeoutMs: 60_000,
  logLevel: 'error',
  deprecations: [],
  notices: [],
} as AppConfig;

const twoAccountConfig = {
  ...config,
  accounts: [config.accounts[0]!, { ...config.accounts[0]!, id: 'account_2', label: 'b', email: 'b@icloud.com', sender: 'b@icloud.com' }],
} as AppConfig;

/**
 * 每次调用都新建一套工具和一本调用记录。记录是这些测试的核心：
 * "整批先校验"这条性质只有靠"一条都没跑过"才能测出来——只断言 `rejects.toThrow()`
 * 的话，边跑边查的实现照样会抛（跑到坏的那一条时才抛），测试是绿的，性质却没了。
 */
function makeTools(): { map: Map<string, CollectedTool>; calls: string[]; sessionIds: (unknown)[] } {
  const calls: string[] = [];
  const sessionIds: unknown[] = [];

  const record = (name: string, args: unknown): void => {
    calls.push(name);
    sessionIds.push((args as { session_id?: unknown }).session_id);
  };

  const ok: CollectedTool = {
    name: 'apple_accounts',
    config: { description: 'x', inputSchema: {} },
    handler: async (args) => {
      record('apple_accounts', args);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  };
  const bad: CollectedTool = {
    name: 'mail_search',
    config: { description: 'x', inputSchema: { session_id: z.string() } },
    handler: async (args) => {
      record('mail_search', args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有' } }) }],
        isError: true,
      };
    },
  };
  const good: CollectedTool = {
    name: 'mail_folders',
    config: { description: 'x', inputSchema: { session_id: z.string() } },
    handler: async (args) => {
      record('mail_folders', args);
      return { content: [{ type: 'text', text: JSON.stringify({ folders: [] }) }] };
    },
  };
  // 真实的工具表里 apple_login / work_done 是**存在**的（registry 收集全部 25 个）——
  // 排除必须靠名字，靠"查不到"是假的保证。
  const workDone: CollectedTool = {
    name: 'work_done',
    config: { description: 'x', inputSchema: { session_id: z.string() } },
    handler: async (args) => {
      record('work_done', args);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    },
  };
  const appleLogin: CollectedTool = {
    name: 'apple_login',
    config: { description: 'x', inputSchema: { account: z.string().optional() } },
    handler: async (args) => {
      record('apple_login', args);
      return { content: [{ type: 'text', text: JSON.stringify({ session_id: 's' }) }] };
    },
  };

  return {
    map: new Map([
      ['apple_accounts', ok],
      ['mail_search', bad],
      ['mail_folders', good],
      ['work_done', workDone],
      ['apple_login', appleLogin],
    ]),
    calls,
    sessionIds,
  };
}

function makeSessionFactory(): { factory: SessionFactory; created: string[]; destroyed: string[] } {
  const created: string[] = [];
  const destroyed: string[] = [];
  let counter = 0;
  const factory: SessionFactory = () => ({
    create: () => {
      counter += 1;
      const id = `fake-session-${counter}`;
      created.push(id);
      return { id };
    },
    destroy: async (id: string) => {
      destroyed.push(id);
      return true;
    },
  });
  return { factory, created, destroyed };
}

describe('runBatch', () => {
  it('returns one outcome per operation, in order', async () => {
    const { map } = makeTools();
    const out = await runBatch({ config, logger, tools: map }, [{ tool: 'apple_accounts' }, { tool: 'apple_accounts' }]);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it('keeps going past a failure by default, and marks which one failed', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    const out = await runBatch({ config, logger, tools: map, sessionFactory: factory }, [
      { tool: 'mail_search' },
      { tool: 'apple_accounts' },
    ]);
    expect(out.map((o) => o.ok), '默认不中断——一个只读操作失败不该让后面的都不跑').toEqual([false, true]);
    expect(calls).toEqual(['mail_search', 'apple_accounts']);
  });

  it('stops at the first failure when asked', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    const out = await runBatch(
      { config, logger, tools: map, sessionFactory: factory },
      [{ tool: 'mail_search' }, { tool: 'apple_accounts' }],
      { stopOnError: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ok).toBe(false);
    expect(calls, 'stopOnError 下第二条不该被执行').toEqual(['mail_search']);
  });

  it('rejects an unknown tool in the batch before running anything', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    await expect(
      runBatch({ config, logger, tools: map, sessionFactory: factory }, [{ tool: 'apple_accounts' }, { tool: 'nope' }]),
      '整批先校验：跑了一半才发现第三条拼错了，前两条的副作用已经发生了',
    ).rejects.toThrow(/nope/);
    // 这一条才是真正把"先校验"钉住的断言：边跑边查的实现同样会抛（跑到 nope
    // 那一条时才抛），只断言 rejects.toThrow() 的话它照样是绿的。
    expect(calls, '整批校验没通过时，前面那条合法操作也一次都不该执行').toEqual([]);
  });

  it('refuses apple_login / work_done in a batch, before running anything', async () => {
    const { map, calls } = makeTools();
    const { factory, created } = makeSessionFactory();
    await expect(
      runBatch({ config, logger, tools: map, sessionFactory: factory }, [{ tool: 'apple_accounts' }, { tool: 'work_done' }]),
      'work_done 在工具表里是存在的，排除只能靠名字；漏掉它就等于把 Task 2 修好的那个 bug 从批量这条路放回来',
    ).rejects.toThrow(/work_done/);
    expect(calls, 'work_done 不该被执行，前面的合法操作也不该被执行').toEqual([]);
    expect(created, '整批被拒绝时连会话都不该建').toEqual([]);

    const second = makeTools();
    await expect(
      runBatch({ config, logger, tools: second.map, sessionFactory: makeSessionFactory().factory }, [{ tool: 'apple_login' }]),
    ).rejects.toThrow(/apple_login/);
    expect(second.calls).toEqual([]);
  });

  it('rejects args carrying session_id instead of silently overwriting it', async () => {
    const { map, calls, sessionIds } = makeTools();
    const { factory } = makeSessionFactory();
    await expect(
      runBatch({ config, logger, tools: map, sessionFactory: factory }, [
        { tool: 'mail_search', args: { session_id: 'caller-supplied' } },
      ]),
      '静默覆盖会让人以为自己传进去的 id 生效了',
    ).rejects.toThrow(/session_id/);
    expect(calls, '带 session_id 的整批一条都不该跑').toEqual([]);
    expect(sessionIds, '尤其不该"跑了但用的是别的 id"——那正是静默覆盖的形状').toEqual([]);
  });

  it('creates exactly one session for the whole batch and destroys it once', async () => {
    const { map, sessionIds } = makeTools();
    const { factory, created, destroyed } = makeSessionFactory();
    await runBatch({ config, logger, tools: map, sessionFactory: factory }, [
      { tool: 'mail_search' },
      { tool: 'apple_accounts' },
      { tool: 'mail_folders' },
    ]);
    expect(created, '批量模式存在的理由就是这个"一次"').toHaveLength(1);
    expect(destroyed).toEqual(created);
    // 不需要会话的那条不该被注入 session_id；需要的两条拿到的是同一个。
    expect(sessionIds).toEqual([created[0], undefined, created[0]]);
  });

  it('destroys the session even when an operation throws', async () => {
    const { map } = makeTools();
    const { factory, created, destroyed } = makeSessionFactory();
    map.set('mail_folders', {
      name: 'mail_folders',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => {
        throw new Error('boom');
      },
    });
    const out = await runBatch({ config, logger, tools: map, sessionFactory: factory }, [{ tool: 'mail_folders' }]);
    expect(out[0]!.ok).toBe(false);
    expect(destroyed).toEqual(created);
    expect(destroyed).toHaveLength(1);
  });

  it('creates no session at all when nothing in the batch needs one', async () => {
    const { map } = makeTools();
    const { factory, created } = makeSessionFactory();
    await runBatch({ config, logger, tools: map, sessionFactory: factory }, [{ tool: 'apple_accounts' }]);
    expect(created).toEqual([]);
  });

  it('refuses a multi-account config, the same way the one-shot path does', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    await expect(
      runBatch({ config: twoAccountConfig, logger, tools: map, sessionFactory: factory }, [{ tool: 'mail_search' }]),
    ).rejects.toThrow(/账号/);
    expect(calls).toEqual([]);

    // apple_accounts 是例外：它就是用来看配了哪些账号的。
    const only = makeTools();
    const out = await runBatch({ config: twoAccountConfig, logger, tools: only.map, sessionFactory: makeSessionFactory().factory }, [
      { tool: 'apple_accounts' },
    ]);
    expect(out.map((o) => o.ok)).toEqual([true]);
  });

  it('returns an empty result for an empty op list without touching a session', async () => {
    const { map } = makeTools();
    const { factory, created } = makeSessionFactory();
    expect(await runBatch({ config, logger, tools: map, sessionFactory: factory }, [])).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe('parseBatchOps', () => {
  it('accepts a list of operations with and without args', () => {
    expect(parseBatchOps('[{"tool":"a"},{"tool":"b","args":{"x":1}}]')).toEqual([{ tool: 'a' }, { tool: 'b', args: { x: 1 } }]);
  });

  it('rejects non-JSON, a non-array top level, and malformed entries', () => {
    expect(() => parseBatchOps('not json')).toThrow(/JSON/);
    expect(() => parseBatchOps('{"tool":"a"}')).toThrow(/数组/);
    expect(() => parseBatchOps('[1]')).toThrow(/对象/);
    expect(() => parseBatchOps('[{"args":{}}]')).toThrow(/tool/);
    expect(() => parseBatchOps('[{"tool":"a","args":[]}]')).toThrow(/args/);
    expect(() => parseBatchOps('[{"tool":"a","args":null}]')).toThrow(/args/);
  });
});
