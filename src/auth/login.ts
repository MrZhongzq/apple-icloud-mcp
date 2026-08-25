import { randomBytes } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import { verifyPassword } from './crypto.js';
import type { AppleOAuthProvider } from './provider.js';

/**
 * 一次待授权请求：`authorize()` 把客户端带来的参数原样存进这里，等管理员通过登录页确认。
 * `expires_at` 由存入方（`authorize()`）算好传入——store 本身不重新计算，只按这个字段判断
 * 是否已经过期。
 */
export interface PendingAuthorization {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  state?: string;
  expires_at: number;
}

/**
 * `createPendingStore()` 的返回类型。`put`/`take`/`sweep` 是对外的公开契约。`__restore` 不是——
 * 它只给 `handleLoginSubmit` 在口令错误时用：把刚 `take()` 出来的请求，原样放回同一个
 * `requestId` 下，好让已经发到浏览器手上的隐藏字段继续有效。`put()` 每次都生成新 id，
 * 没法承担这个角色，所以单独开一个方法，不写进公开的三方法契约里。
 */
export type PendingStore = {
  put(p: PendingAuthorization): string;
  take(requestId: string): PendingAuthorization | undefined;
  sweep(now?: number): number;
  __restore(requestId: string, p: PendingAuthorization): void;
};

const REQUEST_ID_BYTES = 32;
/** 默认给 `createPendingStore()` 用；实际过期判断始终以 `PendingAuthorization.expires_at`
 *  为准（见上），这个常量只在调用方没传时兜底，不参与 store 内部的任何比较。 */
const DEFAULT_PENDING_TTL_MS = 10 * 60_000;

/**
 * 待授权请求的内存暂存区。`take()` 取出即删除——一次登录尝试要么成功换成授权码，要么失败
 * 后由 `handleLoginSubmit` 把同一个 `requestId` 原样放回去，让管理员能用同一张登录页重试。
 */
export function createPendingStore(ttlMs: number = DEFAULT_PENDING_TTL_MS): PendingStore {
  void ttlMs;
  const pending = new Map<string, PendingAuthorization>();

  return {
    put(p: PendingAuthorization): string {
      const requestId = randomBytes(REQUEST_ID_BYTES).toString('base64url');
      pending.set(requestId, p);
      return requestId;
    },
    take(requestId: string): PendingAuthorization | undefined {
      const entry = pending.get(requestId);
      if (entry === undefined) return undefined;
      pending.delete(requestId);
      if (entry.expires_at <= Date.now()) return undefined;
      return entry;
    },
    sweep(now: number = Date.now()): number {
      let removed = 0;
      for (const [id, entry] of pending) {
        if (entry.expires_at <= now) {
          pending.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    __restore(requestId: string, p: PendingAuthorization): void {
      pending.set(requestId, p);
    },
  };
}

function escapeHtml(input: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return input.replace(/[&<>"']/g, (ch) => map[ch] as string);
}

/** 渲染登录页。pending 由 authorize() 暂存，表单回传时凭 requestId 取回。
 *  页面唯一的隐藏字段是 requestId；任何插值都经过 escapeHtml。 */
export function renderLoginPage(params: { requestId: string; error?: string }): string {
  const requestId = escapeHtml(params.requestId);
  const errorHtml =
    params.error !== undefined
      ? '<p class="error" role="alert">' + escapeHtml(params.error) + '</p>'
      : '';

  return (
    '<!doctype html>' +
    '<html lang="zh">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>管理员登录</title>' +
    '<style>' +
    'body{font-family:system-ui,-apple-system,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem;color:#111}' +
    'h1{font-size:1.25rem}' +
    '.error{color:#b00020;background:#fdecea;padding:0.5rem 0.75rem;border-radius:4px}' +
    'label{display:block;margin-top:1rem;font-weight:600}' +
    'input[type="password"]{width:100%;box-sizing:border-box;padding:0.5rem;font-size:1rem;margin-top:0.25rem}' +
    'button{margin-top:1.25rem;width:100%;padding:0.6rem;font-size:1rem;cursor:pointer}' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<h1>管理员登录</h1>' +
    errorHtml +
    '<form method="post" action="/authorize">' +
    '<input type="hidden" name="request_id" value="' + requestId + '">' +
    '<label for="password">口令</label>' +
    '<input type="password" id="password" name="password" autocomplete="current-password" required autofocus>' +
    '<button type="submit">登录</button>' +
    '</form>' +
    '</body>' +
    '</html>'
  );
}

/** 请求本身有问题（如 redirect_uri 不匹配任何注册值）时用的终态错误页——不带表单，
 *  因为这种情况下重试没有意义：跳回一个未注册的地址本身就是开放重定向，所以干脆不跳转。 */
export function renderAuthorizeErrorPage(message: string): string {
  return (
    '<!doctype html>' +
    '<html lang="zh">' +
    '<head><meta charset="utf-8"><title>授权请求无效</title></head>' +
    '<body><h1>授权请求无效</h1><p>' +
    escapeHtml(message) +
    '</p></body></html>'
  );
}

export interface LoginDeps {
  adminPasswordHash: string;
  provider: AppleOAuthProvider;
  logger: Logger;
  /** authorize() 暂存待授权请求的地方，登录表单凭 requestId 从这里取回。 */
  pending: PendingStore;
}

/** 处理登录表单提交。成功时返回要跳转到的完整 URL（含 code 与 state），失败时返回错误信息。
 *  口令校验完全委托给 crypto.ts 的 verifyPassword（内部走 timingSafeEqual）——这里不重新
 *  实现比较逻辑。 */
export function handleLoginSubmit(
  deps: LoginDeps,
  params: { requestId: string; password: string },
): { redirectTo: string } | { error: string } {
  const { adminPasswordHash, provider, logger, pending } = deps;

  const entry = pending.take(params.requestId);
  if (entry === undefined) {
    return { error: '登录请求不存在或已过期，请重新发起授权' };
  }

  if (!verifyPassword(params.password, adminPasswordHash)) {
    // 口令错，但这次授权请求本身还没过期——把它放回同一个 requestId 下，
    // 这样管理员可以用同一张已经打开的登录页再试一次。
    pending.__restore(params.requestId, entry);
    logger.warn('admin login rejected: wrong password', { requestId: params.requestId });
    return { error: '口令不正确，请重试' };
  }

  const code = provider.issueAuthorizationCode({
    clientId: entry.client_id,
    redirectUri: entry.redirect_uri,
    codeChallenge: entry.code_challenge,
    scopes: entry.scopes,
  });

  const redirectUrl = new URL(entry.redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (entry.state !== undefined) {
    redirectUrl.searchParams.set('state', entry.state);
  }

  logger.info('admin login succeeded, authorization code issued', { clientId: entry.client_id });
  return { redirectTo: redirectUrl.toString() };
}
