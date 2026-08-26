import net from 'node:net';
import { clearEndpoint, DAEMON_STOP_COMMAND, endpointFiles, readEndpoint } from './transport.js';
import type { EndpointFiles, Endpoint } from './transport.js';
import type { ExecuteResult } from './execute.js';

const NEWLINE = String.fromCharCode(10);

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

/** 打开一条到 daemon 的连接；连不上时返回 undefined，而不是抛出。 */
function connect(endpoint: Endpoint): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = endpoint.kind === 'unix' ? net.connect(endpoint.path) : net.connect(endpoint.port, '127.0.0.1');
    const onError = (): void => {
      socket.destroy();
      resolve(undefined);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

/** 发一行请求，读回第一行响应，然后主动结束连接。 */
function roundTrip(socket: net.Socket, payload: unknown): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;

    const finish = (value: unknown | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf(NEWLINE);
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      try {
        finish(JSON.parse(line));
      } catch {
        finish(undefined);
      }
    });
    socket.once('error', () => finish(undefined));
    // 服务端在没有文件权限可依赖的 TCP 路径上，对坏令牌的响应就是直接
    // destroy 连接、什么都不写——这里必须把"连接被对端关闭且什么都没收到"
    // 也当成一次已完成（但内容为空）的往返，不能让调用方一直挂着。
    socket.once('close', () => finish(undefined));

    socket.write(JSON.stringify(payload) + NEWLINE);
  });
}

/**
 * 连守护进程执行；连不上返回 undefined，由调用方退回一次性模式。
 *
 * 连接失败（守护进程没跑，或者端点文件描述的监听早已不在——被 kill 或沙盒
 * 重启后常有的情形）时清理端点文件：不清理的话，之后每条命令都要先经历一次
 * 连接失败才肯退回一次性模式，用户体验是"命令行变慢了"，却没有任何线索指向原因。
 */
export async function callDaemon(req: CallRequest, files?: EndpointFiles): Promise<ExecuteResult | undefined> {
  const f = files ?? endpointFiles();
  const endpoint = await readEndpoint(f);
  if (!endpoint) return undefined;

  const socket = await connect(endpoint);
  if (!socket) {
    await clearEndpoint(f);
    return undefined;
  }

  const wire: Record<string, unknown> = { tool: req.tool, args: req.args };
  if (endpoint.kind === 'tcp') wire.token = endpoint.token;

  const response = await roundTrip(socket, wire);
  if (isWireResult(response)) {
    return { value: response.value, isError: response.isError };
  }
  // 协议层错误（daemon 解析不了请求）或连接被直接断开（比如令牌校验没过）：
  // 对 callDaemon 的调用方而言两者都不是"拿到了一个可用结果"，一律当作
  // 守护进程不可用处理，而不是伪造一个成功值。
  return undefined;
}

/** 让守护进程主动退出；没有守护进程在跑时返回 false，且顺手清掉僵死端点文件。 */
export async function stopDaemon(files?: EndpointFiles): Promise<boolean> {
  const f = files ?? endpointFiles();
  const endpoint = await readEndpoint(f);
  if (!endpoint) return false;

  const socket = await connect(endpoint);
  if (!socket) {
    await clearEndpoint(f);
    return false;
  }

  const wire: Record<string, unknown> = { tool: DAEMON_STOP_COMMAND, args: {} };
  if (endpoint.kind === 'tcp') wire.token = endpoint.token;

  const response = await roundTrip(socket, wire);
  return isWireResult(response) && response.isError === false;
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
      const socket = await connect(endpoint);
      if (socket) {
        socket.destroy();
        return endpoint;
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
