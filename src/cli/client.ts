import net from 'node:net';
import { clearEndpoint, DAEMON_STOP_COMMAND, endpointFiles, readEndpoint } from './transport.js';
import type { EndpointFiles, Endpoint } from './transport.js';
import type { ExecuteResult } from './execute.js';
import { AppError } from '../core/errors.js';

const NEWLINE = String.fromCharCode(10);
/** 建连超时的默认值。这一个是安全的：它只覆盖写请求之前的阶段，超时时
 *  daemon 到底还在不在都不确定，回退到一次性模式没有风险。可注入，测试
 *  不用真的等 3 秒。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export interface CallRequest {
  tool: string;
  args: Record<string, unknown>;
}

/** 调用方（主要是测试）可以覆盖的超时旋钮。生产路径从不传 `roundTripMs`——
 *  见 `roundTrip` 上的注释：请求字节写出去之后就不该再有总时长上限。 */
export interface ClientTimeouts {
  connectMs?: number;
  roundTripMs?: number;
}

interface WireResult {
  value: unknown;
  isError: boolean;
}

function isWireResult(value: unknown): value is WireResult {
  return value !== null && typeof value === 'object' && 'value' in value && 'isError' in value;
}

interface WireRejection {
  error: { code?: string; message: string };
}

function isWireRejection(value: unknown): value is WireRejection {
  if (value === null || typeof value !== 'object') return false;
  const error = (value as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return false;
  return typeof (error as Record<string, unknown>).message === 'string';
}

/**
 * 只有这两种错误码意味着"那头真的没有 daemon 在监听"：ENOENT 是 unix socket
 * 文件不存在，ECONNREFUSED 是 TCP 端口没人监听。别的错误（EMFILE、EACCES、
 * ENFILE……）不能证明 daemon 已经不在了——清空端点文件反而可能把一个活的
 * daemon 变成孤儿：它还在跑、还握着已登录的 iCloud 会话，只是这一次连接因为
 * 别的原因没打通。导出它是因为这正是这个判断本身最该被单独钉住的地方——
 * 见 tests/unit/cli/client.test.ts 的 N-6 守卫。
 */
export function isDaemonAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

type ConnectAttempt = { socket: net.Socket } | { absent: boolean };

/**
 * 打开一条到 daemon 的连接。三种结果：拿到 socket；确认那头没有 daemon
 * （`absent: true`，安全清理端点文件）；别的连接失败或超时（`absent: false`，
 * 不清理——daemon 本身可能还活着，只是这一次没打通）。
 */
function connect(endpoint: Endpoint, timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Promise<ConnectAttempt> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    try {
      socket = endpoint.kind === 'unix' ? net.connect(endpoint.path) : net.connect(endpoint.port, '127.0.0.1');
    } catch {
      // 端点文件里的端口越界（比如被手改或损坏成 70000）会让 net.connect
      // 同步抛出 ERR_SOCKET_BAD_PORT，而不是走一贯的异步 'error' 事件。把这种
      // "端点文件本身不可用"也当作"没有 daemon"处理——它和真的没人监听
      // 一样，都该被清理掉，不清理的话每条命令都会在这里重新炸一次。
      resolve({ absent: true });
      return;
    }

    let settled = false;
    const finish = (result: ConnectAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      socket.destroy();
      // 连接建立本身超时：不确定那头是不是真的没有 daemon（可能只是慢），
      // 保守起见不清理端点文件。
      finish({ absent: false });
    }, timeoutMs);

    const onError = (err: unknown): void => {
      finish({ absent: isDaemonAbsent(err) });
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      finish({ socket });
    });
  });
}

export type RoundTripOutcome =
  | { kind: 'ok'; value: WireResult }
  /** daemon 主动拒绝了这次请求（比如令牌不对），而且这个拒绝发生在它调用
   *  任何工具之前——协议上保证了这一点：daemon 侧的拒绝分支永远先于
   *  `handleRequest`。所以这是唯一一种"请求字节已经写出去、但我们确定
   *  它没有被执行"的情况，必须报成一个清楚的错误，既不能悄悄回退（会把
   *  一个坏令牌的问题吞掉），也不能报成"可能已经执行"（吓唬调用方，还是
   *  错的）。 */
  | { kind: 'rejected'; message: string }
  /** 写完请求之后，没能拿到一个可解读的响应（连接被重置、超时、内容解析
   *  不出来……）。TCP 不会把"对面到底收没收到"这件事回传给我们，所以这里
   *  必须假定"可能已经执行"——对 mail_send 这类写操作，往另一个方向猜错
   *  的代价是发两遍，往这个方向猜错的代价只是多报一次错误。没有"请求字节
   *  从未真正发出去"这一档：一旦调用了 socket.write，往下的任何失败都只能
   *  落在这一种里，见 `roundTrip` 里 `wroteRequest` 那行的注释。 */
  | { kind: 'sent-unknown' };

/**
 * 发一行请求，读回第一行响应，然后主动结束连接。
 *
 * 只有建连接（`connect`）这一步有超时——那一步失败可以安全地退回一次性
 * 模式。请求字节一旦写出去，这里不设总时长上限：daemon 处理一次
 * `contacts_search`（首次全量拉取通讯录）或一次大 `mail_search` 完全可能
 * 超过任何合理的固定预算，而按 F-4 的规则，写出去之后的每一次超时都会变成
 * 一次不可恢复的"可能已执行"错误——一个慢但健康的调用因此被这里的超时
 * 冒充成了失败，daemon 路径反而比它要取代的一次性模式更差。`timeoutMs`
 * 仍然是个参数，但只给测试用：不传（生产路径的调用方式）就是永不超时。
 */
