import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chmodSync, unlinkSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { AppError, toErrorPayload } from '../core/errors.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { findAccount } from '../core/config.js';
import { collectTools } from './registry.js';
import { listCliTools } from './dispatch.js';
import {
  canUseUnixSocket,
  clearEndpoint,
  DAEMON_STOP_COMMAND,
  endpointFiles,
  generateOwnerId,
  generateToken,
  readEndpointOwner,
  writeEndpoint,
} from './transport.js';
import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { Endpoint, EndpointFiles } from './transport.js';

const NEWLINE = String.fromCharCode(10);
const DEFAULT_IDLE_MS = 15 * 60_000;

export interface DaemonHandle {
  endpoint: Endpoint;
  close(): Promise<void>;
}

interface WireRequest {
  token?: string;
  tool: string;
  args: Record<string, unknown>;
}

function isWireRequest(value: unknown): value is WireRequest {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.tool === 'string';
}

/**
 * 常量时间比较令牌。`!==` 本身在类型上是安全的（`parsed.token` 无论是
 * undefined/null/数字/对象，和字符串比较都不会做隐式转换），但字符串比较
 * 会在长度或首个不同字符处提前退出，理论上给基于时序的信息泄露留了缝隙。
 * 43 个 base64url 字符从回环时序里恢复出来不是一个现实威胁，但这个原语已经
 * 在 node:crypto 里、成本几乎为零，没有理由不用。长度不等时 timingSafeEqual
 * 会抛，这里在那之前就短路掉，因为长度本身已经足够拒绝。
 */
function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * unix socket 路径上，listen 之前不再无脑 unlinkSync——那正是两个 cli start
 * 竞态时后来者干掉先行者活 socket 的那一步。改成"先直接 listen，撞见
 * EADDRINUSE 才去探测那条路径上是不是真的还有人在听"：探测到没人听（僵尸
 * socket 文件），才清掉重试；探测到真的有人在听，报一个清楚的冲突错误，
 * 而不是把它的地址抢过来。
 */
function listenUnixSocket(server: net.Server, socketPath: string): Promise<void> {
  const attemptListen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => reject(err);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

  const probeAlive = (): Promise<boolean> =>
    new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });

  return attemptListen().catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;

    const alive = await probeAlive();
    if (alive) {
      throw new AppError('CONFLICT', `已经有一个守护进程在监听 ${socketPath}`, {
        hint: '用 cli stop 停止它，或者直接复用它，而不是再起一个',
      });
    }

    // 探测确认没人听：这是上一个被杀掉/崩溃的 daemon 留下的僵尸 socket 文件。
    try {
      unlinkSync(socketPath);
    } catch {
      // 竞态里可能已经被清理，忽略。
    }
    return attemptListen();
  });
}

/**
 * 常驻进程：会话在启动时建一次，所有请求复用——省下的是每条命令都要重做的
 * TCP+TLS+AUTH 握手，不只是几次登录验证。
 *
 * 协议是换行分隔的单行 JSON：请求 `{ token?, tool, args }`，成功/工具失败都回
 * `{ value, isError }`（与 `ExecuteResult` 同形状），daemon 自己都解析不了的
 * 请求才回 `{ error }`。用换行分隔而不是长度前缀，是因为调试时能直接 `nc` 上去看。
 * 一条连接只服务一条请求——写完响应就 end()，后续任何数据一律忽略，不会
 * 执行一个我们已经决定不回答的请求。
 */
