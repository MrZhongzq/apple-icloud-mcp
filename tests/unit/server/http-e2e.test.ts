import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createNodeServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createHttpApp } from '../../../src/server/httpApp.js';
import { createOAuthProvider } from '../../../src/auth/provider.js';
import { createAuthStore } from '../../../src/auth/store.js';
import { createPendingStore } from '../../../src/auth/login.js';
import { hashPassword } from '../../../src/auth/crypto.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import { createSessionStore, type SessionStore } from '../../../src/core/session.js';

/**
 * 端到端：真实 AuthStore + 真实 AppleOAuthProvider（不 mock），真的绑到 127.0.0.1:0 打
 * 请求，走 register -> authorize -> admin-login -> token -> /mcp 整条链路。
 *
 * 这条测试存在的理由是 http-app.test.ts 那七个单测全都 mock 掉了 provider——`verifyAccessToken`
 * 从没真正抛过 provider.ts 里那些带中文文案的 InvalidTokenError/InvalidGrantError，所以那七个
 * 单测对"错误消息里的中文字符把 WWW-Authenticate 写崩、把 401 变成 500"这类问题完全失明。
 * 这里用真 provider，才能看见两层拼接处真正会发生的事。
 */

const logger = createLogger('error', () => {});
const ADMIN_PASSWORD = 'e2e-admin-password';
const REDIRECT_URI = 'http://127.0.0.1:9/callback';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const appConfig = {
  accounts: [
    {
      id: 'account_1',
      label: 'a@icloud.com',
      email: 'a@icloud.com',
      sender: 'a@icloud.com',
      appPassword: 'x',
      capabilities: {
        mailRead: true, mailWrite: false,
        calendarRead: true, calendarWrite: false,
        remindersRead: true, remindersWrite: false,
        contactsRead: true, contactsWrite: false,
      },
    },
  ],
  sessionTtlMs: 60_000,
  imapIdleTimeoutMs: 60_000,
  logLevel: 'error',
  deprecations: [],
  notices: [],
} as AppConfig;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface TestServer {
  base: string;
  /** 周期性清理器，正常由 bin/http.ts 的定时器调用；测试里直接调，并注入一个假的 now。 */
  sweepIdleTransports: (now?: number) => Promise<number>;
  /** 真的 SessionStore，不是 vi.fn()——吊销那条测试要看的就是它里面还剩几条会话。 */
  sessions: SessionStore;
  /** 被销毁的会话关掉了哪些底层连接。 */
  closedProviders: string[];
  close: () => Promise<void>;
}

