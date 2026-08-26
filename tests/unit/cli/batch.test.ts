import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runBatch, parseBatchOps } from '../../../src/cli/batch.js';
import { createLogger } from '../../../src/core/logger.js';
import type { SessionFactory } from '../../../src/cli/execute.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { Logger } from '../../../src/core/logger.js';

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

  // 这条测的**不是** finally：handler 抛出的异常被 runBatch 内层的 try/catch
  // 收成了一个 ok:false 的 outcome，什么都没逃出外层 try，所以把 finally 换成
  // 顺序执行的 destroy 之后它照样是绿的（已实测）。它真正钉住的是"某条操作失败了
  // 也照样销毁会话"——名字按这个来写，不按 finally 来写。名不副实的测试比没有
  // 测试更糟：它正是"这条性质已经有人测了"这个错觉的来源。
  it('destroys the session even when an operation fails', async () => {
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

  // 这条才测 finally：让异常真的逃出 runBatch。内层 catch 里第一件事是
  // `logger.warn`，所以一个会抛的 logger 能把异常从 catch 里再顶出去——这是
  // 当前代码结构下唯一一条能绕过内层 catch 的路径。把 finally 换成"try 块之后
  // 顺序 destroy"，这条会红：异常向上传播，那句顺序 destroy 永远执行不到，
  // 一条 IMAP 连接就此留到进程退出。
  it('destroys the session when an exception escapes the loop entirely (the finally)', async () => {
    const { map } = makeTools();
    const { factory, created, destroyed } = makeSessionFactory();
    const throwingLogger: Logger = {
      error: () => {},
      warn: () => {
        throw new Error('日志本身炸了');
      },
      info: () => {},
      debug: () => {},
    };
    map.set('mail_folders', {
      name: 'mail_folders',
      config: { description: 'x', inputSchema: { session_id: z.string() } },
      handler: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      runBatch({ config, logger: throwingLogger, tools: map, sessionFactory: factory }, [{ tool: 'mail_folders' }]),
    ).rejects.toThrow(/日志本身炸了/);
    expect(created).toHaveLength(1);
    expect(destroyed, '异常穿过整个循环时，会话仍然必须被销毁——这就是 finally 存在的理由').toEqual(created);
  });

  it('creates no session at all when nothing in the batch needs one', async () => {
    const { map } = makeTools();
    const { factory, created } = makeSessionFactory();
    await runBatch({ config, logger, tools: map, sessionFactory: factory }, [{ tool: 'apple_accounts' }]);
    expect(created).toEqual([]);
  });

  it('refuses a multi-account config with the CLI refusal text, not the one findAccount would produce', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    // 断言必须钉在**只有这条 guard 会产生**的文字上。早先这里写的是 /账号/，
    // 而删掉 guard 之后 `findAccount` 会抛「配置了多个账号，必须指定 account」——
    // 同样含「账号」、同样在任何 handler 跑起来之前抛，两条断言都被变异体满足，
    // 测试全绿。两段文案的区别不是措辞：guard 给的是可执行的下一步（拆 .env、
    // 用 apple_accounts 看有哪些账号），findAccount 给的是「指定 account」——
    // 而 account 这个参数命令行根本不接受，照着做是做不到的。
    await expect(
      runBatch({ config: twoAccountConfig, logger, tools: map, sessionFactory: factory }, [{ tool: 'mail_search' }]),
    ).rejects.toThrow(/把不同账号拆分到各自的 \.env 文件里/);
    // 顺带钉住它确实把配了哪些账号列了出来——那是这段文案有用的另一半。
    await expect(
      runBatch({ config: twoAccountConfig, logger, tools: makeTools().map, sessionFactory: makeSessionFactory().factory }, [
        { tool: 'mail_search' },
      ]),
    ).rejects.toThrow(/已配置 2 个账号（a、b）/);
    expect(calls).toEqual([]);

    // apple_accounts 是例外：它就是用来看配了哪些账号的。
    const only = makeTools();
    const out = await runBatch({ config: twoAccountConfig, logger, tools: only.map, sessionFactory: makeSessionFactory().factory }, [
      { tool: 'apple_accounts' },
    ]);
    expect(out.map((o) => o.ok)).toEqual([true]);
  });

  it('rejects an args key the tool does not have, before running anything', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    // 命令行这条路上没有任何一层会做这件事：MCP SDK 的 zod 校验在 SDK 那一层，
    // 而 CLI 直接调收集到的 handler。少了这条检查，`limt` 会被静默当成"没传 limit"，
    // 操作照跑、退出码 0，调用方拿回的是 20 条而不是他要的 5 条。
    await expect(
      runBatch({ config, logger, tools: map, sessionFactory: factory }, [{ tool: 'mail_folders', args: { limt: 5 } }]),
    ).rejects.toThrow(/limt/);
    expect(calls, '拼错参数名的整批一条都不该跑').toEqual([]);

    // 合法的参数名当然要放行——否则上面那条断言可以靠"全部拒绝"作弊满足。
    const okRun = makeTools();
    const out = await runBatch({ config, logger, tools: okRun.map, sessionFactory: makeSessionFactory().factory }, [
      { tool: 'mail_folders' },
    ]);
    expect(out.map((o) => o.ok)).toEqual([true]);
  });

  it('rejects a wrong-typed args value up front, before any op runs', async () => {
    const { map, calls } = makeTools();
    const { factory } = makeSessionFactory();
    map.set('mail_search', {
      name: 'mail_search',
      config: { description: 'x', inputSchema: { session_id: z.string(), limit: z.number().optional() } },
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
    // 值的类型校验和工具名校验是同一条规则的两半：第三条的类型错误不能等前两条
    // 真的执行完才被发现。而且这是**抛出去**（退出码 1，工具没跑），不是变成
    // 一条 ok:false 的 outcome（退出码 2，那是 iCloud 的回答）。
    await expect(
      runBatch({ config, logger, tools: map, sessionFactory: factory }, [
        { tool: 'apple_accounts' },
        { tool: 'mail_search', args: { limit: 'five' } },
      ]),
    ).rejects.toThrow(/limit/);
    expect(calls, '整批带类型错误时，前面那条合法操作也一次都不该执行').toEqual([]);
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

  it('rejects a key that is neither tool nor args', () => {
    // `arg` 少一个 s：实测过的形状——整条操作会变成"不带任何参数调用这个工具"，
    // 照常执行、照常返回一个像模像样的 iCloud 错误，退出码 2，而文档告诉操作者
    // 退出码 2 的意思是"命令跑通了，iCloud 那边这么回答"，正好是错误的诊断。
    expect(() => parseBatchOps('[{"tool":"mail_folders","arg":{"x":1}}]')).toThrow(/arg/);
    expect(() => parseBatchOps('[{"tool":"a","comment":"给人看的注释"}]')).toThrow(/comment/);
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
