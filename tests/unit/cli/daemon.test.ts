import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { startDaemon } from '../../../src/cli/daemon.js';
import { callDaemon, stopDaemon, waitForDaemonReady } from '../../../src/cli/client.js';
import { writeEndpoint, readEndpoint, DAEMON_STOP_COMMAND } from '../../../src/cli/transport.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';

/**
 * `providers/icloud/index.js` 换成一份完全不碰网络的假实现，全文件共用。
 * daemon 启动时会无条件建一次会话（`sessions.create(account)`），也就是
 * 无条件调一次 `createProviders`——不管某条测试用没用到 IMAP，这个模块都会
 * 被加载到。换成假的之后，`imap.close`/`smtp.close` 是可断言的 spy
 * （F-5 用来确认空闲超时真的销毁了会话，不只是让 daemon 变得连不上），
 * `imap.listFolders` 返回一个固定结果（F-16 的会话自愈测试要用到）。
 */
const { closeImap, closeSmtp, listFolders } = vi.hoisted(() => ({
  closeImap: vi.fn(async () => undefined),
  closeSmtp: vi.fn(async () => undefined),
  listFolders: vi.fn(async () => ({ folders: [], failures: [] })),
}));

vi.mock('../../../src/providers/icloud/index.js', () => ({
  createProviders: () => ({
    imap: { close: closeImap, listFolders },
    smtp: { close: closeSmtp },
    caldav: {},
    carddav: {},
  }),
}));

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
 * 三种互斥结果，不是两种：一次 TCP 探测要么被拒绝（连上了，但服务端主动
 * destroy、什么都没回）、要么被正常服务（拿到一个带 email 字段的响应）、
 * 要么两秒内什么都没发生（daemon 挂住了、根本没回应）。此前用一个布尔值把
 * "拒绝"和"挂住"揉成同一个 true——一个从不回应的 daemon 会让两条令牌测试
 * 全部"通过"，而且是通过了错误的理由：慢，不是拒绝。
 *
 * 第四种结果 `'unreachable'` 单独区分"连接阶段本身就失败"（`ECONNREFUSED`：
 * 那头压根没有服务在监听，连令牌校验的门都不存在）和 `'rejected'`（连上了，
 * 是服务端主动拒绝的）——这两者的含义完全不同："没有门" vs "门把我拒之
 * 门外"，都算进 `'rejected'` 会把"根本没有门"误判成"门正常在拒绝我"。
 *
 * N-4 之后，daemon 在拒绝一次请求时会先回一句明确的 `{ error: {...} }`
 * 再关连接，不再是纯粹的 destroy、什么都不写——所以"收到的字节是不是
 * 空的"不能再用来判断"是不是被拒绝"了：拒绝也有响应体。这里改成看响应
 * 里有没有 `"error"` 这个键；真正被正常服务的调用（比如 apple_accounts）
 * 回的是 `{ value: [...], isError: false }`，不带这个键。
 */
type TcpOutcome = 'rejected' | 'served' | 'hung' | 'unreachable';