// 导出仅供测试直接驱动：要证明“不传 timeoutMs 时真的一个 setTimeout 都不会安”，需要直接监听全局 setTimeout，不能只依靠真实网络连接的行为推断。
export function roundTrip(socket: net.Socket, payload: unknown, timeoutMs?: number): Promise<RoundTripOutcome> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: RoundTripOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish({ kind: 'sent-unknown' }), timeoutMs);
    }

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf(NEWLINE);
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish({ kind: 'sent-unknown' });
        return;
      }
      if (isWireResult(parsed)) {
        finish({ kind: 'ok', value: parsed });
        return;
      }
      if (isWireRejection(parsed)) {
        finish({ kind: 'rejected', message: parsed.error.message });
        return;
      }
      finish({ kind: 'sent-unknown' });
    });
    socket.once('error', () => finish({ kind: 'sent-unknown' }));
    socket.once('close', () => finish({ kind: 'sent-unknown' }));

    // 写这一行调用本身就是"字节已经离开我们这边"的分界线——之后任何失败
    // 都进 sent-unknown，不再区分"到底有没有写成功"：TCP write 的回调只
    // 保证数据交给了内核缓冲区，不保证对面收到过，这里没有比"写出去了没有"
    // 更强的信号可用。
    socket.write(JSON.stringify(payload) + NEWLINE);
  });
}

/**
 * 连守护进程执行；连不上返回 undefined，由调用方退回一次性模式——但仅限于
 * "从未真正发出请求"的那些情况（读不到端点文件、连接失败/超时）。请求字节
 * 一旦写出去，这里绝不返回 undefined：daemon 主动拒绝（`rejected`）会抛一个
 * 认证错误，写出去之后失去响应（`sent-unknown`）会抛一个"可能已执行"的
 * 错误——两者都必须由调用方当作一次失败处理，不能被 `runCliDaemonFirst`
 * 悄悄接住再跑一次一次性模式。
 *
 * 连接失败时只在能确认"那头真的没有 daemon"（`ENOENT`/`ECONNREFUSED`）才
 * 清理端点文件：不清理的话，之后每条命令都要先经历一次连接失败才肯退回
 * 一次性模式，用户体验是"命令行变慢了"，却没有任何线索指向原因；但别的
 * 连接失败（`EMFILE` 等）清理端点文件则可能把一个活的 daemon 变成孤儿。
 */
export async function callDaemon(
  req: CallRequest,
  files?: EndpointFiles,
  timeouts?: ClientTimeouts,
): Promise<ExecuteResult | undefined> {
  const f = files ?? endpointFiles();
  const endpoint = await readEndpoint(f);
  if (!endpoint) return undefined;

  const attempt = await connect(endpoint, timeouts?.connectMs);
  if (!('socket' in attempt)) {
    if (attempt.absent) await clearEndpoint(f);
    return undefined;
  }

  const wire: Record<string, unknown> = { tool: req.tool, args: req.args };
  if (endpoint.kind === 'tcp') wire.token = endpoint.token;

  const outcome = await roundTrip(attempt.socket, wire, timeouts?.roundTripMs);
  if (outcome.kind === 'ok') {
    return { value: outcome.value.value, isError: outcome.value.isError };
  }
  if (outcome.kind === 'rejected') {
    throw new AppError('AUTH_FAILED', `守护进程拒绝了这次请求：${outcome.message}`, {
      hint: '守护进程可能已经重启、令牌已经失效；用 cli stop 再 cli start 换一个新的守护进程',
      retryable: false,
    });
  }
  // outcome.kind === 'sent-unknown'
  throw new AppError('UPSTREAM_ERROR', `工具 ${req.tool} 已经发给守护进程，但没能确认执行结果`, {
    hint: '守护进程可能已经执行了这次调用；请自行核实结果（例如用 mail_search 确认邮件是否已发出），不要直接重跑写操作',
    retryable: false,
  });
}

/** 让守护进程主动退出；没有守护进程在跑时返回 false，且顺手清掉僵死端点文件。 */
export async function stopDaemon(files?: EndpointFiles, timeouts?: ClientTimeouts): Promise<boolean> {
  const f = files ?? endpointFiles();
  const endpoint = await readEndpoint(f);
  if (!endpoint) return false;

  const attempt = await connect(endpoint, timeouts?.connectMs);
  if (!('socket' in attempt)) {
    if (attempt.absent) await clearEndpoint(f);
    return false;
  }

  const wire: Record<string, unknown> = { tool: DAEMON_STOP_COMMAND, args: {} };
  if (endpoint.kind === 'tcp') wire.token = endpoint.token;

  const outcome = await roundTrip(attempt.socket, wire, timeouts?.roundTripMs);
  return outcome.kind === 'ok' && outcome.value.isError === false;
}

/**
 * 轮询直到端点文件描述的地址真的能连上，而不只是"文件存在"。这两者之间
 * 有一条真实的缝隙：一个僵死端点文件（上个 daemon 被 kill 或崩溃后留下的）
 * 从进程启动那一刻就"存在"，但连不上；`cli start` 的调用方（比如一个 routine
 * 写的 `cli start && cli mail_search`）如果只等文件出现，`mail_search` 就可能
 * 在 daemon 真正开始监听之前抢跑，落回一次性模式——完全没有症状，用户以为
 * 自己在复用会话，实际上每次都在重新握手登录。超时后返回 undefined，调用方
 * 自己决定报错还是回退。
 */
export async function waitForDaemonReady(
  files?: EndpointFiles,
  timeoutMs = 5_000,
  connectTimeoutMs?: number,
): Promise<Endpoint | undefined> {
  const f = files ?? endpointFiles();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const endpoint = await readEndpoint(f);
    if (endpoint) {
      const attempt = await connect(endpoint, connectTimeoutMs);
      if ('socket' in attempt) {
        attempt.socket.destroy();
        return endpoint;
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
