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
import type { AccountConfig, AppConfig, HttpConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { accessKeyIdFrom, type SessionStore } from '../core/session.js';
import type { AppleOAuthProvider } from '../auth/provider.js';
import type { AuthStore } from '../auth/store.js';
import {
  applyLoginPageHeaders,
  createPendingStore,
  handleLoginSubmit,
  renderAlreadyCompletedPage,
  renderLoginPage,
  type PendingStore,
} from '../auth/login.js';
import { createAdminRouter } from './admin.js';
import {
  ACCESS_LOGIN_RATE_LIMIT_MAX,
  ACCESS_LOGIN_RATE_LIMIT_WINDOW_MS,
  createSimpleRateLimit,
} from './rateLimit.js';

export interface CreateHttpAppDeps {
  config: AppConfig;
  httpConfig: HttpConfig;
  sessions: SessionStore;
  provider: AppleOAuthProvider;
  logger: Logger;
  /**
   * `/access-login` 凭它按明文查访问密钥；`apple_login` 每次现读它的 env 账号开关；切断一把
   * 密钥时用它吊销该密钥名下的令牌。生产环境传的就是构建 `provider` 用的同一个 store。
   */
  store: AuthStore;
  /** 信封登录：服务端公钥文本与解信封的函数。没有配置信封私钥时不传，`apple_login` 也就没有 `envelope` 参数。 */
  envelope?: { publicKeyText: string; open: (text: string) => { account: AccountConfig; notices: string[] } };
  /**
   * `authorize()`（provider.ts，任务四）把待授权请求暂存在这里，`/access-login` 提交时凭
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
  /** 周期性调用：关闭并摘掉空闲超过会话 TTL 的 transport，返回清理条数。
   *  `now` 只为测试留的注入点（与 SessionStore 的 `now`、AuthStore 的 `sweep(now)` 同一路数），
   *  生产调用方不传。 */
  sweepIdleTransports: (now?: number) => Promise<number>;
  /**
   * 切断一把访问密钥（管理页停用或删除它时调用）：吊销它名下全部令牌 → 销毁它建立的全部
   * iCloud 会话（关闭底层连接）→ 关掉它名下的 MCP transport。三步缺一不可：只吊销令牌，
   * 会话要等 TTL 才过期；只销毁会话，令牌还能再登录；不关 transport，表里留着一条没人能用的连接。
   */
  cutOffAccessKey: (keyId: string) => Promise<void>;
  /** 管理页关掉 env 账号开关之后调用：销毁所有用 env 账号（不是信封）建立的会话。 */
  onEnvAccountsDisabled: () => Promise<void>;
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
  /** 最后一次经过这条 transport 的请求时刻；空闲清理按它判断。 */
  lastActiveAt: number;
  /** 发起 initialize 的访问密钥 id。之后的请求只要不是这把密钥发来的，就当这条 transport 不存在。 */
  ownerKeyId?: string;
}

/** v1 的头号缺陷：一个模块级 transport 变量，第二个客户端接入直接顶掉第一个。
 *  这里以 MCP 会话 ID 为键维护每个客户端各自的 transport + McpServer。 */
function createMcpRouteHandler(deps: {
  config: AppConfig;
  sessions: SessionStore;
  logger: Logger;
  store: AuthStore;
  envelope?: CreateHttpAppDeps['envelope'];
}) {
  const entries = new Map<string, McpEntry>();
  /** 复用会话 TTL，不另立一个旋钮：这张表里的每一项本来就对应"一个还在用的客户端"，
   *  判断它是否还在用的标准与 SessionStore 判断会话是否还活着的标准应当是同一个。 */
  const idleTtlMs = deps.config.sessionTtlMs;

  /**
   * 这张表原先只增不减：`initialize` 往里放，只有 `transport.onclose` 会摘掉。可 onclose
   * 只在客户端老老实实发了 DELETE 或连接被正常关闭时才触发——一个直接断线重连的客户端，
   * 每重连一次就留下一个 transport 加一个 McpServer，一直留到进程退出。
   */
  async function sweepIdleTransports(now: number = Date.now()): Promise<number> {
    const stale = [...entries.entries()].filter(([, entry]) => now - entry.lastActiveAt > idleTtlMs);
    for (const [id] of stale) entries.delete(id);
    await Promise.all(
      stale.map(([, entry]) =>
        // close() 会再触发一次 onclose，那里的 delete 已经无事可做——幂等，不是重复清理。
        entry.transport.close().catch((err: unknown) => {
          deps.logger.warn('failed to close an idle mcp transport', {
            detail: err instanceof Error ? err.name : typeof err,
          });
        }),
      ),
    );
    if (stale.length > 0) deps.logger.debug('swept idle mcp transports', { removed: stale.length });
    return stale.length;
  }

  /** 关掉某把密钥名下的全部 transport 并从表里摘掉，返回关闭条数。 */
  async function closeTransportsOwnedBy(keyId: string): Promise<number> {
    const owned = [...entries.entries()].filter(([, entry]) => entry.ownerKeyId === keyId);
    for (const [id] of owned) entries.delete(id);
    await Promise.all(
      owned.map(([, entry]) =>
        entry.transport.close().catch((err: unknown) => {
          deps.logger.warn('failed to close a cut-off mcp transport', {
            detail: err instanceof Error ? err.name : typeof err,
          });
        }),
      ),
    );
    return owned.length;
  }

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

    const callerKeyId = accessKeyIdFrom({ authInfo: req.auth });

    let entry = sessionId !== undefined ? entries.get(sessionId) : undefined;
    // 别人的 transport 按"找不到"处理，走下面同一个 400 分支：B 拿到 A 的 mcp-session-id 之后，
    // 既不能在上面发请求、挂 SSE 流，也不能 DELETE 掉它；响应与 id 不存在时逐字相同，
    // 不让 B 借此确认这个 id 是活的。iCloud 会话的归属仍然只在 SessionStore 里检查，这是另一层资源。
    if (entry && entry.ownerKeyId !== callerKeyId) entry = undefined;

    if (!entry) {
      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        const mcpServer = createServer({
          config: deps.config,
          sessions: deps.sessions,
          logger: deps.logger,
          // 远程入口的账号在登录时才出现（信封），注册阶段看不到能力，四个模块一律注册。
          registerAllModules: true,
          remote: {
            // 每次调用现读：管理页切换开关后不必重建任何 transport 就立刻生效。
            envAccountsEnabled: () => deps.store.getSettings().envAccountsEnabled,
            openEnvelope: deps.envelope?.open,
          },
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // 存进 Map 的必须是下面那个 newEntry 本身，不能另建一个同形状的对象字面量：
          // 两个对象的话，请求路径上刷新的 lastActiveAt 会写在其中一个上，清理器读的却是
          // 另一个，于是一条一直在用的 transport 会被当成空闲的关掉。
          onsessioninitialized: (newSessionId: string) => {
            entries.set(newSessionId, newEntry);
          },
        });
        // 断开的客户端必须从 Map 里摘掉，否则永远留在表里
        transport.onclose = () => {
          const currentId = transport.sessionId;
          if (currentId !== undefined) entries.delete(currentId);
        };
        const newEntry: McpEntry = {
          transport,
          server: mcpServer,
          lastActiveAt: Date.now(),
          ownerKeyId: callerKeyId,
        };
        await mcpServer.connect(transport);
        entry = newEntry;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: 缺少 mcp-session-id，且不是 initialize 请求' },
          id: null,
        });
        return;
      }
    }

    entry.lastActiveAt = Date.now();
    await entry.transport.handleRequest(req, res, req.body);
  }

  async function cutOffAccessKey(keyId: string): Promise<void> {
    // 顺序有讲究：先吊销令牌，已签发的令牌就再也建不出新会话和新 transport；然后才清掉已有的，
    // 免得刚清完又被一个还没吊销的令牌建出一条。（调用方此前已停用或删除这把密钥，
    // 它也换不到新令牌——那一半由 verifyAccessToken / /access-login 保证，不在这里。）
    //
    // 吊销是先改内存、再落盘。落盘抛错时令牌在内存里已经删掉了，可要是让这个错误直接冒出去，
    // 下面两步就被跳过：会话活到 TTL，transport 留在表里。所以先把清场做完，再把错误抛给调用方
    // （管理页因此回 500，主人知道没存上）。
    let families: string[] = [];
    let revokeFailed = false;
    let revokeError: unknown;
    try {
      families = await deps.store.revokeFamiliesByAccessKey(keyId);
    } catch (err) {
      revokeFailed = true;
      revokeError = err;
    }
    const destroyedSessions = await deps.sessions.destroyMatching((s) => s.ownerKeyId === keyId);
    const closedTransports = await closeTransportsOwnedBy(keyId);
    if (revokeFailed) {
      deps.logger.error('access key cut off, but persisting the token revocation failed', {
        destroyedSessions,
        closedTransports,
        detail: revokeError instanceof Error ? revokeError.name : typeof revokeError,
      });
      throw revokeError;
    }
    deps.logger.info('access key cut off', {
      revokedFamilies: families.length,
      destroyedSessions,
      closedTransports,
    });
  }

  async function onEnvAccountsDisabled(): Promise<void> {
    // origin 为 undefined 的是今天的 env 账号（loadConfig 建的），也要一起销毁：只放过明确来自信封的。
    const destroyed = await deps.sessions.destroyMatching((s) => s.account.origin !== 'envelope');
    deps.logger.info('env accounts disabled', { destroyedSessions: destroyed });
  }

  return { handler, closeAll, sweepIdleTransports, cutOffAccessKey, onEnvAccountsDisabled };
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