function probeTcp(port: number, payload: Record<string, unknown>): Promise<TcpOutcome> {
  return new Promise<TcpOutcome>((resolve) => {
    let settled = false;
    let connected = false;
    const done = (outcome: TcpOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const c = net.connect(port, '127.0.0.1', () => {
      connected = true;
      c.write(JSON.stringify(payload) + String.fromCharCode(10));
    });
    let got = '';
    c.on('data', (d) => {
      got += String(d);
    });
    c.on('error', () => done(connected ? 'rejected' : 'unreachable'));
    c.on('close', () => {
      const trimmed = got.trim();
      done(trimmed.length === 0 || trimmed.includes('"error"') ? 'rejected' : 'served');
    });
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
  closeImap.mockClear();
  closeSmtp.mockClear();
  listFolders.mockClear();
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
  /**
   * 不再用 `it.skipIf(win32)` + 函数体内部提前 `return` 的组合——那个组合在
   * "Windows"和"POSIX 但这台机器上 unix socket 也不可用"两种情况下都是
   * **静默通过**，而不是显式跳过：vitest 的汇总行只会显示"N passed"，
   * "守护进程访问控制的这一半完全没被验证过"这件事无从看出。
   * 改成两个分支都断言：拿到 unix 端点就查 chmod 0600；拿到 tcp 端点就确认
   * 令牌路径确实生效了（一个非空令牌）。不管这次测试在哪个平台的哪种环境
   * 下跑，"访问控制的某个具体机制"这句话总有一半是被真的验证过的。
   */
  it('locks the socket down: unix mode chmods 0600, tcp mode requires a non-empty token', async () => {
    handle = await startDaemon({ config, logger, files });
    if (handle.endpoint.kind === 'unix') {
      const mode = statSync(handle.endpoint.path).mode & 0o777;
      expect(mode, 'Node 建出来默认是 755/775，谁都能连；那后面挂着一个已登录的 iCloud 会话').toBe(0o600);
    } else {
      // 这里不再重复 `expect(handle.endpoint.kind).toBe('tcp')`——走到这个
      // 分支就已经证明了 kind !== 'unix'，而 Endpoint 只有 unix/tcp 两种
      // 取值，那一句在类型层面必然为真，不是一个真正的运行时断言。真正
      // 有内容的检查是下面这一句。
      expect(handle.endpoint.token.length, 'TCP 模式没有文件权限可依赖，必须有一个非空令牌').toBeGreaterThan(0);
    }
  });

  it('refuses a tcp connection that presents no token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    // forceTcp: true 之下端点必须是 tcp——此前这里是 `if (kind !== 'tcp') return;`，
    // 一旦 forceTcp 因为任何原因（重构、改名……）失效，两条令牌测试会在 WSL
    // 上安静地退化成"什么都没测"，而不是失败。断言取代提前 return，让这个
    // 前提本身可证伪。
    expect(handle.endpoint.kind).toBe('tcp');
    if (handle.endpoint.kind !== 'tcp') return;
    const outcome = await probeTcp(handle.endpoint.port, { tool: 'apple_accounts', args: {} });
    expect(outcome, 'TCP 路径没有文件权限可依赖，令牌是唯一的门；"hung"、"served"、"unreachable" 都是失败').toBe(
      'rejected',
    );
  });

  it('refuses a tcp connection presenting the wrong token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    expect(handle.endpoint.kind).toBe('tcp');
    if (handle.endpoint.kind !== 'tcp') return;
    const outcome = await probeTcp(handle.endpoint.port, {
      token: 'wrong-token',
      tool: 'apple_accounts',
      args: {},
    });
    expect(outcome).toBe('rejected');
  });

  it('refuses to stop the daemon over tcp without a valid token', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    expect(handle.endpoint.kind).toBe('tcp');
    if (handle.endpoint.kind !== 'tcp') return;

    // 停止指令必须走同一条令牌校验：把 token 检查和 __cli_daemon_stop__ 两块
    // 代码调换顺序，这条测试不会转红——这正是它存在的理由。
    const outcome = await probeTcp(handle.endpoint.port, { tool: DAEMON_STOP_COMMAND, args: {} });
    expect(outcome, '没带令牌的停止请求必须被拒绝，否则任何本地进程都能不带令牌关停 daemon').toBe('rejected');

    const after = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(after, '没带令牌的停止请求不该真的把 daemon 停掉').toBeDefined();
  });

  it('probeTcp distinguishes "nobody is listening" from "the gate refused me"', async () => {
    // 借一个临时 server 拿一个当下没人用的端口，再关掉它——这个地址真实
    // 存在过，但此刻绝对没有监听者：ECONNREFUSED 发生在连接阶段本身，不是
    // 连上之后被应用层拒绝。'unreachable' 和 'rejected' 是两件不同的事：
    // 前者压根没有门，后者是有一扇门、它主动把我关在外面。
    const probeServer = net.createServer();
    const port = await new Promise<number>((resolve) => {
      probeServer.listen(0, '127.0.0.1', () => {
        const address = probeServer.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const outcome = await probeTcp(port, { tool: 'apple_accounts', args: {} });
    expect(outcome).toBe('unreachable');
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
  it('exits on its own after the idle window: closes the listener and destroys the session, not merely the endpoint file', async () => {
    handle = await startDaemon({ config, logger, files, idleMs: 150 });
    const endpoint = handle.endpoint;
    await new Promise((r) => setTimeout(r, 500));

    expect(await callDaemon({ tool: 'apple_accounts', args: {} }, files),
      '空闲超时后守护进程应已退出，调用方退回一次性模式').toBeUndefined();

    // 监听器真的关了，不是文件被删了而已：这个测试此前唯一的断言是
    // "端点文件不在了"，删掉 daemon.ts 里的 sessions.destroy(...) 那一行，
    // 这条测试照样全绿——它的名字承诺的东西，它其实完全没检查。这里对着
    // 旧端点直接发起一次原始连接，必须被拒绝。
    const stillListening = await new Promise<boolean>((resolve) => {
      const c = endpoint.kind === 'unix' ? net.connect(endpoint.path) : net.connect(endpoint.port, '127.0.0.1');
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => resolve(false));
    });
    expect(stillListening, '空闲超时之后监听器必须真的关掉，不能只是端点文件消失').toBe(false);

    // 会话真的销毁了，不是"进程还在但没人能连上"：底层 IMAP/SMTP provider 的
    // close() 必须被调用过。
    expect(closeImap, '空闲超时必须销毁会话、关闭底层 IMAP 连接，不能只是让 daemon 变得连不上').toHaveBeenCalled();
    expect(closeSmtp, '同上，SMTP 那一半也必须关掉').toHaveBeenCalled();
  });
});

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
    // 不是"它什么时候真的 resolve 的"。
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

describe('session self-healing (F-16)', () => {
  it('recovers from a locally-expired session instead of wedging on SESSION_EXPIRED', async () => {
    // sessionTtlMs 比 idleMs 短是完全合理的加固选择——daemon 不该因此变成
    // 一个每次都报 SESSION_EXPIRED、提示"调用 apple_login"（CLI 明确拒绝的
    // 工具）的死胡同，直到空闲超时替用户收场。
    const shortTtlConfig: AppConfig = { ...config, sessionTtlMs: 100 };
    handle = await startDaemon({ config: shortTtlConfig, logger, files, idleMs: 60_000 });

    await new Promise((r) => setTimeout(r, 250)); // 让会话的 TTL 真的过期

    const res = await callDaemon({ tool: 'mail_folders', args: {} }, files);
    expect(res, 'daemon 应当自己重建会话再重试一次，而不是原样把 SESSION_EXPIRED 甩给调用方').toBeDefined();
    expect(res?.isError, 'mail_folders 在会话自愈之后应当正常返回').toBe(false);
    expect(listFolders, '重建会话之后必须真的执行了原来那次调用').toHaveBeenCalled();
  });
});

describe('endpoint ownership (F-7)', () => {
  it('does not delete a newer daemon’s endpoint after losing a cli-start race', async () => {
    handle = await startDaemon({ config, logger, files, idleMs: 150 });

    // 模拟"另一个 daemon 赢得了竞态"：在这个 daemon 还没到空闲超时之前，
    // 用一个不同的 ownerId 覆盖端点文件——就像真的有第二个 cli start 进程
    // spawn 出来、写赢了一样。
    const impostorEndpoint = { kind: 'unix' as const, path: join(dir, 'someone-elses.sock') };
    await writeEndpoint(files, impostorEndpoint, 'someone-elses-owner-id');

    await new Promise((r) => setTimeout(r, 350)); // 等第一个 daemon 的空闲计时器触发

    const stillThere = await readEndpoint(files);
    expect(stillThere, '空闲超时不该删掉一个不是自己写的端点文件').toEqual(impostorEndpoint);
  });
});

describe('runtime dir permissions (N-1)', () => {
  // 这条必须走 startDaemon，不能只测 writeEndpoint：N-1 这个回归的形状恰恰是
  // 两处 mkdir 没对齐——daemon.ts 自己在 listen 之前那次 mkdir 曾经没带
  // mode，只有 writeEndpoint 里的 ensureOwnedDir 带；只测 writeEndpoint 那条
  // （见 transport.test.ts）测不出 daemon 实际启动路径上的目录权限，之前
  // 就是这样：那条测试全绿，daemon 编译后跑起来目录却是 755。
  //
  // 关键细节：`files`（共享的 beforeEach 变量）的父目录是 `dir`，而 `dir`
  // 本身是 mkdtempSync 建出来的，mkdtempSync 默认就是 0700——如果直接用
  // 共享的 `files`，daemon.ts 那次 mkdir 面对的是一个已经存在、模式凑巧
  // 也是 0700 的目录，mkdir 对它是空操作，测试会在完全没有验证 daemon.ts
  // 那次 mkdir 的情况下"意外"通过（第一次写这条测试时就是这样：删掉
  // daemon.ts 里的 mode:0700 之后，这条测试原样全绿）。这里必须指向 `dir`
  // 底下一个还不存在的子目录，让它的创建、连同它的权限，完全由 daemon.ts
  // 自己那次 mkdir 决定。
  const skipReasonN1 =
    process.platform === 'win32'
      ? '（在 win32 上跳过：POSIX 权限位在这个平台上没有意义；在 WSL/Linux 上验证）'
      : '';
  it.skipIf(process.platform === 'win32')(
    'startDaemon creates the runtime dir 0700 on its own mkdir call, before writeEndpoint ever runs' + skipReasonN1,
    async () => {
      const freshRuntimeDir = join(dir, 'not-yet-created');
      const freshFiles = { infoPath: join(freshRuntimeDir, 'endpoint.json'), socketPath: join(freshRuntimeDir, 'cli.sock') };
      handle = await startDaemon({ config, logger, files: freshFiles });
      const mode = statSync(freshRuntimeDir).mode & 0o777;
      expect(
        mode,
        'daemon.ts 里 listen 之前那次 mkdir 必须自己带 mode:0700，不能指望 writeEndpoint 事后补——mkdir 对已存在的目录是空操作',
      ).toBe(0o700);
    },
  );
});

describe('explicit auth rejection, not "may have executed" (N-4)', () => {
  it('a stale/wrong token gets a clear AUTH_FAILED, and the daemon keeps serving correctly-authenticated calls', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true });
    if (handle.endpoint.kind !== 'tcp') throw new Error('forceTcp should force tcp mode');

    // 单独一份端点文件，端口是真的（daemon 真的在监听），令牌是错的——模拟
    // "daemon 重启换了新令牌，某个调用方手里还是旧端点文件"这种会真实发生
    // 的竞态。这次请求的字节确实发出去了，但 daemon 会在调用任何工具之前
    // 就用一句明确的拒绝响应把它挡下来——callDaemon 必须把这个当作"确定
    // 没有被执行"的认证失败来报，既不能悄悄退回一次性模式（会把一个坏
    // 令牌的问题吞掉），也不能报成 F-4 那种"可能已经执行了"的模糊错误
    // （对一个从未被执行过的调用喊"不要重跑 mail_send"是在吓唬调用方）。
    const staleDir = mkdtempSync(join(tmpdir(), 'cli-stale-'));
    const staleFiles = { infoPath: join(staleDir, 'endpoint.json'), socketPath: join(staleDir, 'cli.sock') };
    try {
      await writeEndpoint(staleFiles, { kind: 'tcp', port: handle.endpoint.port, token: 'stale-token' });
      await expect(callDaemon({ tool: 'apple_accounts', args: {} }, staleFiles)).rejects.toMatchObject({
        code: 'AUTH_FAILED',
      });
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }

    const after = await callDaemon({ tool: 'apple_accounts', args: {} }, files);
    expect(after, '一次被拒绝的连接不该影响 daemon 后续用真令牌的正常服务').toBeDefined();
  });
});

describe('no round-trip deadline in production (N-3)', () => {
  /** 接受连接、读数据、永不回应——模拟一个健康但很慢的工具调用（比如首次
   *  contacts_search 的全量拉取、一次很大的 mail_search）。走 TCP 而不是
   *  unix socket，这样两个平台都能跑，不用只在 WSL 上验证。 */
  async function startHangingListener(): Promise<{ port: number; close: () => Promise<void> }> {
    // net.Server（不像 http.Server）没有 closeAllConnections，得自己记住
    // 每一条打进来的连接才能在收尾时主动 destroy——server.close() 本身只是
    // 停止接受新连接，不会碰已经建立的那些，靠它自己是等不到挂起的 promise
    // 落定的。
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
    return {
      port,
      close: async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      },
    };
  }

  it('does not time out a slow-but-alive daemon by default', async () => {
    const hanging = await startHangingListener();
    await writeEndpoint(files, { kind: 'tcp', port: hanging.port, token: 'irrelevant-token' });

    let settled = false;
    const pending = callDaemon({ tool: 'apple_accounts', args: {} }, files)
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      settled,
      '生产路径不该有任何硬编的往返超时——一次健康但慢的调用不该在几百毫秒内被当成失败',
    ).toBe(false);

    // 收尾：先主动断开连接（daemon 那头没有超时，得靠这个让挂起的 promise
    // 真正落定），再等它 settle，不带着一个永远不会 resolve 的 promise
    // 退出测试。
    await hanging.close();
    await pending;
  });

  it('an injected round-trip timeout still fires and is reported as sent-unknown (test-only knob)', async () => {
    const hanging = await startHangingListener();
    try {
      await writeEndpoint(files, { kind: 'tcp', port: hanging.port, token: 'irrelevant-token' });
      await expect(
        callDaemon({ tool: 'apple_accounts', args: {} }, files, { roundTripMs: 200 }),
      ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    } finally {
      await hanging.close();
    }
  });
});

