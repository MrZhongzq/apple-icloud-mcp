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
import { loadOrCreateEnvelopeKeyring, type EnvelopeKeyring } from '../../../src/auth/keyring.js';
import { createEnvelopeOpener } from '../../../src/auth/envelope.js';
import { sealEnvelope } from '../../../scripts/make-envelope.mjs';
import type { AppConfig } from '../../../src/core/config.js';
import { createSessionStore, type SessionStore } from '../../../src/core/session.js';

/**
 * 端到端：真实 AuthStore + 真实 AppleOAuthProvider（不 mock），真的绑到 127.0.0.1:0 打
 * 请求，走 register -> authorize -> access-login -> token -> /mcp 整条链路。
 *
 * 这条测试存在的理由是 http-app.test.ts 那七个单测全都 mock 掉了 provider——`verifyAccessToken`
 * 从没真正抛过 provider.ts 里那些带中文文案的 InvalidTokenError/InvalidGrantError，所以那七个
 * 单测对"错误消息里的中文字符把 WWW-Authenticate 写崩、把 401 变成 500"这类问题完全失明。
 * 这里用真 provider，才能看见两层拼接处真正会发生的事。
 */

const logger = createLogger('error', () => {});
/** 管理员口令仍然在 HttpConfig 里（管理页要用），但授权页不再认它。 */
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
/** startServer 建的每一把密钥：明文 → id。`runFullAuthFlow` 只拿得到明文（和真实用户一样），
 *  返回值里的 accessKeyId 从这里查——测试要拿它去比对会话归属。 */
const keyIdsByPlaintext = new Map<string, string>();

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  keyIdsByPlaintext.clear();
});

interface TestServer {
  base: string;
  /** 周期性清理器，正常由 bin/http.ts 的定时器调用；测试里直接调，并注入一个假的 now。 */
  sweepIdleTransports: (now?: number) => Promise<number>;
  /** 真的 SessionStore，不是 vi.fn()——吊销那条测试要看的就是它里面还剩几条会话。 */
  sessions: SessionStore;
  /** 被销毁的会话关掉了哪些底层连接。 */
  closedProviders: string[];
  /** startServer 建的那把访问密钥的明文，授权页上要提交的就是它。（即密钥 A。） */
  accessKey: string;
  /** 第二个人的密钥 B：多人隔离那几条用例要两把互不相干的密钥。 */
  accessKeyB: string;
  /** 切断一把密钥：吊销令牌、销毁它名下的会话、关掉它名下的 transport。 */
  cutOffAccessKey: (keyId: string) => Promise<void>;
  /** 关掉 env 账号开关之后调用：销毁所有用 env 账号建立的会话。 */
  onEnvAccountsDisabled: () => Promise<void>;
  /** 只有 `withEnvelope: true` 时才有：服务端的信封密钥对，测试拿它的公钥封信封。 */
  keyring?: EnvelopeKeyring;
  close: () => Promise<void>;
}

interface StartServerOptions {
  /** env 账号开关。默认 true：现有用例都用 `.env` 账号登录，不该因为默认值变了而变红。 */
  envAccountsEnabled?: boolean;
  /** 覆盖 config.accounts；远程入口允许零个 env 账号。 */
  accounts?: AppConfig['accounts'];
  /** 像 bin/http.ts 那样加载一个信封密钥对（临时路径），并把 opener 与公钥交给 createHttpApp。 */
  withEnvelope?: boolean;
}

