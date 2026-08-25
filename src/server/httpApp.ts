import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from './createServer.js';
import type { AppConfig, HttpConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { SessionStore } from '../core/session.js';
import type { AppleOAuthProvider } from '../auth/provider.js';
import { createPendingStore, handleLoginSubmit, renderLoginPage, type PendingStore } from '../auth/login.js';

export interface CreateHttpAppDeps {
  config: AppConfig;
  httpConfig: HttpConfig;
  sessions: SessionStore;
  provider: AppleOAuthProvider;
  logger: Logger;
  /**
   * `authorize()`（provider.ts，任务四）把待授权请求暂存在这里，`/admin-login` 提交时凭
   * requestId 取回并消费。这个 store 必须与构建 `provider` 时传给 `createOAuthProvider`
   * 的是同一个实例——否则登录页永远找不到 authorize() 存下的请求。不传时本地新建一个，
   * 只是为了让单测不必关心登录页这条链路；生产环境（`bin/http.ts`）必须显式传入同一份。
   */
  pending?: PendingStore;
}

export interface HttpApp {
  app: Express;
  /** 优雅关闭时调用：关闭 Map 里全部 transport（不关 HTTP server 本身，那个由调用方持有）。 */
  closeAll: () => Promise<void>;
}

const ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const ADMIN_LOGIN_RATE_LIMIT_MAX = 20;

/** 极简滑动窗口限流：单进程内存足够——管理员登录只有一个人在用。
 *  周期性清掉早已过期的桶，避免不同源 IP 造成 Map 无限增长。 */
function createSimpleRateLimit(opts: { windowMs: number; max: number }) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // 顺手清理过期桶，管理员登录场景请求量极低，这里的开销可以忽略
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }

    const key = req.ip ?? 'unknown';
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    if (bucket.count >= opts.max) {
      res.set('Cache-Control', 'no-store');
      res.status(429).send('登录尝试过于频繁，请稍后再试');
      return;
    }
    bucket.count += 1;
    next();
  };
}

/** 只放行 PUBLIC_URL 的来源与 https://claude.ai——绝不用 `origin: true` 反射任意来源。 */
function createCorsMiddleware(allowedOrigins: ReadonlySet<string>) {
  const allowedHeaders = ['Authorization', 'Content-Type', 'mcp-session-id', 'mcp-protocol-version', 'Last-Event-ID'].join(
    ', ',
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', allowedHeaders);
      res.status(204).end();
      return;
    }
    next();
  };
}

interface McpEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** v1 的头号缺陷：一个模块级 transport 变量，第二个客户端接入直接顶掉第一个。
 *  这里以 MCP 会话 ID 为键维护每个客户端各自的 transport + McpServer。 */
function createMcpRouteHandler(deps: { config: AppConfig; sessions: SessionStore; logger: Logger }) {
  const entries = new Map<string, McpEntry>();

  async function closeAll(): Promise<void> {
    const all = [...entries.values()];
    entries.clear();
    await Promise.all(
      all.map((entry) =>
        entry.transport.close().catch((err: unknown) => {
          deps.logger.warn('failed to close mcp transport during shutdown', {
            detail: err instanceof Error ? err.name : typeof err,
          });
        }),
      ),
    );
  }

  async function handler(req: Request, res: Response): Promise<void> {
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

    let entry = sessionId !== undefined ? entries.get(sessionId) : undefined;

    if (!entry) {
      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        const mcpServer = createServer({ config: deps.config, sessions: deps.sessions, logger: deps.logger });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            entries.set(newSessionId, { transport, server: mcpServer });
          },
        });
        // 断开的客户端必须从 Map 里摘掉，否则永远留在表里
        transport.onclose = () => {
          const currentId = transport.sessionId;
          if (currentId !== undefined) entries.delete(currentId);
        };
        await mcpServer.connect(transport);
        entry = { transport, server: mcpServer };
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: 缺少 mcp-session-id，且不是 initialize 请求' },
          id: null,
        });
        return;
      }
    }

    await entry.transport.handleRequest(req, res, req.body);
  }

  return { handler, closeAll };
}

