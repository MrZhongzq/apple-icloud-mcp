import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createOAuthProvider } from '../../../src/auth/provider.js';
import { createAuthStore } from '../../../src/auth/store.js';
import { decryptJson } from '../../../src/auth/crypto.js';
import { authenticateClient } from '@modelcontextprotocol/sdk/server/auth/middleware/clientAuth.js';
import { createLogger } from '../../../src/core/logger.js';
import type { SessionStore } from '../../../src/core/session.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { expectNoSecretLeak } from '../../helpers/no-secret-leak.js';

const logger = createLogger('error', () => {});
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const client = {
  client_id: 'client-1',
  redirect_uris: [REDIRECT],
} as OAuthClientInformationFull;

let dir: string;
let destroyByToken: ReturnType<typeof vi.fn>;
/** makeProvider 建的那把访问密钥的 id；签发授权码时都凭它。 */
let keyId: string;

function makeSessions(): SessionStore {
  destroyByToken = vi.fn().mockResolvedValue(0);
  return { destroyByToken } as unknown as SessionStore;
}

async function makeProvider(
  opts: { accessTokenTtlMs?: number; refreshTokenTtlMs?: number; authCodeTtlMs?: number } = {},
) {
  dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const path = join(dir, 'tokens.json.enc');
  const key = randomBytes(32);
  const store = createAuthStore({ path, key, logger });
  await store.load();
  await store.registerClient({ client_id: 'client-1', redirect_uris: [REDIRECT] });
  keyId = (await store.createAccessKey('tester')).record.id;
  const provider = createOAuthProvider({ store, sessions: makeSessions(), logger, accessKeys: store, ...opts });
  return { provider, store, path, key };
}

/** 直接读磁盘快照：只有在这一层才看得见"同一条记录被写了两遍"这类问题。 */
function readSnapshot(path: string, key: Buffer): { clients: unknown[]; tokens: unknown[] } {
  return decryptJson<{ clients: unknown[]; tokens: unknown[] }>(readFileSync(path, 'utf8'), key);
}

/** 走完一次完整授权，返回一对令牌。 */
async function authorizeOnce(provider: Awaited<ReturnType<typeof makeProvider>>['provider']) {
  const code = provider.issueAuthorizationCode({
    clientId: 'client-1',
    redirectUri: REDIRECT,
    codeChallenge: 'challenge-abc',
    scopes: ['mcp'],
    accessKeyId: keyId,
  });
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  return { code, tokens };
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('authorization codes', () => {
  it('exchanges a fresh code for an access and refresh token', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  it('refuses to exchange the same code twice', async () => {
    const { provider } = await makeProvider();
    const { code } = await authorizeOnce(provider);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT),
      '授权码必须一次性 —— 重放是最基本的攻击',
    ).rejects.toThrow();
  });

  it('refuses a code whose redirect_uri does not match the one it was issued for', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/cb'),
    ).rejects.toThrow();
  });

  it('refuses a code issued to a different client', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'someone-else',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT)).rejects.toThrow();
  });

  it('discards a code after a failed exchange, so it cannot be retried', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/cb'),
    ).rejects.toThrow();
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT),
      '用错过一次的码不该还能正确地再用一次',
    ).rejects.toThrow();
  });

  it('refuses a code when the token request omits redirect_uri entirely', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    // SDK 的 token schema 把 redirect_uri 标为 optional，所以「不发」是客户端能做到的事，
    // 而签发时总是记录了具体的 redirect_uri —— RFC 6749 §4.1.3 要求必须回比。
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, undefined)).rejects.toThrow();
  });

  it('expires a code that is older than its ttl', async () => {
    const { provider } = await makeProvider({ authCodeTtlMs: 1 });
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT)).rejects.toThrow();
  });

  it('returns the stored challenge so the sdk can verify pkce', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe('challenge-abc');
  });

  it('leaves pkce validation to the sdk', async () => {
    const { provider } = await makeProvider();
    expect(
      provider.skipLocalPkceValidation ?? false,
      'true 会把 PKCE 校验推给上游，而这里没有上游',
    ).toBe(false);
  });

  it('never carries a token, code or hash in an error', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp'],
      accessKeyId: keyId,
    });
    const { tokens } = await authorizeOnce(provider);

    const codeErr = await provider
      .exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/cb')
      .catch((e: unknown) => e);
    expectNoSecretLeak(codeErr, [code]);

    const tokenErr = await provider.verifyAccessToken('made-up-token').catch((e: unknown) => e);
    expectNoSecretLeak(tokenErr, ['made-up-token', tokens.access_token, tokens.refresh_token!]);
  });
});