/** 建一个绑在端口 0 上的真实 http server，用完必须在 finally 里 close，不占端口。 */
async function startServer(options: StartServerOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'http-e2e-'));
  dirs.push(dir);

  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();
  await store.setEnvAccountsEnabled(options.envAccountsEnabled ?? true);
  const { record: keyRecord, plaintext: accessKey } = await store.createAccessKey('e2e');
  keyIdsByPlaintext.set(accessKey, keyRecord.id);
  const { record: keyRecordB, plaintext: accessKeyB } = await store.createAccessKey('e2e-b');
  keyIdsByPlaintext.set(accessKeyB, keyRecordB.id);

  const config: AppConfig = options.accounts === undefined ? appConfig : { ...appConfig, accounts: options.accounts };

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
        caldav: { verify: async (): Promise<void> => {}, listCalendars: async (): Promise<never[]> => [] },
        carddav: { verify: async (): Promise<void> => {} },
      }) as never,
  });

  const provider = createOAuthProvider({ store, sessions, logger, pending, accessKeys: store });

  const httpConfig = {
    port: 0,
    // 只是元数据里出现的 issuer——不必等于真实监听端口，SDK 按路径分发，不比对整段 URL。
    publicUrl: new URL('http://127.0.0.1:19999'),
    adminPasswordHash: hashPassword(ADMIN_PASSWORD),
    tokenStorePath: join(dir, 'tokens.json.enc'),
    encryptionKey: randomBytes(32),
    trustProxy: false,
    envelopeKeyPath: join(dir, 'envelope-key.json.enc'),
  };

  let keyring: EnvelopeKeyring | undefined;
  let envelope: { publicKeyText: string; open: ReturnType<typeof createEnvelopeOpener>['open'] } | undefined;
  if (options.withEnvelope) {
    keyring = await loadOrCreateEnvelopeKeyring({
      path: httpConfig.envelopeKeyPath,
      encryptionKey: httpConfig.encryptionKey,
      logger,
    });
    const opener = createEnvelopeOpener({ keyring, logger });
    envelope = { publicKeyText: keyring.publicKeyText, open: opener.open };
  }

  const { app, closeAll, sweepIdleTransports, cutOffAccessKey, onEnvAccountsDisabled } = createHttpApp({
    config,
    httpConfig,
    sessions,
    provider,
    logger,
    store,
    pending,
    envelope,
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
    accessKey,
    accessKeyB,
    cutOffAccessKey,
    onEnvAccountsDisabled,
    keyring,
    async close() {
      await closeAll();
      await sessions.destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** register -> GET /authorize，返回登录页里的 request_id 以及之后兑换授权码要用的东西。 */
async function openAuthorizePage(
  base: string,
): Promise<{ clientId: string; codeVerifier: string; requestId: string }> {
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
  return { clientId, codeVerifier, requestId };
}

function submitAccessKey(base: string, requestId: string, accessKey: string): Promise<Response> {
  return fetch(`${base}/access-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ request_id: requestId, access_key: accessKey }).toString(),
  });
}

/** register -> authorize -> access-login -> token，返回 /token 的原始 status、已解析的 body、
 *  这次动态注册拿到的 client_id（`/revoke` 需要它做客户端认证），以及提交的那把密钥的 id。 */
async function runFullAuthFlow(
  base: string,
  accessKey: string,
): Promise<{ status: number; body: Record<string, unknown>; clientId: string; accessKeyId: string }> {
  const accessKeyId = keyIdsByPlaintext.get(accessKey);
  if (accessKeyId === undefined) throw new Error('runFullAuthFlow was given a key startServer did not create');

  const { clientId, codeVerifier, requestId } = await openAuthorizePage(base);

  const loginRes = await submitAccessKey(base, requestId, accessKey);
  expect(loginRes.status, 'POST /access-login 跳回并带 code').toBe(303);
  const location = loginRes.headers.get('location');
  if (!location) throw new Error('access-login did not redirect');
  const callback = new URL(location);
  expect(callback.searchParams.get('state')).toBe('e2e-state');
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('no code in the access-login redirect');

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
  return { status: tokenRes.status, body, clientId, accessKeyId };
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
  return (await loginThroughMcpWithTransport(base, accessToken)).sessionId;
}

/** 同 loginThroughMcp，但把这次握手拿到的 mcp-session-id 也交回来：
 *  多人隔离那几条用例之后还要在同一条 transport 上发请求。 */
async function loginThroughMcpWithTransport(
  base: string,
  accessToken: string,
): Promise<{ sessionId: string; mcpSessionId: string }> {
  const mcpSessionId = await openMcp(base, accessToken);
  const { isError, payload, raw } = await callTool(base, accessToken, mcpSessionId, 'apple_login', {});
  const sessionId = (payload as { session_id?: unknown }).session_id;
  if (isError || typeof sessionId !== 'string') {
    throw new Error(`apple_login did not return a session_id: ${raw}`);
  }
  return { sessionId, mcpSessionId };
}

/** initialize -> notifications/initialized，返回 mcp-session-id。 */
async function openMcp(base: string, accessToken: string): Promise<string> {
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
  return mcpSessionId;
}

/** tools/call 一个工具，返回它的 isError 与解析过的文本载荷。 */
async function callTool(
  base: string,
  accessToken: string,
  mcpSessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown>; raw: string }> {
  const call = await mcpPost(
    base,
    accessToken,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    mcpSessionId,
  );
  expect(call.status, `tools/call ${name} 失败 —— body: ${call.raw}`).toBe(200);
  const message = call.messages.find((m) => m.id === 2);
  const result = message?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`${name} returned no text content: ${call.raw}`);
  return { isError: result?.isError === true, payload: JSON.parse(text) as Record<string, unknown>, raw: call.raw };
}

/** tools/list，返回 HTTP 状态码与工具名列表（非 200 时列表为空）。 */
async function listTools(
  base: string,
  accessToken: string,
  mcpSessionId: string,
): Promise<{ status: number; names: string[] }> {
  const res = await mcpPost(base, accessToken, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, mcpSessionId);
  const message = res.messages.find((m) => m.id === 3);
  const tools = (message?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
  return { status: res.status, names: tools.map((t) => t.name) };
}

/** DELETE /mcp：客户端正常结束一条 MCP 会话的方式，也是 B 想关掉 A 的连接时会用的方式。 */
async function mcpDelete(base: string, accessToken: string, mcpSessionId: string): Promise<number> {
  const res = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'mcp-session-id': mcpSessionId,
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
  });
  await res.text();
  return res.status;
}

describe('oauth chain end to end (real provider, real store, real port)', () => {
  it('walks register -> authorize -> access-login -> token and yields an access_token', async () => {
    const srv = await startServer();
    try {
      const { status, body } = await runFullAuthFlow(srv.base, srv.accessKey);
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
      const { body } = await runFullAuthFlow(srv.base, srv.accessKey);
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
      const { body, clientId, accessKeyId } = await runFullAuthFlow(srv.base, srv.accessKey);
      const accessToken = body.access_token as string;

      const sessionId = await loginThroughMcp(srv.base, accessToken);
      expect(srv.sessions.size(), 'apple_login 应当建立了一条会话').toBe(1);
      // 带上密钥 id 才取得到：这一句同时证明了密钥 id 从授权页一路传到了会话归属上。
      expect(srv.sessions.get(sessionId, accessKeyId).id, 'session_id 在吊销前必须可用').toBe(sessionId);

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
      // 必须带属主的密钥 id 去取：不带的话归属不符本身就会抛，这条断言就什么也证明不了。
      expect(() => srv.sessions.get(sessionId, accessKeyId), '被吊销的 session_id 必须立刻失效').toThrow();
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
      const { body } = await runFullAuthFlow(srv.base, srv.accessKey);
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

  // 有真人往里输访问密钥的页面。能被第三方站点嵌进 iframe，
  // 就能被盖在别的页面下面骗一次提交。X-Frame-Options 管老浏览器，CSP 的
  // frame-ancestors 是现代等价物，两条都要，覆盖面不完全重合。
  it('serves the access key login page with anti-clickjacking headers', async () => {
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

      // 密钥错时重新渲染的那一份也是同一个页面，必须带同样的头。
      const retry = await submitAccessKey(srv.base, 'nope', 'wrong');
      expect(retry.status).toBe(401);
      expect(retry.headers.get('x-frame-options')).toBe('DENY');
      expect(retry.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    } finally {
      await srv.close();
    }
  });

  it('refuses the admin password on the authorization page', async () => {
    const srv = await startServer();
    try {
      const { requestId } = await openAuthorizePage(srv.base);
      const res = await submitAccessKey(srv.base, requestId, ADMIN_PASSWORD);
      expect(res.status, '管理员口令只管 /admin，授权页上不能再换出授权码').toBe(401);
      expect(res.headers.get('location')).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it('answers a repeated submit of a completed authorization with 200 and the completed page', async () => {
    const srv = await startServer();
    try {
      const { requestId } = await openAuthorizePage(srv.base);
      const first = await submitAccessKey(srv.base, requestId, srv.accessKey);
      expect(first.status).toBe(303);

      const again = await submitAccessKey(srv.base, requestId, srv.accessKey);
      expect(again.status, '授权已经成功，重复提交不该看起来像失败').toBe(200);
      expect(await again.text()).toContain('授权已完成');
      expect(again.headers.get('location'), '不能再签发第二个授权码').toBeNull();
      expect(again.headers.get('cache-control')).toBe('no-store');
      expect(again.headers.get('x-frame-options')).toBe('DENY');
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
      const { body: tokenBody } = await runFullAuthFlow(srv.base, srv.accessKey);
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

describe('multi-person isolation', () => {
  // B 拿到 A 的 mcp-session-id（日志、截图、共享的调试输出里都可能露出来）之后，不能用自己的
  // 令牌在 A 的 transport 上发请求，也不能 DELETE 掉它。表现必须和"这个 id 不存在"一模一样。
  it("B cannot use A's mcp-session-id", async () => {
    const srv = await startServer();
    try {
      const a = await runFullAuthFlow(srv.base, srv.accessKey);
      const b = await runFullAuthFlow(srv.base, srv.accessKeyB);
      const tokenA = a.body.access_token as string;
      const tokenB = b.body.access_token as string;

      const mcpSessionA = await openMcp(srv.base, tokenA);
      expect((await listTools(srv.base, tokenA, mcpSessionA)).status, 'A 在自己的 transport 上可用').toBe(200);

      const stolen = await listTools(srv.base, tokenB, mcpSessionA);
      expect(stolen.status, "B 带 A 的 mcp-session-id 发请求，必须与 id 不存在时一样是 400").toBe(400);
      expect(stolen.names).toEqual([]);

      expect(await mcpDelete(srv.base, tokenB, mcpSessionA), 'B 不能关掉 A 的 transport').toBe(400);
      expect(
        (await listTools(srv.base, tokenA, mcpSessionA)).status,
        'B 的 DELETE 之后 A 的 transport 必须仍然活着',
      ).toBe(200);
    } finally {
      await srv.close();
    }
  });

  // 断言的是会话从 SessionStore 里消失了，不是"之后 /mcp 返回 401"：后者在令牌记录一删时
  // 就自然成立，哪怕一条会话都没销毁。也不能拿"get(sessionA) 抛错"当证据——归属检查本来就
  // 会让 B（或不带密钥的调用方）取 A 的会话时抛错，什么都没销毁时它也是绿的。
  it("cutting off A destroys A's sessions and transports but not B's", async () => {
    const srv = await startServer();
    try {
      const a = await runFullAuthFlow(srv.base, srv.accessKey);
      const b = await runFullAuthFlow(srv.base, srv.accessKeyB);
      const tokenA = a.body.access_token as string;
      const tokenB = b.body.access_token as string;

      const loginA = await loginThroughMcpWithTransport(srv.base, tokenA);
      const loginB = await loginThroughMcpWithTransport(srv.base, tokenB);
      expect(srv.sessions.size(), 'A、B 各一条会话').toBe(2);
      expect(srv.sessions.get(loginA.sessionId, a.accessKeyId).id).toBe(loginA.sessionId);
      expect(srv.closedProviders, '切断之前什么连接都还没关').toEqual([]);

      await srv.cutOffAccessKey(a.accessKeyId);

      expect(srv.sessions.size(), "只剩 B 的那一条会话：A 的必须从 store 里消失").toBe(1);
      expect(srv.sessions.get(loginB.sessionId, b.accessKeyId).id, 'B 的会话不受影响').toBe(loginB.sessionId);
      expect(() => srv.sessions.get(loginA.sessionId, a.accessKeyId), '带着 A 自己的密钥 id 也取不到了').toThrow();
      expect(srv.closedProviders, 'A 的 IMAP 连接必须真的关掉').toContain('imap');

      const afterA = await mcpPost(srv.base, tokenA, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, loginA.mcpSessionId);
      expect(afterA.status, 'A 的令牌已被吊销').toBe(401);

      expect((await listTools(srv.base, tokenB, loginB.mcpSessionId)).status, 'B 照常可用').toBe(200);

      // A 的 transport 也必须已经从表里摘掉：此时让所有 transport 都"过期"，清理器只能找到 B 那一条。
      expect(
        await srv.sweepIdleTransports(Date.now() + appConfig.sessionTtlMs + 1_000),
        "A 的 transport 应当在切断时就已关闭摘除，表里只剩 B 的",
      ).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('turning env accounts off destroys sessions built on env accounts', async () => {
    const srv = await startServer();
    try {
      const a = await runFullAuthFlow(srv.base, srv.accessKey);
      await loginThroughMcp(srv.base, a.body.access_token as string);
      expect(srv.sessions.size()).toBe(1);

      await srv.onEnvAccountsDisabled();

      expect(srv.sessions.size(), 'env 账号建立的会话必须当场消失').toBe(0);
      expect(srv.closedProviders).toContain('imap');
    } finally {
      await srv.close();
    }
  });

  // "朋友登进主人 iCloud"那个反目标的直接测试：`.env` 里有账号，但开关关着。
  it('env accounts disabled: apple_login without envelope fails through /mcp', async () => {
    const srv = await startServer({ envAccountsEnabled: false });
    try {
      const a = await runFullAuthFlow(srv.base, srv.accessKey);
      const token = a.body.access_token as string;
      const mcpSessionId = await openMcp(srv.base, token);

      const login = await callTool(srv.base, token, mcpSessionId, 'apple_login', {});
      expect(login.isError).toBe(true);
      expect((login.payload.error as { code?: string }).code).toBe('INVALID_INPUT');
      expect(srv.sessions.size(), '一条会话都不能建').toBe(0);

      const accounts = await callTool(srv.base, token, mcpSessionId, 'apple_accounts', {});
      expect(accounts.payload, '开关关着时 apple_accounts 不列出 env 账号').toEqual([]);
    } finally {
      await srv.close();
    }
  });

  // 远程入口的账号在登录时才出现（信封），注册阶段看不到任何能力：按 env 账号的能力决定注册
  // 哪些模块的话，零个 env 账号的服务器就只剩三个会话工具，信封登录进来什么也做不了。
  it('remote entry registers all 25 tools even with zero env accounts', async () => {
    const srv = await startServer({ accounts: [] });
    try {
      const a = await runFullAuthFlow(srv.base, srv.accessKey);
      const token = a.body.access_token as string;
      const mcpSessionId = await openMcp(srv.base, token);
      const listed = await listTools(srv.base, token, mcpSessionId);
      expect(listed.status).toBe(200);
      expect(listed.names).toHaveLength(25);
      expect(listed.names).toContain('apple_login');
      expect(listed.names).toContain('mail_send');
      expect(listed.names).toContain('contacts_search');
    } finally {
      await srv.close();
    }
  });
});

const FRIEND_ENV = { ICLOUD_ACCOUNT_1: 'friend@icloud.com', ICLOUD_APP_PASSWORD_1: 'friend-app-password' };

describe('envelope login', () => {
  // 远程入口的目标场景：主人的 env 账号开关关着，朋友用自己的访问密钥 B 加自己封的信封登录。
  it('a friend logs in with an envelope, uses a tool, and work_done ends it', async () => {
    const srv = await startServer({ envAccountsEnabled: false, withEnvelope: true });
    try {
      const keyring = srv.keyring as EnvelopeKeyring;
      const b = await runFullAuthFlow(srv.base, srv.accessKeyB);
      const token = b.body.access_token as string;
      const mcpSessionId = await openMcp(srv.base, token);

      const login = await callTool(srv.base, token, mcpSessionId, 'apple_login', {
        envelope: sealEnvelope(keyring.publicKeyText, FRIEND_ENV),
      });
      expect(login.isError, `信封登录失败：${login.raw}`).toBe(false);
      expect(login.payload.account).toBe('friend@icloud.com');
      expect(login.payload, '没有降级说明时不出现 notices').not.toHaveProperty('notices');
      expect(login.raw, '响应里绝不能回显 App 专用密码').not.toContain(FRIEND_ENV.ICLOUD_APP_PASSWORD_1);
      const sessionId = login.payload.session_id as string;
      expect(srv.sessions.size()).toBe(1);
      expect(srv.sessions.get(sessionId, b.accessKeyId).account.origin).toBe('envelope');

      const calendars = await callTool(srv.base, token, mcpSessionId, 'calendar_list', { session_id: sessionId });
      expect(calendars.isError, `calendar_list 失败：${calendars.raw}`).toBe(false);
      expect(calendars.payload).toEqual([]);

      const done = await callTool(srv.base, token, mcpSessionId, 'work_done', { session_id: sessionId });
      expect(done.payload).toEqual({ success: true });
      expect(srv.sessions.size()).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('replaying the same envelope through /mcp is refused', async () => {
    const srv = await startServer({ envAccountsEnabled: false, withEnvelope: true });
    try {
      const keyring = srv.keyring as EnvelopeKeyring;
      const b = await runFullAuthFlow(srv.base, srv.accessKeyB);
      const token = b.body.access_token as string;
      const mcpSessionId = await openMcp(srv.base, token);
      const envelope = sealEnvelope(keyring.publicKeyText, FRIEND_ENV);

      const first = await callTool(srv.base, token, mcpSessionId, 'apple_login', { envelope });
      expect(first.isError).toBe(false);

      const replay = await callTool(srv.base, token, mcpSessionId, 'apple_login', { envelope });
      expect(replay.isError).toBe(true);
      const error = replay.payload.error as { code?: string; message?: string };
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe('这个信封已经用过');
      expect(srv.sessions.size(), '重放不能多建一条会话').toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('the admin dashboard shows the envelope public key', async () => {
    const srv = await startServer({ envAccountsEnabled: false, withEnvelope: true });
    try {
      const keyring = srv.keyring as EnvelopeKeyring;
      const loginRes = await fetch(`${srv.base}/admin/login`, {
        method: 'POST',
        // 管理页的 POST 要求 Origin 恰好是 PUBLIC_URL 的 origin（startServer 里的 publicUrl）。
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:19999' },
        redirect: 'manual',
        body: new URLSearchParams({ password: ADMIN_PASSWORD }).toString(),
      });
      expect(loginRes.status, '管理员登录').toBe(303);
      const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] as string;
      expect(cookie).toMatch(/^amcp_admin=/);

      const dashboard = await fetch(`${srv.base}/admin`, { headers: { cookie }, redirect: 'manual' });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain(keyring.publicKeyText);
    } finally {
      await srv.close();
    }
  });

  it('tools/list advertises envelope on apple_login', async () => {
    const srv = await startServer({ envAccountsEnabled: false, withEnvelope: true });
    try {
      const b = await runFullAuthFlow(srv.base, srv.accessKeyB);
      const token = b.body.access_token as string;
      const mcpSessionId = await openMcp(srv.base, token);
      const res = await mcpPost(srv.base, token, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, mcpSessionId);
      expect(res.status).toBe(200);
      const tools =
        (res.messages.find((m) => m.id === 3)?.result as
          | { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, { description?: string }> } }> }
          | undefined)?.tools ?? [];
      const login = tools.find((t) => t.name === 'apple_login');
      const envelopeProp = login?.inputSchema?.properties?.envelope;
      expect(envelopeProp, 'apple_login 的 schema 里必须有 envelope').toBeDefined();
      expect(envelopeProp?.description).toBe(
        '远程入口的登录凭据：运行 node scripts/make-envelope.mjs 得到的一整行，原样传入。与 account 二选一。',
      );
    } finally {
      await srv.close();
    }
  });
});
