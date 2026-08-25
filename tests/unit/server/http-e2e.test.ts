import { describe, it, expect, afterEach, vi } from 'vitest';
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
import type { SessionStore } from '../../../src/core/session.js';

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
  close: () => Promise<void>;
}

/** 建一个绑在端口 0 上的真实 http server，用完必须在 finally 里 close，不占端口。 */
async function startServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'http-e2e-'));
  dirs.push(dir);

  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();

  const pending = createPendingStore();
  const sessions = {
    create: vi.fn(),
    get: vi.fn(),
    destroyByToken: vi.fn().mockResolvedValue(0),
  } as unknown as SessionStore;

  const provider = createOAuthProvider({ store, sessions, logger, pending });

  const httpConfig = {
    port: 0,
    // 只是元数据里出现的 issuer——不必等于真实监听端口，SDK 按路径分发，不比对整段 URL。
    publicUrl: new URL('http://127.0.0.1:19999'),
    adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    tokenStorePath: join(dir, 'tokens.json.enc'),
    encryptionKey: randomBytes(32),
  };

  const { app, closeAll } = createHttpApp({ config: appConfig, httpConfig, sessions, provider, logger, pending });
  const server = createNodeServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** register -> authorize -> admin-login -> token，返回 /token 的原始 status 与已解析的 body。 */
async function runFullAuthFlow(base: string): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return { status: tokenRes.status, body };
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
      expect(res.status, '真实令牌不该被当成未授权拒绝').not.toBe(401);
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
});
