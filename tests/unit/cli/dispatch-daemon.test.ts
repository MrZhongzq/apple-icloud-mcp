import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliDaemonFirst } from '../../../src/cli/dispatch.js';
import { startDaemon } from '../../../src/cli/daemon.js';
import { writeEndpoint } from '../../../src/cli/transport.js';
import net from 'node:net';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import type { SessionFactory } from '../../../src/cli/execute.js';
import { z } from 'zod';

/**
 * "先试守护进程、连不上再退回一次性模式" 是 daemon 存在的全部意义——省下的是
 * 每条命令都要重做的 TCP+TLS+AUTH 握手。这条分派顺序写反了（先走一次性、
 * daemon 只是顺便试试）没有任何可见症状：命令照样能跑通、输出照样正确，
 * 唯一的差别是每次都在悄悄重新握手登录。
 *
 * 探针：`deps.tools` 里塞一个我们自己控制、会计数并返回可辨识数据的假
 * `apple_accounts` handler。daemon 真的在跑时，daemon 内部有自己独立建的
 * 一份真实工具表（`daemon.ts` 自己调 `collectTools`），请求应该完全由它
 * 应答——本地这个假 handler 绝不该被调用、它返回的数据也绝不该出现在结果里。
 * 只有退回一次性模式（`executeOnce`）才会真正调用 `deps.tools` 里的这个假
 * handler。两条路径返回的数据刻意不同，一眼就能看出走的是哪一条。
 */
const logger = createLogger('error', () => {});

const REAL_ACCOUNT = {
  id: 'account_1',
  label: 'a@icloud.com',
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
};

const config: AppConfig = {
  accounts: [REAL_ACCOUNT],
  sessionTtlMs: 60_000,
  imapIdleTimeoutMs: 60_000,
  logLevel: 'error',
  deprecations: [],
  notices: [],
};

function fakeSessionFactory(): SessionFactory {
  return () => ({
    create: () => ({ id: 'unused-in-this-test' }),
    destroy: async () => true,
  });
}

/** 本地（一次性模式）才会用到的假工具表：`apple_accounts` 的 handler 是我们自己的探针。 */
function localToolsWithProbe(): { tools: Map<string, CollectedTool>; calls: () => number } {
  let calls = 0;
  const appleAccounts: CollectedTool = {
    name: 'apple_accounts',
    config: { description: 'x', inputSchema: {} },
    handler: async () => {
      calls += 1;
      return { content: [{ type: 'text', text: JSON.stringify([{ email: 'local-fallback@icloud.com' }]) }] };
    },
  };
  // 本地这份 mail_search 的 schema 只需要宽松到能让 flags.ts 把 --query 解析成
  // 一块 JSON；真正做类型校验的是 daemon 自己那份真实 schema（query.unseen 是
  // boolean）。两份故意不同，这条测试测的就是"daemon 那边会不会校验"。
  const mailSearch: CollectedTool = {
    handler: async () => ({ content: [{ type: 'text', text: JSON.stringify({ messages: [] }) }] }),
    name: 'mail_search',
    config: {
      description: 'x',
      inputSchema: { session_id: z.string(), query: z.object({ unseen: z.unknown().optional() }).optional() },
    },
  };
  return {
    tools: new Map([
      ['apple_accounts', appleAccounts],
      ['mail_search', mailSearch],
    ]),
    calls: () => calls,
  };
}

