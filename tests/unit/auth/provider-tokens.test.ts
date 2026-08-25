import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createOAuthProvider } from '../../../src/auth/provider.js';
import { createAuthStore } from '../../../src/auth/store.js';
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

function makeSessions(): SessionStore {
  destroyByToken = vi.fn().mockResolvedValue(0);
  return { destroyByToken } as unknown as SessionStore;
}

async function makeProvider(
  opts: { accessTokenTtlMs?: number; refreshTokenTtlMs?: number; authCodeTtlMs?: number } = {},
) {
  dir = mkdtempSync(join(tmpdir(), 'provider-'));
  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();
  await store.registerClient({ client_id: 'client-1', redirect_uris: [REDIRECT] });
  const provider = createOAuthProvider({ store, sessions: makeSessions(), logger, ...opts });
  return { provider, store };
}

/** 走完一次完整授权，返回一对令牌。 */
async function authorizeOnce(provider: Awaited<ReturnType<typeof makeProvider>>['provider']) {
  const code = provider.issueAuthorizationCode({
    clientId: 'client-1',
    redirectUri: REDIRECT,
    codeChallenge: 'challenge-abc',
    scopes: ['mcp'],
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