export async function startDaemon(deps: {
  config: AppConfig;
  logger: Logger;
  /** 空闲超时，默认 15 分钟；到点自动销毁会话、关闭监听、删除端点文件、退出。 */
  idleMs?: number;
  /** 测试注入：跳过默认的临时目录端点文件位置。 */
  files?: EndpointFiles;
  /**
   * 强制走 TCP 传输。只给测试用——否则 POSIX 上永远走 unix 分支，令牌校验那条
   * 路径永远没有真实流量走过。真实声明在这里而不是靠 `as never` 硬塞，
   * 是为了这个开关本身也受类型检查。
   */
  forceTcp?: boolean;
  /**
   * 停机完成后调用一次，不管触发源是空闲超时、`__cli_daemon_stop__`，还是
   * 外部对 `close()` 的调用——三条路径最终都走同一个内部 `shutdown()`，这个
   * 回调就挂在那唯一的出口上。只给真正作为独立进程运行的 daemon（`bin/cli.ts`
   * 的 `DAEMON_RUN_MARKER` 分支）用来触发 `process.exit`：`shutdown()` 只负责
   * 关监听、销毁会话、清端点文件，从不假定"关完了事件循环就会自己排空"——
   * 万一某个 provider 留下一个没清干净的定时器，daemon 会变成一个没有监听、
   * 没有端点文件、`cli stop` 也找不到的隐形僵尸。测试环境（daemon.test.ts
   * 在 vitest 进程里直接调用 `startDaemon`）不传这个回调，行为不变。
   */
  onShutdown?: () => void;
}): Promise<DaemonHandle> {
  const { config, logger } = deps;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const files = deps.files ?? endpointFiles();
  // 这个 daemon 实例的身份：只有端点文件里写着这个 id 的时候，shutdown 才有
  // 资格清理它——避免两个 cli start 竞态时，后起者赢得竞态之后，先起者的
  // 孤儿进程在自己的空闲超时里删掉后起者仍然活着的端点。
  const ownerId = generateOwnerId();

  await mkdir(join(files.infoPath, '..'), { recursive: true });

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });
  const tools = listCliTools(collectTools({ config, sessions, logger }));
  const account = findAccount(config);
  let session = sessions.create(account);

  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function resetIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void shutdown();
    }, idleMs);
  }

  function writeLine(socket: net.Socket, payload: unknown): void {
    if (socket.writable) socket.write(JSON.stringify(payload) + NEWLINE);
  }

  function isSessionExpiredPayload(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const error = (value as { error?: unknown }).error;
    if (error === null || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === 'SESSION_EXPIRED';
  }

  async function handleRequest(req: WireRequest, retried = false): Promise<{ value: unknown; isError: boolean }> {
    try {
      const tool = tools.get(req.tool);
      if (!tool) {
        throw new AppError('NOT_FOUND', `未知工具：${req.tool}`, { hint: '用 --list 查看全部可用工具' });
      }
      const args: Record<string, unknown> = { ...req.args };
      if ('session_id' in tool.config.inputSchema) {
        args.session_id = session.id;
      }
      const result = await tool.handler(args);
      const first = result.content[0];
      if (!first) {
        throw new AppError('INTERNAL', `工具 ${req.tool} 返回了空的 content`);
      }
      const value: unknown = JSON.parse(first.text);

      // 常驻会话可能比 SESSION_TTL_MINUTES 活得更久——把 TTL 设得比空闲超时
      // 更短是完全合理的加固选择，不该因此把 daemon 变成一个每次都报
      // SESSION_EXPIRED、提示"调用 apple_login"（CLI 明确拒绝的工具）的死
      // 胡同，直到 15 分钟空闲超时替用户收场。这里自己重建一次会话再重试，
      // 对调用方完全透明；只重试一次，不递归，真出问题就正常报错。
      if (result.isError === true && !retried && isSessionExpiredPayload(value)) {
        await sessions.destroy(session.id).catch(() => undefined);
        session = sessions.create(account);
        return handleRequest(req, true);
      }

      return { value, isError: result.isError === true };
    } catch (err) {
      // 未知工具、空 content 等 daemon 自己发现的问题，和工具内部已经被 wrapTool
      // 捕获过的错误统一走同一条 toErrorPayload——调用方（callDaemon）不需要
      // 区分"工具报的错"和"daemon 层发现的错"，两者对它而言都是一次失败的调用。
      return { value: toErrorPayload(err), isError: true };
    }
  }

  const usesToken = deps.forceTcp === true || !(await canUseUnixSocket());
  const token = usesToken ? generateToken() : '';

  const server = net.createServer((socket) => {
    let buffer = '';
    let handled = false;

    socket.on('data', (chunk: Buffer) => {
      // 一条连接只服务一条请求：管道进来的第二条不该被执行（哪怕带着真实
      // 副作用），因为它的响应反正没人能收到——这条连接的写端已经或即将
      // 关闭。此前这里会继续解析、继续执行，只是响应被 writeLine 的
      // socket.writable 检查悄悄丢掉。
      if (handled) return;
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf(NEWLINE);
      if (idx === -1) return;
      handled = true;

      const line = buffer.slice(0, idx);
      let parsed: unknown;
      try {
        parsed = line.length === 0 ? undefined : JSON.parse(line);
      } catch {
        writeLine(socket, { error: { message: '请求不是合法 JSON' } });
        socket.end();
        return;
      }
      if (!isWireRequest(parsed)) {
        writeLine(socket, { error: { message: '请求缺少 tool 字段' } });
        socket.end();
        return;
      }

      // TCP 路径没有文件权限可依赖：令牌不对（或没带）立刻断开，不回任何数据——
      // 会话背后是一个已登录的 iCloud 连接，宁可什么都不说也不能给探测者留信息。
      // 这条检查必须先于任何 resetIdle：否则任何能连上回环端口的本地进程，
      // 不用带令牌，光靠隔三差五开一个连接就能让 daemon（连同它握着的已登录
      // iCloud 会话）永远不超时。
      if (usesToken && !tokensMatch(parsed.token, token)) {
        socket.destroy();
        return;
      }

      resetIdle();

      // stopDaemon 的信使：不查工具表，回一个成功响应后立刻关停。走同一条
      // 令牌校验（上面那行），所以 TCP 模式下拿不到令牌的人也停不了 daemon。
      if (parsed.tool === DAEMON_STOP_COMMAND) {
        writeLine(socket, { value: { stopped: true }, isError: false });
        socket.end();
        void shutdown();
        return;
      }

      void handleRequest(parsed).then((res) => {
        writeLine(socket, res);
        socket.end();
      });
    });
    socket.on('error', () => undefined);
  });

  let endpoint: Endpoint;
  const useUnix = !usesToken;

  if (useUnix) {
    // listen 之后必须立刻 chmod：Node 建出来的 unix socket 默认 755/775，
    // 谁都能连，而它后面挂着一个已登录、握着用户 iCloud 连接的会话。运行时
    // 目录本身已经是 0700（见 transport.ts），这里是纵深防御，不是唯一的门。
    await listenUnixSocket(server, files.socketPath);
    chmodSync(files.socketPath, 0o600);
    endpoint = { kind: 'unix', path: files.socketPath };
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new AppError('INTERNAL', 'TCP 监听未能分配端口');
    }
    endpoint = { kind: 'tcp', port: address.port, token };
  }

  await writeEndpoint(files, endpoint, ownerId);
  resetIdle();

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sessions.destroy(session.id).catch(() => undefined);

    // 只清理还认得出是自己写的那份端点文件：如果竞态中输给了另一个后起的
    // cli start，端点文件此刻描述的是那个仍然活着的 daemon，绝不能把它删
    // 掉。读不到 ownerId（比如文件已经不在了）时视为"不是我的"，不清理——
    // clearEndpoint 本来就对不存在的文件是安全的空操作，多一次判断只会让
    // "删错别人的"这个方向更保守，不会让"该清理的没清理"变严重。
    const currentOwner = await readEndpointOwner(files);
    if (currentOwner === ownerId) {
      await clearEndpoint(files);
    }

    deps.onShutdown?.();
  }

  return { endpoint, close: shutdown };
}