describe('access tokens', () => {
  it('verifies a freshly issued access token', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('client-1');
    expect(info.scopes).toEqual(['mcp']);
  });

  it('rejects a token it never issued', async () => {
    const { provider } = await makeProvider();
    await expect(provider.verifyAccessToken('made-up-token')).rejects.toThrow();
  });

  it('rejects an expired access token', async () => {
    const { provider } = await makeProvider({ accessTokenTtlMs: 1 });
    const { tokens } = await authorizeOnce(provider);
    await new Promise((r) => setTimeout(r, 20));
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
});

describe('refresh rotation', () => {
  it('issues a new pair and invalidates the old refresh token', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const next = await provider.exchangeRefreshToken(client, tokens.refresh_token!);

    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await provider.verifyAccessToken(next.access_token)).toBeTruthy();
  });

  it('treats reuse of a rotated refresh token as theft and revokes the whole family', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const next = await provider.exchangeRefreshToken(client, tokens.refresh_token!);

    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!),
      '已轮换的刷新令牌再次出现 = 泄露信号',
    ).rejects.toThrow();

    await expect(
      provider.verifyAccessToken(next.access_token),
      '泄露信号出现后，同族的新令牌也必须一起失效',
    ).rejects.toThrow();
  });

  it('destroys the live MCP sessions of a revoked family', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    destroyByToken.mockClear();

    await provider.exchangeRefreshToken(client, tokens.refresh_token!).catch(() => undefined);

    expect(
      destroyByToken,
      '只删令牌不断会话，等于拿走门票却让人继续待在屋里',
    ).toHaveBeenCalledTimes(1);
  });

  // RFC 6749 §6：刷新请求带的 scope 必须是原始授权的子集。
  it('accepts a refresh that narrows the scope to a subset of the original grant', async () => {
    const { provider } = await makeProvider();
    const code = provider.issueAuthorizationCode({
      clientId: 'client-1',
      redirectUri: REDIRECT,
      codeChallenge: 'challenge-abc',
      scopes: ['mcp', 'extra'],
      accessKeyId: keyId,
    });
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);

    const next = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ['mcp']);
    expect(next.scope).toBe('mcp');
  });

  it('rejects a refresh that asks for a scope outside the original grant', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider); // 只被授予 ['mcp']

    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!, ['admin', 'anything-i-want']),
      '刷新令牌不能用来扩权：拿到的 scope 只能是原授权的子集',
    ).rejects.toThrow(/scope/i);
  });

  // 每次刷新都把同一条新记录写两遍（issueTokenPair 一次 saveTokens，rotateRefresh 再 push
  // 一次），快照因此以约两倍速度增长。这条测试直接数磁盘上的记录条数。
  it('writes exactly one token record per issuance, not two', async () => {
    const { provider, path, key } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);

    let refresh = tokens.refresh_token!;
    for (let i = 0; i < 3; i += 1) {
      const next = await provider.exchangeRefreshToken(client, refresh);
      refresh = next.refresh_token!;
    }

    expect(readSnapshot(path, key).tokens, '一次授权 + 三次刷新 = 四条记录').toHaveLength(4);
  });

  it('rejects a refresh token belonging to another client', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);
    const other = { client_id: 'client-2', redirect_uris: [REDIRECT] } as OAuthClientInformationFull;
    await expect(provider.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow();
  });
});

describe('revocation', () => {
  it('revokes an access token and its family, and destroys the sessions', async () => {
    const { provider } = await makeProvider();
    const { tokens } = await authorizeOnce(provider);

    await provider.revokeToken!(client, { token: tokens.access_token });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
    expect(destroyByToken).toHaveBeenCalled();
  });

  it('does nothing, and does not throw, for an unknown token', async () => {
    const { provider } = await makeProvider();
    await expect(provider.revokeToken!(client, { token: 'never-existed' })).resolves.toBeUndefined();
  });
});

