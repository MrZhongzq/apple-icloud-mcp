import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliDaemonFirst } from '../../../src/cli/dispatch.js';
import { startDaemon } from '../../../src/cli/daemon.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { CollectedTool } from '../../../src/cli/registry.js';
import type { SessionFactory } from '../../../src/cli/execute.js';

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
  return { tools: new Map([['apple_accounts', appleAccounts]]), calls: () => calls };
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
});