/** 把 provider.verifyAccessToken 包一层：任何失败都归一化成 InvalidTokenError（401）。
 *  真实 provider 已经只在校验失败时抛 InvalidTokenError，这里是纵深防御——校验链路上任何
 *  非预期错误都必须 fail closed 成"未授权"，而不是把 500 和内部错误细节暴露给这个公网端点。
 *  也绝不把原始错误消息回显：统一用固定文案，避免任何途径把令牌或内部状态带出去。 */
function createVerifier(provider: AppleOAuthProvider): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string) {
      try {
        return await provider.verifyAccessToken(token);
      } catch (err) {
        if (err instanceof InvalidTokenError) throw err;
        // 这条消息会被 SDK 原样塞进 WWW-Authenticate 响应头；HTTP 头值必须是 ASCII，
        // 中文字符会让 Node 的 setHeader 直接抛 TypeError（Invalid character in header
        // content），把一次"未授权"错误变成一次货真价实的 500。英文文案不是风格选择。
        throw new InvalidTokenError('access token invalid');
      }
    },
  };
}

function createHealthHandler() {
  // 健康检查端点在认证之前，任何能连到端口的人都能看到它的应答。
  // 因此只回一个不能再少的常量——不带版本号、账号数、会话数：公开端点说的每一句话
  // 都是在对扫描者说。
  return (_req: Request, res: Response): void => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok' });
  };
}

function createAdminLoginHandler(deps: {
  adminPasswordHash: string;
  provider: AppleOAuthProvider;
  logger: Logger;
  pending: PendingStore;
}) {
  return (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const result = handleLoginSubmit(deps, { requestId, password });

    res.set('Cache-Control', 'no-store');
    if ('redirectTo' in result) {
      res.redirect(303, result.redirectTo);
      return;
    }
    res.status(401).send(renderLoginPage({ requestId, error: result.error }));
  };
}

/** 建好但未监听的 express 应用，便于单测直接打请求而不占端口。 */
export function createHttpApp(deps: CreateHttpAppDeps): HttpApp {
  const { config, httpConfig, sessions, provider, logger } = deps;
  const pending = deps.pending ?? createPendingStore();

  const app = express();
  // 反向代理场景下 X-Forwarded-For 才有意义；本任务不假设有代理，
  // 保守起见不启用 trust proxy，req.ip 退回 socket 的远端地址。

  const allowedOrigins = new Set<string>([httpConfig.publicUrl.origin, 'https://claude.ai']);

  app.use(createCorsMiddleware(allowedOrigins));

  // 必须挂在 mcpAuthRouter 之前：express 的 router.use(path) 按前缀匹配、先注册者先命中。
  // 登录表单曾经误投到 /authorize——那正是 mcpAuthRouter 自己的授权端点，POST 到那里会被
  // 当成一个缺 client_id/code_challenge 的授权请求直接拒绝。/admin-login 是独立路径，
  // 不会撞车，但仍然按"先注册"的顺序放在最前面，不给以后的路由改动留下误伤的机会。
  app.post(
    '/admin-login',
    createSimpleRateLimit({ windowMs: ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, max: ADMIN_LOGIN_RATE_LIMIT_MAX }),
    express.urlencoded({ extended: false }),
    createAdminLoginHandler({ adminPasswordHash: httpConfig.adminPasswordHash, provider, logger, pending }),
  );

  // /.well-known/*、/authorize、/token、/register、/revoke
  app.use(mcpAuthRouter({ provider, issuerUrl: httpConfig.publicUrl }));

  // 认证之前：谁都能问，所以什么都不说
  app.get('/health', createHealthHandler());

  const { handler: mcpHandler, closeAll } = createMcpRouteHandler({ config, sessions, logger });
  const verifier = createVerifier(provider);

  app.use('/mcp', express.json());
  // 这一行是整个文件最重要的一行：requireBearerAuth 必须在 mcpHandler 之前。
  // 顺序弄反，之前五个任务做的全部防护形同虚设——见下方的鉴别性实验。
  app.all('/mcp', requireBearerAuth({ verifier }), (req: Request, res: Response) => {
    mcpHandler(req, res).catch((err: unknown) => {
      logger.error('mcp request handling failed', {
        detail: err instanceof Error ? err.name : typeof err,
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: '服务内部错误' },
          id: null,
        });
      }
    });
  });

  return { app, closeAll };
}
