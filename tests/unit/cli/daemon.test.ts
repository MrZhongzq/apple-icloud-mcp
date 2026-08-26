import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { startDaemon } from '../../../src/cli/daemon.js';
import { callDaemon, stopDaemon, waitForDaemonReady } from '../../../src/cli/client.js';
import { writeEndpoint } from '../../../src/cli/transport.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';

const logger = createLogger('error', () => {});
const config = {
  accounts: [{
    id: 'account_1', label: 'a@icloud.com', email: 'a@icloud.com', sender: 'a@icloud.com', appPassword: 'x',
    capabilities: {
      mailRead: true, mailWrite: false, calendarRead: true, calendarWrite: false,
      remindersRead: true, remindersWrite: false, contactsRead: true, contactsWrite: false,
    },
  }],
  sessionTtlMs: 60_000, imapIdleTimeoutMs: 60_000, logLevel: 'error', deprecations: [], notices: [],
} as AppConfig;

/**
 * 三种互斥结果，不是两种：一次 TCP 探测要么被拒绝（收到空响应或连接被直接
 * 断开）、要么被正常服务（拿到一个带 email 字段的响应）、要么两秒内什么都
 * 没发生（daemon 挂住了、根本没回应）。此前用一个布尔值把"拒绝"和"挂住"
 * 揉成同一个 true——一个从不回应的 daemon 会让两条令牌测试全部"通过"，
 * 而且是通过了错误的理由：慢，不是拒绝。命名这三种结果，一个连接被正常
 * 服务时会明确得到 'served' 而不是含糊地也算作"防住了"，测试因此才能真的
 * 分辨"daemon 正确拒绝了它"和"daemon 没鸟它"。
 */
type TcpOutcome = 'rejected' | 'served' | 'hung';

function probeTcp(port: number, payload: Record<string, unknown>): Promise<TcpOutcome> {
  return new Promise<TcpOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: TcpOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(JSON.stringify(payload) + String.fromCharCode(10));
    });
    let got = '';
    c.on('data', (d) => {
      got += String(d);
    });
    c.on('error', () => done('rejected'));
    c.on('close', () => done(got.trim().length === 0 ? 'rejected' : 'served'));
    setTimeout(() => {
      c.destroy();
      done('hung');
    }, 2000);
  });
}

let dir: string;
let files: { infoPath: string; socketPath: string };
let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-d-'));
  files = { infoPath: join(dir, 'endpoint.json'), socketPath: join(dir, 'cli.sock') };
  handle = undefined;
});
afterEach(async () => {
  await handle?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('daemon lifecycle', () => {
  it('starts, serves a call, and stops', async () => {
    handle = await startDaemon({ config, logger, files });
    const res = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(res, '守护进程在跑时不该退回一次性模式').toBeDefined();
    expect(Array.isArray(res!.value)).toBe(true);
    expect(await stopDaemon(files)).toBe(true);
  });

  it('serves several calls over one session', async () => {
    handle = await startDaemon({ config, logger, files });
    const a = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    const b = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it('reports a tool error without killing the daemon', async () => {
    handle = await startDaemon({ config, logger, files });
    const bad = await callDaemon({ tool: 'no_such_tool', args: {} }, files);
    expect(bad?.isError, '未知工具应当作为一次失败的调用返回，而不是打死守护进程').toBe(true);
    const after = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(after, '一次坏调用之后守护进程必须还活着').toBeDefined();
  });
});

describe('daemon access control', () => {
  it.skipIf(process.platform === 'win32')(
    'chmods the unix socket to 0600 — the default is world-accessible',
    async () => {
      handle = await startDaemon({ config, logger, files });
      if (handle.endpoint.kind !== 'unix') {
        // TCP 模式下这条不适用；令牌那条测试覆盖它
        return;
      }
      const mode = statSync(handle.endpoint.path).mode & 0o777;
      expect(mode, 'Node 建出来默认是 755/775，谁都能连；那后面挂着一个已登录的 iCloud 会话').toBe(0o600);
    },
  );

  it('refuses a tcp connection that presents no token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') return;
    const outcome = await probeTcp(handle.endpoint.port, { tool: 'apple_accounts', args: {} });
    expect(outcome, 'TCP 路径没有文件权限可依赖，令牌是唯一的门；"hung" 和 "served" 都是失败').toBe(
      'rejected',
    );
  });

  it('refuses a tcp connection presenting the wrong token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') return;
    const outcome = await probeTcp(handle.endpoint.port, {
      token: 'wrong-token',
      tool: 'apple_accounts',
      args: {},
    });
    expect(outcome).toBe('rejected');
  });
});

