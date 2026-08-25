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
 * `createPendingStore()` 的返回类型。`peek` 只读取、不消费——过期的一律当作不存在；
 * `take` 消费掉一条记录，只在口令通过、即将签发授权码的那一刻调用。分开这两个方法是为了让
 * `handleLoginSubmit` 不需要「先取出、失败了再放回去」：那种取了再撤销的写法，在两步之间
 * 一旦抛异常就会把一条本该还能重试的待授权请求永久丢掉。
 */
export type PendingStore = {
  put(p: PendingAuthorization): string;
  /** 只读取，不消费；过期的一律当作不存在。 */
  peek(requestId: string): PendingAuthorization | undefined;
  /** 消费掉，用于口令通过、即将签发授权码的那一刻。 */
  take(requestId: string): PendingAuthorization | undefined;
  sweep(now?: number): number;
};

const REQUEST_ID_BYTES = 32;

/**
 * 待授权请求的内存暂存区。
 *
 * 刻意不接受 TTL 参数：过期时刻由存入方（`authorize()`）算好写在 `PendingAuthorization.expires_at`
 * 里，store 只按那个字段判断。给它再加一个自己的 TTL，就等于让同一件事有两个真相来源——
 * 两者一旦不一致，谁也说不清哪个说了算。
 */
export function createPendingStore(): PendingStore {
  const pending = new Map<string, PendingAuthorization>();

  function isLive(entry: PendingAuthorization, now: number): boolean {
    return entry.expires_at > now;
  }

  return {
    put(p: PendingAuthorization): string {
      const requestId = randomBytes(REQUEST_ID_BYTES).toString('base64url');
      pending.set(requestId, p);
      return requestId;
    },
    peek(requestId: string): PendingAuthorization | undefined {
      const entry = pending.get(requestId);
      if (entry === undefined) return undefined;
      if (!isLive(entry, Date.now())) return undefined;
      return entry;
    },
    take(requestId: string): PendingAuthorization | undefined {
      const entry = pending.get(requestId);
      if (entry === undefined) return undefined;
      pending.delete(requestId);
      if (!isLive(entry, Date.now())) return undefined;
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

  const entry = pending.peek(params.requestId);
  if (entry === undefined) {
    return { error: '登录请求不存在或已过期，请重新发起授权' };
  }

  if (!verifyPassword(params.password, adminPasswordHash)) {
    // 口令错，但这次授权请求本身还没过期——只 peek 过，从没消费掉它，requestId 原样有效，
    // 管理员可以用同一张已经打开的登录页再试一次。没有「取出再放回」的窗口可丢。
    logger.warn('admin login rejected: wrong password', { requestId: params.requestId });
    return { error: '口令不正确，请重试' };
  }

  // 口令通过，这是唯一一次真正消费这条待授权请求的地方——用 take() 而不是 peek()，
  // 保证同一个 requestId 不能被并发/重放来签发出两个授权码。
  pending.take(params.requestId);

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
