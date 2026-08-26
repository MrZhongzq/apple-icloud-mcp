import net from 'node:net';
import { join } from 'node:path';
import { chmodSync, unlinkSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { AppError, toErrorPayload } from '../core/errors.js';
import { createSessionStore } from '../core/session.js';
import { createProviders } from '../providers/icloud/index.js';
import { findAccount } from '../core/config.js';
import { collectTools } from './registry.js';
import { invokeTool, CliUsageError } from './execute.js';
import { listCliTools } from './dispatch.js';
import {
  canUseUnixSocket,
  clearEndpoint,
  configFingerprint,
  DAEMON_STOP_COMMAND,
  ensureOwnedDir,
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

/** 配置漂移的说明与下一步。两处（指纹不符、工具表里没有）共用同一段文案。 */
const DRIFT_MESSAGE =
  '这个守护进程是在当前 .env 之前启动的，它的工具表、读写权限和凭据都停在启动那一刻，' +
  '和你现在的配置已经不一致了。它不会拿旧配置替你回答，因为那样给出的答案是错的却看不出来。';
const DRIFT_HINT = '先 cli stop 再 cli start，让守护进程重新读一遍配置；只跑一两条命令的话直接 cli stop，退回一次性模式即可';

export interface DaemonHandle {
  endpoint: Endpoint;
  close(): Promise<void>;
}

interface WireRequest {
  token?: string;
  tool: string;
  args: Record<string, unknown>;
  /** 客户端这一刻的配置指纹（见 transport.ts::configFingerprint）。
   *  探活请求不带它——那时还没有配置可谈——所以缺省表示"不检查"。 */
  configFingerprint?: string;
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

  // N-1: 运行时目录必须在**监听之前**就是 0700 且确实归自己所有。
  //
  // 走 ensureOwnedDir 而不是自己 mkdir：一是 `mkdir` 的 mode 对已存在的目录
  // 是空操作（那里需要事后 chmod，见 transport.ts 里的解释），二是所有权校验
  // 必须发生在 `server.listen` + `chmodSync(socket)` 之前——早先这里只做裸
  // mkdir，第一次校验所有权要等到后面的 writeEndpoint，也就是 socket 已经
  // 建好、chmod 过之后。正常流程里父进程（start.ts）会先校验一遍，所以这只
  // 影响直接 `node dist/bin/cli.js __cli_daemon_run__` 的人——而那恰恰是排查
  // 问题的维护者会做的事。
  await ensureOwnedDir(join(files.infoPath, '..'));

  // 这个 daemon 冻住的那份配置的指纹。客户端每次请求都带上它自己刚算的那个，
  // 对不上就说明 .env 已经变了、这个 daemon 比它旧（见 configFingerprint）。
  const myFingerprint = configFingerprint(config);

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });
  const tools = listCliTools(collectTools({ config, sessions, logger }));
  const account = findAccount(config);
  let session = sessions.create(account);

  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 续上空闲计时器。
   *
   * **`resetIdle()` 的含义是"确实有一个正当的客户端还在用这个 daemon"，所以它
   * 必须排在每一道"能判定调用方不是正当客户端"的闸门之后。** 在它之前加任何
   * 新的拒绝检查，都要把 `resetIdle()` 一起挪到那道检查后面去。
   *
   * 这条规则是被同一个 bug 教两遍教出来的：F-6 是 `resetIdle()` 跑在**令牌**
   * 校验之前，于是任何能连上回环端口的本地进程不用带令牌、光靠隔三差五开一条
   * 连接，就能让一个已登录的 iCloud 会话永不超时；N-1 是同一个函数、同一个
   * 顺序错误，换成了**配置漂移**这道新闸门——一个已经被拒绝服务、对谁都没用的
   * 陈旧 daemon，被那些被拒绝的请求本身无限续命（实测：idleMs 400、敲 1.2 秒，
   * 它仍然在监听）。所以现在它落在 handleRequest 里、所有闸门之后。
   */
  function resetIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void shutdown();
    }, idleMs);
  }

  function writeLine(socket: net.Socket, payload: unknown): void {
    if (socket.writable) socket.write(JSON.stringify(payload) + NEWLINE);
  }

  /**
   * 会话过期后的重建，单飞。
   *
   * 早先是"销毁当前会话、建一个新的"两行直写。两个并发请求同时拿到
   * SESSION_EXPIRED 时，它们各自建一个新会话，只有后赋值的那个还能被引用到，
   * 先建的那个连同它的 IMAP/SMTP provider 留在 store 里没人再碰——而 daemon
   * 从不 sweep，于是它一直活到进程退出。触发条件不冷僻：把
   * SESSION_TTL_MINUTES 设得比 15 分钟的空闲窗口更短是这段代码自己承认的
   * 合理加固选择。
   */
  let rebuilding: Promise<void> | undefined;
  async function rebuildSession(stale: { id: string }): Promise<void> {
    if (session !== stale) return; // 已经有人替换过了，直接用新的重试
    if (!rebuilding) {
      rebuilding = (async () => {
        await sessions.destroy(stale.id).catch(() => undefined);
        session = sessions.create(account);
      })().finally(() => {
        rebuilding = undefined;
      });
    }
    await rebuilding;
  }

  function isSessionExpiredPayload(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const error = (value as { error?: unknown }).error;
    if (error === null || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === 'SESSION_EXPIRED';
  }

  async function handleRequest(
    req: WireRequest,
    retried = false,
  ): Promise<{ value: unknown; isError: boolean; usageError?: boolean }> {
    try {
      // 配置漂移检查必须排在最前面：它解释了下面几乎所有能出的问题（未知工具、
      // 权限不对、凭据是旧的），而且它给出的下一步是可执行的。
      if (req.configFingerprint !== undefined && req.configFingerprint !== myFingerprint) {
        throw new CliUsageError('INVALID_INPUT', DRIFT_MESSAGE, { hint: DRIFT_HINT });
      }

      const tool = tools.get(req.tool);
      if (!tool) {
        // 走到这里意味着客户端的工具表里有、守护进程的没有——而客户端的
        // `resolveCall` 已经拿它自己那份（刚读的 .env 生成的）表校验过工具名了。
        // 所以真正的原因永远是"守护进程比配置旧"，不是"你打错了"。上面那条指纹
        // 检查通常会先拦住；这条是它的兜底（比如探活请求不带指纹）。
        // 提示绝不能写"用 --list 查看全部可用工具"——用户刚从 --list 里看到了它。
        throw new CliUsageError('NOT_FOUND', `守护进程不认识工具 ${req.tool}：${DRIFT_MESSAGE}`, { hint: DRIFT_HINT });
      }
      // 全部闸门都过了：到这里才算"有一个正当的客户端在用我"，可以续命。
      // 见 resetIdle 上面那段注释——它必须排在每一道拒绝检查之后。
      resetIdle();

      // 记下这次用的是哪个会话对象：并发请求同时撞上 SESSION_EXPIRED 时，
      // rebuildSession 靠它判断"我要重建的那个是不是已经被别人换掉了"。
      const stale = session;
      const args: Record<string, unknown> = { ...req.args };
      if ('session_id' in tool.config.inputSchema) {
        args.session_id = stale.id;
      }
      // 走 invokeTool 而不是直接 tool.handler：那里是 CLI 三条执行路径共用的收口点，
      // 参数校验（对着工具自己的 schema）和 content 信封的拆解都在那一处。早先这里
      // 自己复制了一遍拆信封的代码、并且**不做任何参数校验**——于是同一条命令，
      // 跑了 cli start 的时候没有校验、没跑的时候有，一个只在常驻模式下存在的漏洞。
      const invoked = await invokeTool(tool, args);
      const value: unknown = invoked.value;
      const result = { isError: invoked.isError };

      // 常驻会话可能比 SESSION_TTL_MINUTES 活得更久——把 TTL 设得比空闲超时
      // 更短是完全合理的加固选择，不该因此把 daemon 变成一个每次都报
      // SESSION_EXPIRED、提示"调用 apple_login"（CLI 明确拒绝的工具）的死
      // 胡同，直到 15 分钟空闲超时替用户收场。这里自己重建一次会话再重试，
      // 对调用方完全透明；只重试一次，不递归，真出问题就正常报错。
      if (result.isError && !retried && isSessionExpiredPayload(value)) {
        await rebuildSession(stale);
        return handleRequest(req, true);
      }

      return { value, isError: result.isError };
    } catch (err) {
      // 未知工具、空 content 等 daemon 自己发现的问题，和工具内部已经被 wrapTool
      // 捕获过的错误统一走同一条 toErrorPayload——调用方（callDaemon）不需要
      // 区分"工具报的错"和"daemon 层发现的错"，两者对它而言都是一次失败的调用。
      //
      // 唯一需要过线的区别是"参数没通过校验"：工具**根本没跑**，那是一次用法错误
      // （退出码 1），不是 iCloud 的回答（退出码 2）。不带这个标志的话，同一条写错
      // 参数的命令会因为"有没有跑 cli start"而落在两个不同的退出码上，而脚本正是
      // 按退出码分支的。
      if (err instanceof CliUsageError) {
        return { value: toErrorPayload(err), isError: true, usageError: true };
      }
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

      // TCP 路径没有文件权限可依赖：令牌不对（或没带）立刻拒绝。这条检查
      // 必须先于任何 resetIdle：否则任何能连上回环端口的本地进程，不用带
      // 令牌，光靠隔三差五开一个连接就能让 daemon（连同它握着的已登录
      // iCloud 会话）永远不超时。
      //
      // 拒绝前先回一句明确的错误，而不是直接 destroy 什么都不说：调用方
      // （callDaemon）需要能把"令牌不对，这次请求确定没被执行"和"请求发
      // 出去之后连接就断了，不知道有没有被执行"区分开——后者按 F-4 的规则
      // 必须报错、不能重跑写操作；前者如果也报同一种"可能已执行"的错误，
      // 对着一个连从未执行过的请求喊"不要重跑 mail_send"是在吓唬调用方。
      if (usesToken && !tokensMatch(parsed.token, token)) {
        writeLine(socket, { error: { code: 'AUTH_FAILED', message: '令牌不对，拒绝这次连接' } });
        socket.end();
        return;
      }

      // 注意这里**没有** resetIdle()——它挪进 handleRequest，排在全部闸门之后。
      // 规则见 resetIdle 自己的注释；停机指令不需要续命，它下一步就是关停。

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

  const useUnix = !usesToken;

  /**
   * `server.listen` 成功之后的每一步都必须包在这里面。
   *
   * 监听一旦起来，任何一次抛出都留下一个没人引用、也没人能关的监听 socket
   * （独立 daemon 进程靠 `main().catch` 退出，掩盖了这一点；嵌入式/测试用法
   * 会真的泄漏）。此前只有 `writeEndpoint` 被包住，而它前面还有两个会抛的
   * 地方——unix 分支的 `chmodSync` 和 TCP 分支那句"没分配到端口"的检查——
   * 都在保护范围之外。往这后面加任何一步，都要留在这个包装里。
   */
  const guardStartup = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sessions.destroyAll().catch(() => undefined);
      throw err;
    }
  };

  if (useUnix) {
    await listenUnixSocket(server, files.socketPath);
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  const endpoint: Endpoint = await guardStartup(() => {
    if (useUnix) {
      // listen 之后必须立刻 chmod：Node 建出来的 unix socket 默认 755/775，
      // 谁都能连，而它后面挂着一个已登录、握着用户 iCloud 连接的会话。运行时
      // 目录本身已经是 0700（见 transport.ts），这里是纵深防御，不是唯一的门。
      chmodSync(files.socketPath, 0o600);
      return { kind: 'unix', path: files.socketPath };
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new AppError('INTERNAL', 'TCP 监听未能分配端口');
    }
    return { kind: 'tcp', port: address.port, token };
  });

  await guardStartup(() => writeEndpoint(files, endpoint, ownerId));
  resetIdle();

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // destroyAll 而不是 destroy(session.id)：`session` 是一个可变闭包变量，
    // SESSION_EXPIRED 的重建路径会替换它。下面的 rebuildSession 已经把并发
    // 重建收敛成单飞，但"只销毁当前那一个"这种写法本身就假设了历史上从没有
    // 别的会话存在过——一旦哪天多出第二条重建路径，漏掉的那个会话会带着它
    // 的 IMAP/SMTP 连接一直留到进程退出。destroyAll 对这条不变式不作任何假设。
    await sessions.destroyAll().catch(() => undefined);

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
