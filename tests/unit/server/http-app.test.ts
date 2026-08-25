import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpApp } from '../../../src/server/httpApp.js';
import { createLogger } from '../../../src/core/logger.js';
import type { AppConfig } from '../../../src/core/config.js';
import type { SessionStore } from '../../../src/core/session.js';

const logger = createLogger('error', () => {});

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

const httpConfig = {
  port: 17733,
  publicUrl: new URL('https://mcp.example.com'),
  adminPasswordHash: 'scrypt$32768$8$1$c2FsdA$aGFzaA',
  tokenStorePath: './data/tokens.json.enc',
  encryptionKey: Buffer.alloc(32),
};

let verifyAccessToken: ReturnType<typeof vi.fn>;

function makeProvider() {
  verifyAccessToken = vi.fn().mockRejectedValue(new Error('nope'));
  return {
    clientsStore: { getClient: vi.fn(), registerClient: vi.fn() },
    authorize: vi.fn(),
    challengeForAuthorizationCode: vi.fn(),
    exchangeAuthorizationCode: vi.fn(),
    exchangeRefreshToken: vi.fn(),
    verifyAccessToken,
    revokeToken: vi.fn(),
    issueAuthorizationCode: vi.fn(),
    sweep: vi.fn(),
  } as never;
}

function build() {
  return createHttpApp({
    config: appConfig,
    httpConfig,
    sessions: { create: vi.fn(), get: vi.fn(), destroyByToken: vi.fn() } as unknown as SessionStore,
    provider: makeProvider(),
    logger,
  });
}

/** 不占端口地打一个请求：用 supertest 风格的最小封装。
 *  也把响应头带回去——CORS 只写头，不写 body，早前的 CORS 测试只断言 body，
 *  因此不管中间件把 Access-Control-Allow-Origin 反射成什么，断言都为真：
 *  这个测试结构上不可能变红。 */
async function request(
  app: import('express').Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return { status: res.status, body: await res.text(), headers: responseHeaders };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('health endpoint', () => {
  it('answers without authentication', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });

  it('discloses nothing about the deployment', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health');
    const body = res.body.toLowerCase();
    // 公开端点说的每一句话都是在对扫描者说
    expect(body).not.toContain('icloud.com');
    expect(body).not.toContain('account');
    expect(body).not.toContain('version');
    expect(body).not.toContain('session');
  });
});

describe('mcp endpoint authentication', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = build();
    const res = await request(app, 'POST', '/mcp');
    expect(res.status, '/mcp 必须在 requireBearerAuth 之后 —— 顺序弄反整个阶段就白做了').toBe(401);
  });

  it('rejects a bearer token the provider does not recognise', async () => {
    const { app } = build();
    const res = await request(app, 'POST', '/mcp', { authorization: 'Bearer made-up' });
    expect(res.status).toBe(401);
    expect(verifyAccessToken).toHaveBeenCalledWith('made-up');
  });

  it('never echoes the presented token back', async () => {
    const { app } = build();
    const res = await request(app, 'POST', '/mcp', { authorization: 'Bearer super-secret-token' });
    expect(res.body).not.toContain('super-secret-token');
  });

  // express.json() 曾经挂在 requireBearerAuth 之前：一个没带 Authorization 头、body 又是
  // 畸形 JSON 的请求，会先摸到 body-parser，body-parser 抛出的 SyntaxError 没人接住，
  // 从 Express 默认错误页里带着堆栈和文件系统绝对路径漏出去——不需要任何凭据就能拿到。
  it('never leaks a stack trace or filesystem paths for an unauthenticated malformed body', async () => {
    const { app } = build();
    const res = await request(
      app,
      'POST',
      '/mcp',
      { 'content-type': 'application/json' },
      '{not valid json',
    );
    expect(res.status, "requireBearerAuth 必须先于 body 解析器：未认证请求根本不该被解析").toBe(401);
    expect(res.body, "Express 默认错误页会带 <pre>").not.toContain("<pre>");
    expect(res.body, "不能带堆栈行").not.toContain("at ");
    expect(res.body, "不能带文件系统路径").not.toContain("node_modules");
  });
});

describe('oauth metadata', () => {
  it('serves authorization server metadata at the well-known path', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = JSON.parse(res.body);
    expect(meta.issuer).toContain('mcp.example.com');
    expect(meta.code_challenge_methods_supported, 'PKCE 必须声明 S256').toContain('S256');
  });
});

describe('cors', () => {
  it('does not reflect a disallowed origin', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health', { origin: 'https://evil.example' });
    // body 断言留着——CORS 只写头，这条从结构上就测不出反射，但删掉它又会丢失
    // "body 里也不该出现攻击者的 origin" 这条独立的信息泄露检查，两条断言查的是不同的事。
    expect(res.body).not.toContain('evil.example');
    expect(
      res.headers['access-control-allow-origin'],
      '不允许的 origin 不能拿到 Access-Control-Allow-Origin —— 反射任意来源的开始',
    ).not.toBe('https://evil.example');
  });

  it('allows the configured public origin', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health', { origin: httpConfig.publicUrl.origin });
    expect(
      res.headers['access-control-allow-origin'],
      'PUBLIC_URL 自己的来源必须被放行，否则合法客户端也连不上',
    ).toBe(httpConfig.publicUrl.origin);
  });

  it('allows https://claude.ai', async () => {
    const { app } = build();
    const res = await request(app, 'GET', '/health', { origin: 'https://claude.ai' });
    expect(res.headers['access-control-allow-origin']).toBe('https://claude.ai');
  });
});