let dir: string;
let files: { infoPath: string; socketPath: string };
let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-dd-'));
  files = { infoPath: join(dir, 'endpoint.json'), socketPath: join(dir, 'cli.sock') };
  handle = undefined;
});
afterEach(async () => {
  await handle?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('runCliDaemonFirst', () => {
  it('serves the call from a live daemon and never falls through to the local handler', async () => {
    handle = await startDaemon({ config, logger, files });

    const { tools, calls } = localToolsWithProbe();
    const outcome = await runCliDaemonFirst(
      { config, logger, tools, sessionFactory: fakeSessionFactory(), files },
      ['apple_accounts'],
    );

    expect(outcome.exitCode).toBe(0);
    const value = JSON.parse(outcome.stdout) as Array<{ email: string }>;
    expect(value[0]?.email, '结果必须来自 daemon 的真实账号数据，不是本地的一次性 fallback').toBe('a@icloud.com');
    expect(calls(), '守护进程在跑时，本地一次性 handler 绝不该被调用——那正是常驻模式本该省掉的握手').toBe(0);
  });

  it('a schema violation served by the daemon exits 1, not 2 — the tool never ran', async () => {
    // 参数校验是 MCP SDK 在另外两个入口替 handler 做的前置条件；CLI 直接调
    // handler，所以这条检查现在在 invokeTool 里，而 daemon 也必须走那里。
    // 退出码必须是 1（用法错误，工具没跑），不是 2（iCloud 的回答）——否则同一条
    // 写错参数的命令会因为"有没有跑过 cli start"落在两个不同的退出码上，而脚本
    // 正是按退出码分支的。
    handle = await startDaemon({ config, logger, files });

    const { tools, calls } = localToolsWithProbe();
    const outcome = await runCliDaemonFirst({ config, logger, tools, sessionFactory: fakeSessionFactory(), files }, [
      'mail_search',
      '--query',
      '{"unseen":"yes"}',
    ]);

    expect(outcome.exitCode, 'daemon 那边参数没过校验 → 用法错误 → 1').toBe(1);
    expect(outcome.stdout, '工具没跑，stdout 上不该有结果').toBe('');
    expect(outcome.stderr).toContain('unseen');
    expect(calls(), '不能因为一次用法错误就落回一次性模式重跑一遍').toBe(0);
  });

  it('falls back to the local one-shot handler when no daemon is reachable', async () => {
    // 不启动 daemon：files 指向的端点文件不存在，callDaemon 必须返回 undefined。
    const { tools, calls } = localToolsWithProbe();
    const outcome = await runCliDaemonFirst(
      { config, logger, tools, sessionFactory: fakeSessionFactory(), files },
      ['apple_accounts'],
    );

    expect(outcome.exitCode).toBe(0);
    const value = JSON.parse(outcome.stdout) as Array<{ email: string }>;
    expect(value[0]?.email).toBe('local-fallback@icloud.com');
    expect(calls(), '没有 daemon 可用时必须退回一次性模式').toBe(1);
  });

  it('never retries one-shot when the daemon rejects the request (F-4 boundary, half 1: rejected)', async () => {
    // 这是整轮里最关键的一条规则：请求字节一旦写给了 daemon，不管 daemon
    // 给的回应是"明确拒绝"（这里用的）还是"没能确认"，runCliDaemonFirst
    // 都绝不能把它当成"daemon 不可用"落到本地一次性模式重跑一遍——对
    // mail_send 这类写操作，重试意味着用户会收到两封信。
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') throw new Error('forceTcp should force tcp mode');

    // 单独一份端点文件，端口是真的（daemon 真的在监听），令牌是错的——请求
    // 字节确实发出去了，daemon 会在调用任何工具之前就用一句明确的拒绝把
    // 它挡下来。
    const staleFiles = { infoPath: join(dir, 'stale-endpoint.json'), socketPath: join(dir, 'stale.sock') };
    await writeEndpoint(staleFiles, { kind: 'tcp', port: handle.endpoint.port, token: 'stale-token' });

    const { tools, calls } = localToolsWithProbe();
    const outcome = await runCliDaemonFirst(
      { config, logger, tools, sessionFactory: fakeSessionFactory(), files: staleFiles },
      ['apple_accounts'],
    );

    expect(outcome.exitCode, '请求字节已经写出去之后的失败必须报错给用户，不能悄悄伪装成一次成功').toBe(1);
    expect(calls(), '一旦字节写出去，绝不能落到一次性模式重跑一遍').toBe(0);  });

  it('never retries one-shot when the daemon never answers after the write (F-4 boundary, half 2: sent-unknown)', async () => {
    // 这才是这条规则存在的真正理由：上面那一条只驱动了 rejected 那半边——
    // 一个令牌不对的竞态，只在 daemon 刚重启换了新令牌时才会发生。sent-unknown
    // 才是 daemon 死掉或被 kill 在处理中途会产生的那种——真实世界里会真正发生的
    // "mail_send 发两遍" 场景，而上面那条测试对它完全无能为力——
    // 先前的实现确实对 AUTH_FAILED 报错，却对 sent-unknown 静静回退一次性重跑，
    // 一样能让这个套件全绿。
    //
    // 接受连接、读数据、永不回应——模拟一个在处理中途挂掉的 daemon。
    const sockets = new Set<net.Socket>();
    const srv = net.createServer((s) => {
      sockets.add(s);
      s.on('data', () => undefined);
      s.on('close', () => sockets.delete(s));
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    try {
      const hangingFiles = { infoPath: join(dir, 'hanging-endpoint.json'), socketPath: join(dir, 'hanging.sock') };
      await writeEndpoint(hangingFiles, { kind: 'tcp', port, token: 'irrelevant-token' });

      const { tools, calls } = localToolsWithProbe();
      // 注入一个很短的 roundTripMs，不用真的等“永远——这正是
      // 生产路径的行为（见 N-3），测试只需要证明“字节写出去之后失败不会
      // 重跑”这个属性，不需要真的等到无限长。
      const outcome = await runCliDaemonFirst(
        { config, logger, tools, sessionFactory: fakeSessionFactory(), files: hangingFiles, timeouts: { roundTripMs: 200 } },
        ['apple_accounts'],
      );

      expect(outcome.exitCode, 'daemon 没有回应也必须报错，不能悠悠伪装成一次成功').toBe(1);
      expect(
        calls(),
        'daemon 没有回应时它到底执行过没有都不确定——绝不能因此落到一次性模式重跑一遍',
      ).toBe(0);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});