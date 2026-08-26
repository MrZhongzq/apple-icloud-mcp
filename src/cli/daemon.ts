import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chmodSync, unlinkSync } from 'node:fs';
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
  generateToken,
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
 * 常驻进程：会话在启动时建一次，所有请求复用——省下的是每条命令都要重做的
 * TCP+TLS+AUTH 握手，不只是几次登录验证。
 *
 * 协议是换行分隔的单行 JSON：请求 `{ token?, tool, args }`，成功/工具失败都回
 * `{ value, isError }`（与 `ExecuteResult` 同形状），daemon 自己都解析不了的
 * 请求才回 `{ error }`。用换行分隔而不是长度前缀，是因为调试时能直接 `nc` 上去看。
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
}): Promise<DaemonHandle> {
  const { config, logger } = deps;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const files = deps.files ?? endpointFiles();

  await mkdir(join(files.infoPath, '..'), { recursive: true });

  const sessions = createSessionStore({
    ttlMs: config.sessionTtlMs,
    providerFactory: (account) => createProviders(account, { logger, imapIdleTimeoutMs: config.imapIdleTimeoutMs }),
  });
  const tools = listCliTools(collectTools({ config, sessions, logger }));
  const account = findAccount(config);
  const session = sessions.create(account);

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

  async function handleRequest(req: WireRequest): Promise<{ value: unknown; isError: boolean }> {
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
    resetIdle();
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf(NEWLINE);
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf(NEWLINE);
        if (line.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          writeLine(socket, { error: { message: '请求不是合法 JSON' } });
          continue;
        }
        if (!isWireRequest(parsed)) {
          writeLine(socket, { error: { message: '请求缺少 tool 字段' } });
          continue;
        }

        // TCP 路径没有文件权限可依赖：令牌不对（或没带）立刻断开，不回任何数据——
        // 会话背后是一个已登录的 iCloud 连接，宁可什么都不说也不能给探测者留信息。
        if (usesToken && parsed.token !== token) {
          socket.destroy();
          return;
        }

        resetIdle();

        // stopDaemon 的信使：不查工具表，回一个成功响应后立刻关停。走同一条
        // token 校验（上面那行），所以 TCP 模式下拿不到令牌的人也停不了 daemon。
        if (parsed.tool === DAEMON_STOP_COMMAND) {
          writeLine(socket, { value: { stopped: true }, isError: false });
          socket.end();
          void shutdown();
          return;
        }

        // 协议是一条连接一问一答：`callDaemon` 每次调用都开一条新连接，写一行、
        // 读一行就 destroy。这里写完响应后主动 `end`，而不是把 socket 留着等
        // 下一行——留着的话，客户端在拿到数据后不主动关闭连接的写法（比如鉴别性
        // 实验里直接拿 `net` 探测的测试）就会一直挂到自己的超时兜底，看不出协议
        // 层面到底有没有真的拒绝掉这次请求。
        void handleRequest(parsed).then((res) => {
          writeLine(socket, res);
          socket.end();
        });
      }
    });
    socket.on('error', () => undefined);
  });

  let endpoint: Endpoint;
  const useUnix = !usesToken;

  if (useUnix) {
    try {
      unlinkSync(files.socketPath);
    } catch {
      // 没有残留 socket 文件，正常情况
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(files.socketPath, resolve);
    });
    // listen 之后必须立刻 chmod：Node 建出来的 unix socket 默认 755/775，谁都能连，
    // 而它后面挂着一个已登录、握着用户 iCloud 连接的会话。
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

  await writeEndpoint(files, endpoint);
  resetIdle();

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sessions.destroy(session.id).catch(() => undefined);
    await clearEndpoint(files);
  }

  return { endpoint, close: shutdown };
}