function createAccessLoginHandler(deps: {
  store: Pick<AuthStore, 'findAccessKeyByPlaintext'>;
  provider: AppleOAuthProvider;
  logger: Logger;
  pending: PendingStore;
}) {
  const { store, provider, logger, pending } = deps;
  const loginDeps = {
    findAccessKey: (plaintext: string) => store.findAccessKeyByPlaintext(plaintext),
    provider,
    logger,
    pending,
  };
  return (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const accessKey = typeof body.access_key === 'string' ? body.access_key : '';

    const result = handleLoginSubmit(loginDeps, { requestId, accessKey });

    applyLoginPageHeaders(res);
    if ('redirectTo' in result) {
      res.redirect(303, result.redirectTo);
      return;
    }
    if ('alreadyCompleted' in result) {
      // 同一张登录页又提交了一次（刷新、双击、回退重发）：授权其实已经成功，
      // 回 200 告诉人可以关掉，而不是一个让人以为失败了的 401。
      res.status(200).send(renderAlreadyCompletedPage());
      return;
    }
    res.status(401).send(renderLoginPage({ requestId, error: result.error }));
  };
}

/** 建好但未监听的 express 应用，便于单测直接打请求而不占端口。 */
export function createHttpApp(deps: CreateHttpAppDeps): HttpApp {
  const { config, httpConfig, sessions, provider, logger, store } = deps;
  const pending = deps.pending ?? createPendingStore();

  const app = express();
  // 限流按 req.ip 分桶，而 req.ip 是什么取决于这一行。
  //
  // 直接暴露端口时（TRUST_PROXY 未设，默认 false）不能信 X-Forwarded-For：那个头由调用方
  // 自己写，信它等于让任何人自选限流桶，一个客户端就能不限次数地猜访问密钥。
  //
  // 但本仓库自带的 docker-compose.yml 在前面放了 Caddy，那时每个请求的 socket 远端地址都是
  // 同一个容器 IP：不开这一行，全世界共用一个桶，任何未认证的访客都能把 /access-login 与
  // /token 的额度替所有人耗光，把整条授权流程锁死。所以 compose 里 TRUST_PROXY 是开着的。
  //
  // 两种部署都真实存在，谁在前面只有部署方知道，因此这件事由配置声明，不由代码猜。
  if (httpConfig.trustProxy) app.set('trust proxy', true);

  const allowedOrigins = new Set<string>([httpConfig.publicUrl.origin, 'https://claude.ai']);

  app.use(createCorsMiddleware(allowedOrigins));

  // 必须挂在 mcpAuthRouter 之前：express 的 router.use(path) 按前缀匹配、先注册者先命中。
  // 登录表单曾经误投到 /authorize——那正是 mcpAuthRouter 自己的授权端点，POST 到那里会被
  // 当成一个缺 client_id/code_challenge 的授权请求直接拒绝。/access-login 是独立路径，
  // 不会撞车，但仍然按"先注册"的顺序放在最前面，不给以后的路由改动留下误伤的机会。
  //
  // 这里收的是每人一把的访问密钥，不再是管理员口令：管理员口令只用于 /admin（管理页），
  // 授权页上提交它一律按「密钥不正确」处理。限流照旧——访问密钥是 32 字节随机数，猜不中，
  // 但限流防的不只是猜，也防有人拿这个端点刷请求。
  app.post(
    '/access-login',
    createSimpleRateLimit({ windowMs: ACCESS_LOGIN_RATE_LIMIT_WINDOW_MS, max: ACCESS_LOGIN_RATE_LIMIT_MAX }),
    express.urlencoded({ extended: false }),
    createAccessLoginHandler({ store, provider, logger, pending }),
  );

  const {
    handler: mcpHandler,
    closeAll,
    sweepIdleTransports,
    cutOffAccessKey,
    onEnvAccountsDisabled,
  } = createMcpRouteHandler({
    config,
    sessions,
    logger,
    store,
    envelope: deps.envelope,
  });

  // 管理页 /admin：同样挂在 mcpAuthRouter 之前，理由同上面 /access-login 那段。
  // 停用/删除密钥、关 env 开关要清掉的会话和 transport 都在上面这个闭包里，所以从这里传进去。
  app.use(
    createAdminRouter({
      adminPasswordHash: httpConfig.adminPasswordHash,
      store,
      publicUrl: httpConfig.publicUrl,
      logger,
      cutOffAccessKey,
      onEnvAccountsDisabled,
      envAccountCount: config.accounts.length,
      envelopePublicKey: deps.envelope?.publicKeyText,
    }),
  );

  // /.well-known/*、/authorize、/token、/register、/revoke
  app.use(mcpAuthRouter({ provider, issuerUrl: httpConfig.publicUrl }));

  // 认证之前：谁都能问，所以什么都不说
  app.get('/health', createHealthHandler());

  const verifier = createVerifier(provider);

  // 这一行是整个文件最重要的一行：requireBearerAuth 必须在 express.json() 之前，也在
  // mcpHandler 之前。顺序弄反有两层后果：一是之前五个任务做的全部认证防护形同虚设
  // ——见下方第一个鉴别性实验；二是未认证请求会先摸到 body 解析器，一个畸形 JSON body
  // 就能让 express.json() 抛出的 SyntaxError 一路冒到 Express 默认错误页，把绝对路径
  // 和堆栈发给一个从没证明过身份的调用方——这和 /health 只回 { status: 'ok' } 是同一条
  // 原则，只是从另一扇门泄漏。requireBearerAuth 挡在最前面，未认证请求根本碰不到
  // express.json()，这类请求体永远不会被解析。见下方第二个鉴别性实验。
  app.all('/mcp', requireBearerAuth({ verifier }), express.json(), (req: Request, res: Response) => {
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

  // 终态错误处理中间件：必须最后注册、四个参数（err, req, res, next）——这是 Express
  // 识别"这是错误处理器"的唯一方式，少一个参数就会被当成普通中间件而永远跳过。
  // 兜底任何没被各路由自己 catch 住的异常（body-parser 解析畸形请求体抛出的 SyntaxError
  // 是本轮修复的直接起因，但这道兜底不只为它存在，也接住以后任何新路由漏接的异常）。
  // 绝不依赖 NODE_ENV=production 去掩盖 Express 默认错误页——那是一个部署者可能忘记设置
  // 的环境变量，不构成安全属性。真实错误只经 logger 落地，响应体永远是同一个固定形状，
  // 不带堆栈、不带文件系统路径、不带任何关于这次失败具体是什么的信息。
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // 响应已经开始发送，不能再改状态码/正文——交还给 Express 自身的兜底路径。
      next(err);
      return;
    }
    logger.error('unhandled express error', {
      detail: err instanceof Error ? err.name : typeof err,
    });
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: '服务内部错误' },
      id: null,
    });
  });

  return {
    app,
    closeAll,
    sweepIdleTransports: (now?: number) => sweepIdleTransports(now),
    cutOffAccessKey,
    onEnvAccountsDisabled,
  };
}
