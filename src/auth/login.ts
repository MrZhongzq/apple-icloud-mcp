import { randomBytes } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import type { AppleOAuthProvider } from './provider.js';
import type { AccessKeyRecord } from './store.js';

/**
 * 一次待授权请求：`authorize()` 把客户端带来的参数原样存进这里，等使用者在登录页输入访问密钥确认。
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
 * `take` 消费掉一条记录，只在访问密钥通过、即将签发授权码的那一刻调用。分开这两个方法是为了让
 * `handleLoginSubmit` 不需要「先取出、失败了再放回去」：那种取了再撤销的写法，在两步之间
 * 一旦抛异常就会把一条本该还能重试的待授权请求永久丢掉。
 */
export type PendingStore = {
  put(p: PendingAuthorization): string;
  /** 只读取，不消费；过期的一律当作不存在。 */
  peek(requestId: string): PendingAuthorization | undefined;
  /** 消费掉，用于访问密钥通过、即将签发授权码的那一刻。 */
  take(requestId: string): PendingAuthorization | undefined;
  /**
   * 这个 requestId 是否已经被 `take()` 成功消费过（且原请求还没到 `expires_at`）。
   * 用来把「同一张登录页又提交了一次」（刷新、双击、浏览器回退重发）和「请求不存在或已过期」
   * 区分开：前者授权其实已经完成，告诉人「请重新发起授权」只会让他去做一件多余、
   * 还可能把刚拿到的那次授权弄乱的事。
   */
  wasCompleted(requestId: string): boolean;
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
  /** 已完成的 requestId → 原请求的 expires_at。只记到那一刻为止：过了原请求的有效期，
   *  「已完成」与「已过期」对使用者来说是同一个答复，没必要再记。 */
  const completed = new Map<string, number>();

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
      completed.set(requestId, entry.expires_at);
      return entry;
    },
    wasCompleted(requestId: string): boolean {
      const expiresAt = completed.get(requestId);
      return expiresAt !== undefined && expiresAt > Date.now();
    },
    sweep(now: number = Date.now()): number {
      let removed = 0;
      for (const [id, entry] of pending) {
        if (entry.expires_at <= now) {
          pending.delete(id);
          removed += 1;
        }
      }
      for (const [id, expiresAt] of completed) {
        if (expiresAt <= now) completed.delete(id);
      }
      return removed;
    },
  };
}

/**
 * 登录页（以及同一路由上的授权错误页）必须带的响应头。
 *
 * `no-store` 之外还有两条防点击劫持的：这是有真人往里输访问密钥的页面，
 * 一旦能被第三方站点嵌进 iframe，攻击者就可以把它盖在自己的页面下面骗一次提交。
 * `X-Frame-Options: DENY` 管住老浏览器，CSP 的 `frame-ancestors 'none'` 是现代等价物，
 * 两条都给，因为它们的覆盖面不完全重合。集中成一个常量，是为了让登录页的三个发送点
 * （authorize() 渲染登录页、渲染错误页，以及 /access-login 提交失败后重新渲染、
 * 重复提交时的「已完成」页）不会各写一份、日后只改其中一处。
 */
export const LOGIN_PAGE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Cache-Control', 'no-store'],
  ['X-Frame-Options', 'DENY'],
  ['Content-Security-Policy', "frame-ancestors 'none'"],
];

/** 把上面那组头写到响应上。只依赖 `set(name, value)`，所以真实的 express Response
 *  与单测里的假 res 都能直接用。 */
export function applyLoginPageHeaders(res: { set(name: string, value: string): unknown }): void {
  for (const [name, value] of LOGIN_PAGE_HEADERS) res.set(name, value);
}

