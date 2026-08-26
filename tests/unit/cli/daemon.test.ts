import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { startDaemon } from '../../../src/cli/daemon.js';
import { callDaemon, stopDaemon } from '../../../src/cli/client.js';
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
    const port = handle.endpoint.port;
    const closed = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify({ tool: 'apple_accounts', args: {} }) + String.fromCharCode(10)));
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('close', () => resolve(got.length === 0 || !got.includes('email')));
      setTimeout(() => { c.destroy(); resolve(true); }, 2000);
    });
    expect(closed, 'TCP 路径没有文件权限可依赖，令牌是唯一的门').toBe(true);
  });

  it('refuses a tcp connection presenting the wrong token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') return;
    const port = handle.endpoint.port;
    const rejected = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write(JSON.stringify({ token: 'wrong-token', tool: 'apple_accounts', args: {} }) + String.fromCharCode(10));
      });
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('close', () => resolve(!got.includes('email')));
      setTimeout(() => { c.destroy(); resolve(true); }, 2000);
    });
    expect(rejected).toBe(true);
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
