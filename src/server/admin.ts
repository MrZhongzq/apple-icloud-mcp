import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from '../core/logger.js';
import type { AuthStore } from '../auth/store.js';
import { generateToken, hashToken, verifyPassword } from '../auth/crypto.js';
import { applyLoginPageHeaders } from '../auth/login.js';
import {
  renderAdminDashboard,
  renderAdminLoginPage,
  renderAdminMessagePage,
  renderDestroyConfirmPage,
  type DashboardParams,
} from './adminPages.js';
import {
  ACCESS_LOGIN_RATE_LIMIT_MAX,
  ACCESS_LOGIN_RATE_LIMIT_WINDOW_MS,
  createSimpleRateLimit,
} from './rateLimit.js';

export interface AdminRouterDeps {
  adminPasswordHash: string;
  store: AuthStore;
  publicUrl: URL;
  logger: Logger;
  /** 停用或删除一把密钥时调用：吊销令牌、销毁会话、关 transport（httpApp 提供）。 */
  cutOffAccessKey(id: string): Promise<void>;
  /** env 账号开关从开变成关时调用：销毁所有用 env 账号建立的会话（httpApp 提供）。 */
  onEnvAccountsDisabled(): Promise<void>;
  /** 服务器 .env 里配置了几个账号，只用于开关旁边的说明文字。 */
  envAccountCount: number;
  /** 信封公钥文本（`amp1_…`）。没有配置信封私钥时不传，面板上就不显示这一节。 */
  envelopePublicKey?: string;
  /** 测试注入点：管理页会话的空闲判断用它取当前时刻。生产不传。 */
  now?: () => number;
}

const COOKIE_NAME = 'amcp_admin';
const ADMIN_SESSION_IDLE_MS = 30 * 60_000;
const KEY_NAME_MAX = 64;

/** 只取我们自己那一个 cookie。不引入 cookie-parser：为一个值加一个依赖不值得，
 *  而且这里只需要「按 ; 切开、找名字」这么多。 */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function formField(req: Request, name: string): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 管理页 `/admin`：主人用 ADMIN_PASSWORD_HASH 登录，管理访问密钥与 env 账号开关。
 *
 * 防 CSRF 靠两层：cookie 是 `SameSite=Strict`，并且**所有** POST（登录也算）都要求
 * `Origin` 恰好等于 PUBLIC_URL 的 origin。只靠 SameSite 不够——老浏览器不认它，而且
 * 同站（同一注册域下的别的子域）发起的请求照样带 cookie。
 *
 * 管理页会话只存在内存里，键是 cookie 值的哈希：内存快照或调试转储里看到的东西拿去当
 * cookie 用不了。进程重启后所有人都要重新登录，这是有意的。
 */