/** 导出给管理页（Task 6）复用：同一套转义规则只写一份。 */
export function escapeHtml(input: string): string {
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
    '<title>输入访问密钥</title>' +
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
    '<h1>输入访问密钥</h1>' +
    errorHtml +
    '<form method="post" action="/access-login">' +
    '<input type="hidden" name="request_id" value="' + requestId + '">' +
    '<label for="access_key">访问密钥</label>' +
    // autocomplete="off"：访问密钥是服务器发给某个人的一段随机串，不是这个人自己的口令，
    // 不该被浏览器当成「这个站点的密码」记下来、再自动填给别人用这台电脑时的同一页。
    '<input type="password" id="access_key" name="access_key" autocomplete="off" required autofocus>' +
    '<button type="submit">授权</button>' +
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

/** 重复提交一个已经完成的授权请求时显示的终态页：授权已经成功，不需要也不应该再做什么。 */
export function renderAlreadyCompletedPage(): string {
  return (
    '<!doctype html>' +
    '<html lang="zh">' +
    '<head><meta charset="utf-8"><title>授权已完成</title></head>' +
    '<body><h1>授权已完成</h1><p>这次授权已经完成，可以关闭此页，回到 Claude 继续。</p></body></html>'
  );
}

export interface LoginDeps {
  /** 按明文查访问密钥（生产环境是 `store.findAccessKeyByPlaintext`）。停用的也会返回，
   *  是否放行由 handleLoginSubmit 看 `enabled` 决定。 */
  findAccessKey(plaintext: string): AccessKeyRecord | undefined;
  provider: AppleOAuthProvider;
  logger: Logger;
  /** authorize() 暂存待授权请求的地方，登录表单凭 requestId 从这里取回。 */
  pending: PendingStore;
}

/** 处理登录表单提交。成功时返回要跳转到的完整 URL（含 code 与 state），失败时返回错误信息；
 *  同一个请求已经成功提交过时返回 `{ alreadyCompleted: true }`。
 *  密钥比对不在这里做：store 里只存哈希，`findAccessKey` 按哈希查表，明文从不和任何东西
 *  逐字节比较。 */
export function handleLoginSubmit(
  deps: LoginDeps,
  params: { requestId: string; accessKey: string },
): { redirectTo: string } | { error: string } | { alreadyCompleted: true } {
  const { findAccessKey, provider, logger, pending } = deps;

  const entry = pending.peek(params.requestId);
  if (entry === undefined) {
    if (pending.wasCompleted(params.requestId)) return { alreadyCompleted: true };
    return { error: '登录请求不存在或已过期，请重新发起授权' };
  }

  const key = findAccessKey(params.accessKey);
  if (key === undefined || !key.enabled) {
    // 错误的密钥与停用的密钥给同一句提示：手里拿着一把停用密钥的人，不该能从提示上确认
    // 「这串字符曾经是一把真密钥」。这次授权请求本身还没过期——只 peek 过，从没消费掉它，
    // requestId 原样有效，可以用同一张已经打开的登录页再试一次。
    // 日志里只记 requestId，绝不记提交上来的字符串：输错的那一串很可能只差一个字符。
    logger.warn('access key login rejected: unknown or disabled key', { requestId: params.requestId });
    return { error: '访问密钥不正确或已停用，请重试' };
  }

  // 密钥通过，这是唯一一次真正消费这条待授权请求的地方——用 take() 而不是 peek()，
  // 保证同一个 requestId 不能被并发/重放来签发出两个授权码。
  const taken = pending.take(params.requestId);
  if (taken === undefined) {
    // peek 与 take 之间请求恰好到期：按过期处理，不签发任何东西。
    return { error: '登录请求不存在或已过期，请重新发起授权' };
  }

  // 密钥 id 从这里进入令牌链：授权码 → 令牌记录 → AuthInfo.extra → 工具层的会话归属。
  // 漏掉这一环，后面每一层拿到的都是 undefined，按密钥隔离会话就整个落空。
  const code = provider.issueAuthorizationCode({
    clientId: taken.client_id,
    redirectUri: taken.redirect_uri,
    codeChallenge: taken.code_challenge,
    scopes: taken.scopes,
    accessKeyId: key.id,
  });

  const redirectUrl = new URL(taken.redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (taken.state !== undefined) {
    redirectUrl.searchParams.set('state', taken.state);
  }

  logger.info('access key login succeeded, authorization code issued', {
    clientId: taken.client_id,
    accessKeyId: key.id,
  });
  return { redirectTo: redirectUrl.toString() };
}