describe('idle timer requires authentication (F-6 guard)', () => {
  it('an unauthenticated tcp connection does not reset the idle timer', async () => {
    handle = await startDaemon({ config, logger, files, forceTcp: true, idleMs: 300 });
    if (handle.endpoint.kind !== 'tcp') throw new Error('forceTcp should force tcp mode');
    const port = handle.endpoint.port;

    // 每 80ms 敲一次门，不带令牌，一直敲到 idleMs（300ms）过去——如果
    // resetIdle 在令牌校验之前就跑了，这些连接会一直给空闲计时器续命，
    // daemon 永远不会因为空闲而退出。
    const knock = setInterval(() => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write(JSON.stringify({ tool: 'apple_accounts', args: {} }) + String.fromCharCode(10));
      });
      c.on('error', () => undefined);
      c.on('data', () => undefined);
    }, 80);

    await new Promise((resolve) => setTimeout(resolve, 600));
    clearInterval(knock);

    const stillListening = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => resolve(false));
    });
    expect(
      stillListening,
      '没带令牌的连接不该续上空闲计时器；daemon 应当已经因为空闲超时退出了',
    ).toBe(false);
  });
});

describe('unix socket conflict (Concern 1 / CONFLICT path)', () => {
  const skipReasonConflict =
    process.platform === 'win32'
      ? '（在 win32 上跳过：永远走 TCP，端口由 OS 随机分配，没有 unix socket 路径可抢占；在 WSL/Linux 上验证）'
      : '';
  it.skipIf(process.platform === 'win32')(
    'refuses to steal a socket path that a live daemon is still listening on' + skipReasonConflict,
    async () => {
      handle = await startDaemon({ config, logger, files });
      if (handle.endpoint.kind !== 'unix') {
        throw new Error('canUseUnixSocket() 应当在非 win32 平台上为 true——见 transport.test.ts 里对它的直接断言');
      }

      // 模拟"端点文件被删了，但监听者还活着"：父进程的 waitForDaemonReady(0)
      // 探测不到端点，认为没人在跑，于是尝试再起一个——这正是 Concern 1
      // 提到的、之前完全没有测试碰过的 CONFLICT 路径。
      unlinkSync(files.infoPath);

      await expect(startDaemon({ config, logger, files })).rejects.toMatchObject({ code: 'CONFLICT' });
    },
  );
});