export function createAdminRouter(deps: AdminRouterDeps): express.Router {
  const { adminPasswordHash, store, publicUrl, logger } = deps;
  const now = deps.now ?? Date.now;
  const secureCookie = publicUrl.protocol === 'https:';
  const cookieAttrs = `Path=/admin; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;

  /** hashToken(cookie 值) → 最后一次活动时刻。 */
  const adminSessions = new Map<string, { lastActiveAt: number }>();

  function sweepExpired(t: number): void {
    for (const [hash, entry] of adminSessions) {
      if (t - entry.lastActiveAt > ADMIN_SESSION_IDLE_MS) adminSessions.delete(hash);
    }
  }

  /** 会话有效时刷新空闲计时并返回 true；过期的顺手删掉。 */
  function touchSession(req: Request): boolean {
    const token = readCookie(req, COOKIE_NAME);
    if (token === undefined || token === '') return false;
    const hash = hashToken(token);
    const entry = adminSessions.get(hash);
    if (!entry) return false;
    const t = now();
    if (t - entry.lastActiveAt > ADMIN_SESSION_IDLE_MS) {
      adminSessions.delete(hash);
      return false;
    }
    entry.lastActiveAt = t;
    return true;
  }

  function dashboard(extra: Pick<DashboardParams, 'created' | 'error'> = {}): string {
    return renderAdminDashboard({
      keys: store.listAccessKeys(),
      envAccountsEnabled: store.getSettings().envAccountsEnabled,
      envAccountCount: deps.envAccountCount,
      envelopePublicKey: deps.envelopePublicKey,
      ...extra,
    });
  }

  function notFound(res: Response): void {
    res.status(404).send(renderAdminMessagePage('密钥不存在', '这把访问密钥不存在，可能已经被销毁。'));
  }

  const router = express.Router();
  const form = express.urlencoded({ extended: false });

  // 每个 /admin 响应都带登录页那组头（no-store、防嵌入），包括 403/404/303；
  // 然后在任何路由、任何 body 解析之前挡掉来源不对的 POST。
  router.use('/admin', (req: Request, res: Response, next: NextFunction) => {
    applyLoginPageHeaders(res);
    if (req.method === 'POST' && req.headers.origin !== publicUrl.origin) {
      logger.warn('admin request rejected: origin mismatch', { path: req.path });
      res.status(403).send(renderAdminMessagePage('请求被拒绝', '请求来源不被允许。请直接在管理页上操作。'));
      return;
    }
    next();
  });

  /** 除登录外的每个操作都要先有会话；没有就回到 /admin（那里会显示登录页）。 */
  function requireSession(req: Request, res: Response, next: NextFunction): void {
    if (touchSession(req)) {
      next();
      return;
    }
    res.redirect(303, '/admin');
  }

  router.get('/admin', (req: Request, res: Response) => {
    if (!touchSession(req)) {
      res.status(200).send(renderAdminLoginPage());
      return;
    }
    res.status(200).send(dashboard());
  });

  router.post(
    '/admin/login',
    // 与 /access-login 同一组额度，但各自一组桶。
    createSimpleRateLimit({ windowMs: ACCESS_LOGIN_RATE_LIMIT_WINDOW_MS, max: ACCESS_LOGIN_RATE_LIMIT_MAX }),
    form,
    (req: Request, res: Response) => {
      const password = formField(req, 'password') ?? '';
      if (!verifyPassword(password, adminPasswordHash)) {
        // 只记一句，绝不记提交上来的字符串：输错的口令往往只差一个字符。
        logger.warn('admin login rejected: wrong password');
        res.status(401).send(renderAdminLoginPage({ error: '管理员口令不正确' }));
        return;
      }
      const t = now();
      sweepExpired(t);
      const token = generateToken();
      adminSessions.set(hashToken(token), { lastActiveAt: t });
      res.set('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieAttrs}`);
      logger.info('admin login succeeded');
      res.redirect(303, '/admin');
    },
  );

  router.post('/admin/logout', (req: Request, res: Response) => {
    const token = readCookie(req, COOKIE_NAME);
    if (token !== undefined && token !== '') adminSessions.delete(hashToken(token));
    res.set('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttrs}; Max-Age=0`);
    res.redirect(303, '/admin');
  });

  router.post('/admin/keys', requireSession, form, async (req: Request, res: Response) => {
    const name = (formField(req, 'name') ?? '').trim();
    if (name.length < 1 || name.length > KEY_NAME_MAX) {
      res.status(400).send(dashboard({ error: `名字去掉首尾空白后须为 1–${KEY_NAME_MAX} 个字符` }));
      return;
    }
    const { record, plaintext } = await store.createAccessKey(name);
    logger.info('access key created', { accessKeyId: record.id });
    // 直接以 200 渲染，不重定向：重定向就得把明文放进 URL 或会话里带过去，
    // 前者会进浏览器历史和代理日志，后者等于让服务端多记住一份明文。
    res.status(200).send(dashboard({ created: { name: record.name, plaintext } }));
  });

  router.post('/admin/keys/:id/disable', requireSession, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    // 先停用再切断：顺序反过来，切断之后、停用之前那一刻，这把密钥还能在授权页上
    // 换出一次新的授权，切断就白做了。
    if (!(await store.setAccessKeyEnabled(id, false))) {
      notFound(res);
      return;
    }
    await deps.cutOffAccessKey(id);
    logger.info('access key disabled', { accessKeyId: id });
    res.redirect(303, '/admin');
  });

  router.post('/admin/keys/:id/enable', requireSession, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!(await store.setAccessKeyEnabled(id, true))) {
      notFound(res);
      return;
    }
    logger.info('access key enabled', { accessKeyId: id });
    res.redirect(303, '/admin');
  });

  router.get('/admin/keys/:id/destroy', requireSession, (req: Request, res: Response) => {
    const key = store.getAccessKey(String(req.params.id));
    if (key === undefined) {
      notFound(res);
      return;
    }
    res.status(200).send(renderDestroyConfirmPage(key));
  });

  router.post('/admin/keys/:id/destroy', requireSession, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (store.getAccessKey(id) === undefined) {
      notFound(res);
      return;
    }
    // 先切断再删除：切断中途失败时，密钥还在表里，主人可以再点一次销毁重试；
    // 反过来先删记录的话，切断一旦失败，面板上已经没有这一行，残留的会话和 transport
    // 再也没有按钮能清掉，只能等它们自己过期。
    await deps.cutOffAccessKey(id);
    await store.deleteAccessKey(id);
    logger.info('access key destroyed', { accessKeyId: id });
    res.redirect(303, '/admin');
  });

  router.post('/admin/settings/env-accounts', requireSession, form, async (req: Request, res: Response) => {
    const raw = formField(req, 'enabled');
    if (raw !== 'true' && raw !== 'false') {
      res.status(400).send(renderAdminMessagePage('请求无效', '开关的取值只能是 true 或 false。'));
      return;
    }
    const enabled = raw === 'true';
    const wasEnabled = store.getSettings().envAccountsEnabled;
    await store.setEnvAccountsEnabled(enabled);
    // 只有「从开到关」才需要清场：已经在用 env 账号的会话不会因为开关变了就自己消失。
    if (wasEnabled && !enabled) await deps.onEnvAccountsDisabled();
    logger.info('env accounts setting changed', { enabled });
    res.redirect(303, '/admin');
  });

  return router;
}