/** 建一个绑在端口 0 上的真实 http server，用完必须在 finally 里 close，不占端口。 */
async function startServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'http-e2e-'));
  dirs.push(dir);

  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();

  const pending = createPendingStore();

  // 真实的 SessionStore，只把最底下那层网络 provider 换成不连网的替身。
  // 这里曾经整个是 `{ create: vi.fn(), destroyByToken: vi.fn() }`——于是"吊销令牌会不会
  // 真的销毁会话"这个问题在本文件里根本问不出来：被问的那个对象就是假的。生产代码那时
  // 恰好把会话建成了不带令牌家族的样子，`destroyByToken` 一条也匹配不到，而三个 mock 掉
  // 关键环节的单测全是绿的。用真的 store，那个 bug 就无处可藏。
  const closedProviders: string[] = [];
  const sessions = createSessionStore({
    ttlMs: 60_000,
    providerFactory: () =>
      ({
        imap: {
          verify: async (): Promise<void> => {},
          close: async (): Promise<void> => {
            closedProviders.push('imap');
          },
        },
        smtp: {
          close: async (): Promise<void> => {
            closedProviders.push('smtp');
          },
        },
        caldav: { verify: async (): Promise<void> => {} },
        carddav: { verify: async (): Promise<void> => {} },
      }) as never,
  });

  const provider = createOAuthProvider({ store, sessions, logger, pending });

  const httpConfig = {
    port: 0,
    // 只是元数据里出现的 issuer——不必等于真实监听端口，SDK 按路径分发，不比对整段 URL。
    publicUrl: new URL('http://127.0.0.1:19999'),
    adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    tokenStorePath: join(dir, 'tokens.json.enc'),
    encryptionKey: randomBytes(32),
    trustProxy: false,
  };

  const { app, closeAll, sweepIdleTransports } = createHttpApp({
    config: appConfig,
    httpConfig,
    sessions,
    provider,
    logger,
    pending,
  });
  const server = createNodeServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    sweepIdleTransports,
    sessions,
    closedProviders,
    async close() {
      await closeAll();
      await sessions.destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** register -> authorize -> admin-login -> token，返回 /token 的原始 status、已解析的 body
 *  与这次动态注册拿到的 client_id（`/revoke` 需要它做客户端认证）。 */
async function runFullAuthFlow(
  base: string,
): Promise<{ status: number; body: Record<string, unknown>; clientId: string }> {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());

  const regRes = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(regRes.status, '动态客户端注册').toBe(201);
  const registered = (await regRes.json()) as { client_id: string };
  const clientId = registered.client_id;

  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', 'e2e-state');

  const authRes = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(authRes.status, 'GET /authorize 返回登录页').toBe(200);
  const html = await authRes.text();
  const match = /name="request_id" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('login page did not contain a request_id field');
  const requestId = match[1] as string;

  const loginRes = await fetch(`${base}/admin-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ request_id: requestId, password: ADMIN_PASSWORD }).toString(),
  });
  expect(loginRes.status, 'POST /admin-login 跳回并带 code').toBe(303);
  const location = loginRes.headers.get('location');
  if (!location) throw new Error('admin-login did not redirect');
  const callback = new URL(location);
  expect(callback.searchParams.get('state')).toBe('e2e-state');
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('no code in the admin-login redirect');

  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });
  const body = (await tokenRes.json()) as Record<string, unknown>;
  return { status: tokenRes.status, body, clientId };
}

const NEWLINE = String.fromCharCode(10);
const PROTOCOL_VERSION = '2025-06-18';

/** Streamable HTTP 的 POST 回应是 SSE 帧，不是裸 JSON：把 data: 行挑出来解析。 */
function parseSseMessages(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const rawLine of text.split(NEWLINE)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload.length === 0) continue;
    out.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return out;
}

async function mcpPost(
  base: string,
  accessToken: string,
  body: unknown,
  mcpSessionId?: string,
): Promise<{ status: number; mcpSessionId?: string; messages: Record<string, unknown>[]; raw: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    authorization: `Bearer ${accessToken}`,
  };
  if (mcpSessionId !== undefined) headers['mcp-session-id'] = mcpSessionId;

  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await res.text();
  return {
    status: res.status,
    mcpSessionId: res.headers.get('mcp-session-id') ?? undefined,
    messages: parseSseMessages(raw),
    raw,
  };
}

/** initialize -> notifications/initialized -> tools/call apple_login，返回工具吐出的 session_id。
 *  刻意走完整的 MCP 握手而不是直接调服务层函数：令牌家族正是在这条路上被 SDK 从
 *  requireBearerAuth 一路传到工具回调第二个参数的，绕过它就等于没测。 */
async function loginThroughMcp(base: string, accessToken: string): Promise<string> {
  const init = await mcpPost(base, accessToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'revocation-probe', version: '1.0.0' },
    },
  });
  expect(init.status, `initialize 失败 —— body: ${init.raw}`).toBe(200);
  const mcpSessionId = init.mcpSessionId;
  if (mcpSessionId === undefined) throw new Error('initialize did not return an mcp-session-id header');

  await mcpPost(base, accessToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, mcpSessionId);

  const call = await mcpPost(
    base,
    accessToken,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'apple_login', arguments: {} } },
    mcpSessionId,
  );
  expect(call.status, `tools/call apple_login 失败 —— body: ${call.raw}`).toBe(200);

  const message = call.messages.find((m) => m.id === 2);
  const result = message?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`apple_login returned no text content: ${call.raw}`);
  const payload = JSON.parse(text) as { session_id?: string };
  if (typeof payload.session_id !== 'string') {
    throw new Error(`apple_login did not return a session_id: ${text}`);
  }
  return payload.session_id;
}

describe('oauth chain end to end (real provider, real store, real port)', () => {
  it('walks register -> authorize -> admin-login -> token and yields an access_token', async () => {
    const srv = await startServer();
    try {
      const { status, body } = await runFullAuthFlow(srv.base);
      expect(status, `POST /token 换到访问令牌 —— 收到的 body: ${JSON.stringify(body)}`).toBe(200);
      expect(typeof body.access_token).toBe('string');
      expect((body.access_token as string).length).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });

  it('lets a real access token past requireBearerAuth', async () => {
    const srv = await startServer();
    try {
      const { body } = await runFullAuthFlow(srv.base);
      const accessToken = body.access_token as string;

      const res = await fetch(`${srv.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'e2e-probe', version: '1.0.0' },
          },
        }),
      });
      // `.not.toBe(401)` 曾经是这里的断言：那样写的话，500、502、连接被
      // reset 都会让测试通过——"没被当成未授权"和"什么正经响应都没有"
      // 长得一样。这里改成正向断言：一次成功的 MCP initialize 请求应该拿到
      // 200，而不只是"不是 401"。
      expect(res.status, '真实令牌不该被当成未授权拒绝，应当正常完成 initialize').toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('rejects a forged bearer token with exactly 401, never 500', async () => {
    const srv = await startServer();
    try {
      const res = await fetch(`${srv.base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer forged-does-not-exist' },
        body: '{}',
      });
      const body = await res.text();
      expect(res.status, `伪造令牌必须被拒 401，不能是 500 —— 收到的 body: ${body}`).toBe(401);
      // 401 之下不该出现 express 的默认错误页（那正是 WWW-Authenticate 头炸掉时的样子）
      expect(body).not.toContain('ERR_INVALID_CHAR');
      expect(body).not.toContain('<pre>');
    } finally {
      await srv.close();
    }
  });

  // 这条测试问的是"吊销之后那条会话还在不在"，而不是"吊销之后 /mcp 还认不认这个令牌"。
  // 后者由 verifyAccessToken 在 HTTP 边界上保证，令牌记录一删就自然成立——它在会话销毁
  // 完全没接上的时候也照样是绿的，所以拿它当吊销的证据是假证据。这里直接看真实
  // SessionStore 里还剩什么：会话没了、IMAP 连接关了，才叫票和人一起离场。
  it('destroys the live MCP session the revoked token had authorized', async () => {
    const srv = await startServer();
    try {
      const { body, clientId } = await runFullAuthFlow(srv.base);
      const accessToken = body.access_token as string;

      const sessionId = await loginThroughMcp(srv.base, accessToken);
      expect(srv.sessions.size(), 'apple_login 应当建立了一条会话').toBe(1);
      expect(srv.sessions.get(sessionId).id, 'session_id 在吊销前必须可用').toBe(sessionId);

      const revokeRes = await fetch(`${srv.base}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken, client_id: clientId }).toString(),
      });
      expect(revokeRes.status, `POST /revoke —— body: ${await revokeRes.text()}`).toBe(200);

      expect(
        srv.sessions.size(),
        '令牌已吊销，它授权建立的会话必须当场消失，而不是等 30 分钟空闲 TTL',
      ).toBe(0);
      expect(() => srv.sessions.get(sessionId), '被吊销的 session_id 必须立刻失效').toThrow();
      expect(
        srv.closedProviders,
        '只从 Map 里删掉会留下一条还连着用户 iCloud 邮箱的 IMAP 连接',
      ).toContain('imap');
    } finally {
      await srv.close();
    }
  });

  // transport 表原先只增不减：`initialize` 往里放，只有客户端正常关闭（DELETE 或连接自然
  // 结束）触发的 onclose 会摘掉。断线重连的客户端每重连一次就漏一个 transport 加一个
  // McpServer，一直留到进程退出。这里注入一个假的 now，不靠 sleep 判定，避免时间上的偶然。
  it('sweeps an idle mcp transport, and leaves an active one alone', async () => {
    const srv = await startServer();
    try {
      const { body } = await runFullAuthFlow(srv.base);
      const accessToken = body.access_token as string;

      const init = await mcpPost(srv.base, accessToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'sweep-probe', version: '1.0.0' },
        },
      });
      expect(init.status, `initialize 失败 —— body: ${init.raw}`).toBe(200);
      const mcpSessionId = init.mcpSessionId as string;
      expect(typeof mcpSessionId).toBe('string');

      expect(await srv.sweepIdleTransports(Date.now()), '刚建立的 transport 不能被清掉').toBe(0);

      // 再打一个请求，刷新 lastActiveAt——顺便证明 Map 里存的就是请求路径上被刷新的那个对象。
      await mcpPost(
        srv.base,
        accessToken,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        mcpSessionId,
      );
      expect(await srv.sweepIdleTransports(Date.now()), '还在用的 transport 不能被清掉').toBe(0);

      // 空闲超过会话 TTL（本测试配置里是 60 秒）之后，它必须被关掉并摘掉。
      expect(
        await srv.sweepIdleTransports(Date.now() + appConfig.sessionTtlMs + 1_000),
        '空闲超过 TTL 的 transport 必须被清掉',
      ).toBe(1);

      const afterSweep = await mcpPost(
        srv.base,
        accessToken,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        mcpSessionId,
      );
      expect(afterSweep.status, '被清掉的 MCP 会话 ID 不该还能用').toBe(400);

      expect(await srv.sweepIdleTransports(Date.now() + appConfig.sessionTtlMs + 1_000), '已经清过了').toBe(0);
    } finally {
      await srv.close();
    }
  });

  // 整套服务里唯一一个有真人往里输管理员口令的页面。能被第三方站点嵌进 iframe，
  // 就能被盖在别的页面下面骗一次提交。X-Frame-Options 管老浏览器，CSP 的
  // frame-ancestors 是现代等价物，两条都要，覆盖面不完全重合。
  it('serves the admin login page with anti-clickjacking headers', async () => {
    const srv = await startServer();
    try {
      const regRes = await fetch(`${srv.base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });
      const { client_id: clientId } = (await regRes.json()) as { client_id: string };

      const authorizeUrl = new URL(`${srv.base}/authorize`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authorizeUrl.searchParams.set('code_challenge', b64url(randomBytes(32)));
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');

      const page = await fetch(authorizeUrl, { redirect: 'manual' });
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");

      // 口令错时重新渲染的那一份也是同一个页面，必须带同样的头。
      const retry = await fetch(`${srv.base}/admin-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({ request_id: 'nope', password: 'wrong' }).toString(),
      });
      expect(retry.status).toBe(401);
      expect(retry.headers.get('x-frame-options')).toBe('DENY');
      expect(retry.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    } finally {
      await srv.close();
    }
  });

  // 未认证请求不该碰到这条路径（requireBearerAuth 先挡住），但一个真正通过认证的调用方
  // 完全可能自己发一个畸形 JSON body 过来——这条测试打的是终态错误处理中间件本身：
  // body-parser 抛出的 SyntaxError 必须被压成固定 JSON 形状，绝不是 Express 默认错误页。
  it('normalizes a malformed body from an authenticated caller instead of leaking a stack trace', async () => {
    const srv = await startServer();
    try {
      const { body: tokenBody } = await runFullAuthFlow(srv.base);
      const accessToken = tokenBody.access_token as string;

      const res = await fetch(`${srv.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${accessToken}`,
        },
        body: '{not valid json',
      });
      const responseBody = await res.text();

      expect(responseBody, '不能是 Express 默认错误页').not.toContain('<pre>');
      expect(responseBody, '不能带堆栈行').not.toContain('at ');
      expect(responseBody, '不能带文件系统路径').not.toContain('node_modules');

      // 走到这里说明认证已经通过（否则会在 requireBearerAuth 就被拦成 401），
      // 剩下的失败只可能来自 body-parser 抛出的 SyntaxError，必须被终态错误处理
      // 中间件压成与 /mcp 处理器自己的 500 分支一致的固定 JSON 形状。
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      expect(parsed, '响应必须是可解析的 JSON，不是 HTML 错误页').not.toBeNull();
      expect((parsed as Record<string, unknown>).jsonrpc).toBe('2.0');
      expect((parsed as Record<string, unknown>).error).toBeTruthy();
    } finally {
      await srv.close();
    }
  });
});
