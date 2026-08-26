import net from 'node:net';
import { clearEndpoint, DAEMON_STOP_COMMAND, endpointFiles, readEndpoint } from './transport.js';
import type { EndpointFiles, Endpoint } from './transport.js';
import type { ExecuteResult } from './execute.js';
import { AppError } from '../core/errors.js';

const NEWLINE = String.fromCharCode(10);
/** 连接和往返各自的上限；daemon 卡死（比如挂在一次半死的 IMAP 调用里）不该
 *  让 CLI 挂到天荒地老——一次性模式好歹继承了各 provider 自己的超时。 */
const CONNECT_TIMEOUT_MS = 3_000;
const ROUND_TRIP_TIMEOUT_MS = 10_000;

export interface CallRequest {
  tool: string;
  args: Record<string, unknown>;
}

interface WireResult {
  value: unknown;
  isError: boolean;
}

function isWireResult(value: unknown): value is WireResult {
  return value !== null && typeof value === 'object' && 'value' in value && 'isError' in value;
}

/**
 * 只有这两种错误码意味着"那头真的没有 daemon 在监听"：ENOENT 是 unix socket
 * 文件不存在，ECONNREFUSED 是 TCP 端口没人监听。别的错误（EMFILE、EACCES、
 * ENFILE……）不能证明 daemon 已经不在了——清空端点文件反而可能把一个活的
 * daemon 变成孤儿：它还在跑、还握着已登录的 iCloud 会话，只是这一次连接因为
 * 别的原因没打通。
 */
function isDaemonAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

type ConnectAttempt = { socket: net.Socket } | { absent: boolean };

/**
 * 打开一条到 daemon 的连接。三种结果：拿到 socket；确认那头没有 daemon
 * （`absent: true`，安全清理端点文件）；别的连接失败或超时（`absent: false`，
 * 不清理——daemon 本身可能还活着，只是这一次没打通）。
 */
function connect(endpoint: Endpoint): Promise<ConnectAttempt> {
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
    }, CONNECT_TIMEOUT_MS);

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

type RoundTripOutcome =
  | { kind: 'ok'; value: unknown }
  /** 连上了、但没能拿到一个可用的响应，而且请求字节从未真正发出去（比如
   *  socket 一连上就被令牌校验 destroy）——这种情况和"根本没连上"一样安全，
   *  可以退回一次性模式重试。 */
  | { kind: 'no-response' }
  /** 请求已经写给 daemon 之后才失败：daemon 可能已经真的执行了这次调用。
   *  绝不能被当成"安全重试"的信号——对 mail_send 这类写操作，重试意味着
   *  发两遍。调用方必须把这当错误报给用户，而不是悄悄再跑一次一次性模式。 */
  | { kind: 'sent-unknown' };

/** 发一行请求，读回第一行响应，然后主动结束连接；全程有超时。 */
function roundTrip(socket: net.Socket, payload: unknown): Promise<RoundTripOutcome> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    let wroteRequest = false;

    const finish = (outcome: RoundTripOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    // 一旦真的发起了写，就不再区分"到底有没有真的送到对面"——TCP 不会把这个
    // 保证交回给调用者，往这个方向猜错的代价（一次不必要的报错）远小于往
    // 另一个方向猜错的代价（mail_send 发两遍）。
    const unknownAfterWrite = (): RoundTripOutcome => (wroteRequest ? { kind: 'sent-unknown' } : { kind: 'no-response' });

    const timer = setTimeout(() => finish(unknownAfterWrite()), ROUND_TRIP_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf(NEWLINE);
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      try {
        finish({ kind: 'ok', value: JSON.parse(line) });
      } catch {
        finish(unknownAfterWrite());
      }
    });
    socket.once('error', () => finish(unknownAfterWrite()));
    // 服务端在没有文件权限可依赖的 TCP 路径上，对坏令牌的响应就是直接
    // destroy 连接、什么都不写——这里必须把"连接被对端关闭且什么都没收到"
    // 也当成一次已完成的往返，不能让调用方一直挂着。
    socket.once('close', () => finish(unknownAfterWrite()));

    wroteRequest = true;
    socket.write(JSON.stringify(payload) + NEWLINE);
  });
}

/**
 * 连守护进程执行；连不上返回 undefined，由调用方退回一次性模式。请求已经
 * 写出去之后才失败的情况不会走这条"安全重试"的路径——见 `RoundTripOutcome`
 * 上的注释——而是抛出，调用方必须把它当一次失败报给用户，不能悄悄重跑。
 *
 * 连接失败时只在能确认"那头真的没有 daemon"（`ENOENT`/`ECONNREFUSED`）才
 * 清理端点文件：不清理的话，之后每条命令都要先经历一次连接失败才肯退回
 * 一次性模式，用户体验是"命令行变慢了"，却没有任何线索指向原因；但别的
 * 连接失败（`EMFILE` 等）清理端点文件则可能把一个活的 daemon 变成孤儿。
 */
export async function callDaemon(req: CallRequest, files?: EndpointFiles): Promise<ExecuteResult | undefined> {
  const f = files ?? endpointFiles();
  const endpoint = await readEndpoint(f);
  if (!endpoint) return undefined;

  const attempt = await connect(endpoint);
  if (!('socket' in attempt)) {
    if (attempt.absent) await clearEndpoint(f);
    return undefined;
  }

  const wire: Record<string, unknown> = { tool: req.tool, args: req.args };
  if (endpoint.kind === 'tcp') wire.token = endpoint.token;

  const outcome = await roundTrip(attempt.socket, wire);
  if (outcome.kind === 'ok' && isWireResult(outcome.value)) {
    return { value: outcome.value.value, isError: outcome.value.isError };
  }
  if (outcome.kind === 'sent-unknown') {
    throw new AppError('UPSTREAM_ERROR', `工具 ${req.tool} 已经发给守护进程，但没能确认执行结果`, {
      hint: '守护进程可能已经执行了这次调用；请自行核实结果（例如用 mail_search 确认邮件是否已发出），不要直接重跑写操作',
      retryable: false,
    });
  }
  // outcome.kind === 'no-response'，或收到的数据不是预期的 { value, isError }
  // 形状：请求从未真正发出去（比如刚连上就被令牌校验 destroy），对调用方
  // 而言和"没连上"是一回事，可以安全退回一次性模式。
  return undefined;
}

/** 让守护进程主动退出；没有守护进程在跑时返回 false，且顺手清掉僵死端点文件。 */
export async function stopDaemon(files?: EndpointFiles): Promise<boolean> {
  const f = files ?? endpointFiles();
  const endpoint = await readEndpoint(f);
  if (!endpoint) return false;

  const attempt = await connect(endpoint);
  if (!('socket' in attempt)) {
    if (attempt.absent) await clearEndpoint(f);
    return false;
  }

  const wire: Record<string, unknown> = { tool: DAEMON_STOP_COMMAND, args: {} };
  if (endpoint.kind === 'tcp') wire.token = endpoint.token;

  const outcome = await roundTrip(attempt.socket, wire);
  return outcome.kind === 'ok' && isWireResult(outcome.value) && outcome.value.isError === false;
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
export async function waitForDaemonReady(files?: EndpointFiles, timeoutMs = 5_000): Promise<Endpoint | undefined> {
  const f = files ?? endpointFiles();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const endpoint = await readEndpoint(f);
    if (endpoint) {
      const attempt = await connect(endpoint);
      if ('socket' in attempt) {
        attempt.socket.destroy();
        return endpoint;
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