/**
 * SDK 的客户端认证检查写作 `if (client.client_secret_expires_at && … < now)`——字段缺席时
 * 整段被跳过。而 `/register` 的 201 响应里这个字段是有的（注册处理器自己算好了 30 天后的
 * 时刻）。所以这里跑的是 SDK 真正那段中间件，而不是我们自己重写一遍判断：要验证的正是
 * "服务器说的过期时间会不会被自己执行"。
 */
describe('client secret expiry', () => {
  async function authenticate(
    provider: Awaited<ReturnType<typeof makeProvider>>['provider'],
    body: { client_id: string; client_secret?: string },
  ): Promise<{ status?: number; passed: boolean }> {
    const middleware = authenticateClient({ clientsStore: provider.clientsStore });
    let status: number | undefined;
    let passed = false;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json() {
        return res;
      },
    };
    await middleware({ body } as never, res as never, () => {
      passed = true;
    });
    return { status, passed };
  }

  it('rejects a confidential client whose secret has expired', async () => {
    const { provider, store } = await makeProvider();
    await store.registerClient({
      client_id: 'confidential-1',
      client_secret: 'top-secret',
      client_secret_expires_at: Math.floor(Date.now() / 1000) - 60,
      redirect_uris: [REDIRECT],
    });

    const result = await authenticate(provider, {
      client_id: 'confidential-1',
      client_secret: 'top-secret',
    });
    expect(result.passed, '过期的 client_secret 必须被拒，否则泄露的密钥永久有效').toBe(false);
    expect(result.status).toBe(400);
  });

  it('still accepts a confidential client whose secret has not expired', async () => {
    const { provider, store } = await makeProvider();
    await store.registerClient({
      client_id: 'confidential-2',
      client_secret: 'top-secret',
      client_secret_expires_at: Math.floor(Date.now() / 1000) + 3600,
      redirect_uris: [REDIRECT],
    });

    const result = await authenticate(provider, {
      client_id: 'confidential-2',
      client_secret: 'top-secret',
    });
    expect(result.passed).toBe(true);
  });

  it('persists the expiry the registration response promised, and hands it back on lookup', async () => {
    const { provider } = await makeProvider();
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

    const registered = await provider.clientsStore.registerClient!({
      client_secret: 'top-secret',
      client_secret_expires_at: expiresAt,
      redirect_uris: [REDIRECT],
    } as never);
    expect(registered.client_secret_expires_at, '201 响应里承诺的过期时刻').toBe(expiresAt);

    const fetched = await provider.clientsStore.getClient(registered.client_id);
    expect(fetched?.client_secret_expires_at, '查出来的必须是同一个时刻，否则承诺永不兑现').toBe(
      expiresAt,
    );
  });
});

describe('authorize (login page)', () => {
  function fakeRes() {
    const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
    const res = {
      set(k: string, v: string) {
        sent.headers[k] = v;
        return res;
      },
      status(code: number) {
        sent.status = code;
        return res;
      },
      send(body: string) {
        sent.body = body;
        return res;
      },
      redirect(url: string) {
        sent.body = `REDIRECT:${url}`;
        return res;
      },
    };
    return { res: res as never, sent };
  }

  it('refuses to redirect to an unregistered redirect_uri', async () => {
    const { provider } = await makeProvider();
    const { res, sent } = fakeRes();

    await provider.authorize(
      { client_id: 'client-1', redirect_uris: [REDIRECT] } as OAuthClientInformationFull,
      { redirectUri: 'https://evil.example/cb', codeChallenge: 'c', scopes: ['mcp'], state: 's' },
      res,
    );

    expect(sent.status, '未注册的 redirect_uri 必须走错误页，不是跳转').toBe(400);
    expect(sent.body ?? '', '一旦跳转到未注册地址，这就是开放重定向本身').not.toContain('REDIRECT:');
    expect(sent.body ?? '').not.toContain('evil.example');
  });

  it('renders the login page for a registered redirect_uri', async () => {
    const { provider } = await makeProvider();
    const { res, sent } = fakeRes();

    await provider.authorize(
      { client_id: 'client-1', redirect_uris: [REDIRECT] } as OAuthClientInformationFull,
      { redirectUri: REDIRECT, codeChallenge: 'c', scopes: ['mcp'], state: 's' },
      res,
    );

    expect(sent.status).toBeUndefined();
    expect(sent.headers['Cache-Control']).toBe('no-store');
    expect(sent.body ?? '').toContain('type="password"');
  });
});