describe('client fallback', () => {
  it('returns undefined when no daemon is running', async () => {
    expect(await callDaemon({ tool: 'apple_accounts', args: {} }, files)).toBeUndefined();
  });

  it('clears a stale endpoint file instead of timing out on every call', async () => {
    const { writeFileSync, existsSync } = await import('node:fs');
    writeFileSync(files.infoPath, JSON.stringify({ kind: 'unix', path: files.socketPath }), { mode: 0o600 });
    const res = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(res).toBeUndefined();
    expect(existsSync(files.infoPath), '僵死端点不清掉，之后每条命令都要先超时一次').toBe(false);
  });

  it('stopDaemon returns false when nothing is running', async () => {
    expect(await stopDaemon(files)).toBe(false);
  });
});

describe('idle shutdown', () => {
  it('exits on its own after the idle window, so a forgotten daemon does not linger', async () => {
    handle = await startDaemon({ config, logger, files, idleMs: 150 });
    await new Promise((r) => setTimeout(r, 500));
    expect(await callDaemon({ tool: 'apple_accounts', args: {} }, files),
      '空闲超时后守护进程应已退出，调用方退回一次性模式').toBeUndefined();
  });
});

/**
 * `cli start` 的正确性完全靠 `waitForDaemonReady` 这一个性质撑着："不会在
 * daemon 真正可连接之前返回"。这不是"文件存在就够了"——一个 routine 写
 * `cli start && cli mail_search` 时，`cli start` 一旦提前返回，`mail_search`
 * 就会在 daemon 真正开始监听前抢跑、悄悄退回一次性模式，完全没有症状。
 */
describe('waitForDaemonReady', () => {
  it('resolves promptly once a real daemon is already listening', async () => {
    handle = await startDaemon({ config, logger, files });
    const startedAt = Date.now();
    const endpoint = await waitForDaemonReady(files, 2000);
    expect(endpoint).toBeDefined();
    expect(Date.now() - startedAt, '已经在监听了，不该等到超时那么久').toBeLessThan(1500);
  });

  it('returns undefined when nothing ever becomes reachable before the timeout', async () => {
    // 不启动任何 daemon：files 指向的端点文件不存在。
    const endpoint = await waitForDaemonReady(files, 200);
    expect(endpoint).toBeUndefined();
  });

  it('does not resolve merely because the endpoint file exists — only once it is connectable', async () => {
    // 先手写一个端点文件，指向一个当下没有任何人监听的地址（僵死端点的真实
    // 形状：上一个被杀掉的 daemon 留下的文件）。如果 waitForDaemonReady 只看
    // "文件存不存在"，它会立刻（错误地）返回这个地址。
    await writeEndpoint(files, { kind: 'unix', path: files.socketPath });

    const startedAt = Date.now();
    // 用 `.then` 在 promise 真正落定的那一刻记时间，而不是等测试代码后面
    // 顺序跑完别的 await 之后才去看它——那样量到的是"我什么时候想起来检查"，
    // 不是"它什么时候真的 resolve 的"（这正是本轮要修的那类计时缺陷本身）。
    const readyPromise = waitForDaemonReady(files, 2000).then((endpoint) => ({
      endpoint,
      elapsedMs: Date.now() - startedAt,
    }));

    // 200ms 后才真的把一个 daemon 起在同一组 files 上，且不阻塞上面那个 await——
    // 这之前 waitForDaemonReady 必须还在轮询，不能已经拿着那个"文件存在但没
    // 人接听"的地址返回了。
    const readyDelayMs = 200;
    const startedDaemon = new Promise<void>((resolve) => {
      setTimeout(() => {
        void startDaemon({ config, logger, files }).then((h) => {
          handle = h;
          resolve();
        });
      }, readyDelayMs);
    });

    const { endpoint, elapsedMs } = await readyPromise;
    await startedDaemon;

    expect(endpoint, '真正的 daemon 起来之后终究应该等到它').toBeDefined();
    expect(
      elapsedMs,
      '如果这个值小于 readyDelayMs，说明 waitForDaemonReady 提前认了那个还没人监听的僵死端点',
    ).toBeGreaterThanOrEqual(readyDelayMs - 50);
  });
});
