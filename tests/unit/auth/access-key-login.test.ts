import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createOAuthProvider } from '../../../src/auth/provider.js';
import { createAuthStore } from '../../../src/auth/store.js';
import { createPendingStore, handleLoginSubmit } from '../../../src/auth/login.js';
import { hashToken } from '../../../src/auth/crypto.js';
import { createLogger } from '../../../src/core/logger.js';
import { ACCESS_KEY_ID_KEY, TOKEN_FAMILY_KEY, type SessionStore } from '../../../src/core/session.js';

/**
 * 访问密钥授权的整条链：登录页提交密钥 → 授权码带着密钥 id → 兑换出的令牌记录带着它 →
 * verifyAccessToken 把它放进 AuthInfo.extra。全部用真的 provider、store、pending store：
 * 这条链上任何一环漏传，工具层拿到的就是 undefined，按密钥隔离会话这件事就整个落空——
 * 和 CLAUDE.md 里令牌家族那次「三个单测各自 mock 掉要测的那一环」是同一种失败方式。
 */

const logger = createLogger('error', () => {});
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ADMIN_PASSWORD = 'a-long-admin-password';
const ASCII_ONLY = /^[\x20-\x7e]+$/;
const WRONG_KEY_ERROR = '访问密钥不正确或已停用，请重试';

const client = { client_id: 'client-1', redirect_uris: [REDIRECT] } as OAuthClientInformationFull;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'access-key-login-'));
  dirs.push(dir);
  const store = createAuthStore({ path: join(dir, 'tokens.json.enc'), key: randomBytes(32), logger });
  await store.load();
  await store.registerClient({ client_id: 'client-1', redirect_uris: [REDIRECT] });
  const pending = createPendingStore();
  const sessions = { destroyByToken: vi.fn().mockResolvedValue(0) } as unknown as SessionStore;
  const provider = createOAuthProvider({ store, sessions, logger, pending, accessKeys: store });
  const { record, plaintext } = await store.createAccessKey('alice');
  const deps = {
    findAccessKey: (p: string) => store.findAccessKeyByPlaintext(p),
    provider,
    logger,
    pending,
  };
  return { store, pending, provider, record, plaintext, deps };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function newRequest(pending: Setup['pending']): string {
  return pending.put({
    client_id: 'client-1',
    redirect_uri: REDIRECT,
    code_challenge: 'challenge-abc',
    scopes: ['mcp'],
    state: 'st',
    expires_at: Date.now() + 600_000,
  });
}

function codeFrom(result: ReturnType<typeof handleLoginSubmit>): string {
  if (!('redirectTo' in result)) throw new Error(`expected a redirect, got ${JSON.stringify(result)}`);
  const code = new URL(result.redirectTo).searchParams.get('code');
  if (!code) throw new Error('redirect carried no code');
  return code;
}

/** 登录页提交 → 兑换授权码，返回一对令牌。 */
async function authorize(s: Setup) {
  const requestId = newRequest(s.pending);
  const code = codeFrom(handleLoginSubmit(s.deps, { requestId, accessKey: s.plaintext }));
  return s.provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
}

describe('authorizing with an access key', () => {
  it('a valid enabled key issues a code that carries the key id through to AuthInfo.extra', async () => {
    const s = await setup();
    const tokens = await authorize(s);
    const info = await s.provider.verifyAccessToken(tokens.access_token);

    expect(info.extra?.[ACCESS_KEY_ID_KEY], '密钥 id 必须一路带到 AuthInfo.extra').toBe(s.record.id);
    const family = info.extra?.[TOKEN_FAMILY_KEY];
    expect(typeof family).toBe('string');
    expect((family as string).length).toBeGreaterThan(0);
  });

  it('a wrong or disabled key gets the same error', async () => {
    const s = await setup();
    const requestId = newRequest(s.pending);

    const wrong = handleLoginSubmit(s.deps, { requestId, accessKey: 'amk_not-a-real-key' });
    expect(wrong).toEqual({ error: WRONG_KEY_ERROR });

    const other = await s.store.createAccessKey('bob');
    await s.store.setAccessKeyEnabled(other.record.id, false);
    const disabled = handleLoginSubmit(s.deps, { requestId, accessKey: other.plaintext });
    expect(disabled, '停用的密钥与错误的密钥不该能从提示上区分').toEqual({ error: WRONG_KEY_ERROR });

    const ok = handleLoginSubmit(s.deps, { requestId, accessKey: s.plaintext });
    expect('redirectTo' in ok, '输错之后同一个 requestId 仍然可用').toBe(true);
  });

  it('the admin password is no longer accepted on the authorization page', async () => {
    const s = await setup();
    const requestId = newRequest(s.pending);
    const result = handleLoginSubmit(s.deps, { requestId, accessKey: ADMIN_PASSWORD });
    expect(result).toEqual({ error: WRONG_KEY_ERROR });
  });

  it('a second submit of a completed request reports alreadyCompleted', async () => {
    const s = await setup();
    const requestId = newRequest(s.pending);
    const first = handleLoginSubmit(s.deps, { requestId, accessKey: s.plaintext });
    expect('redirectTo' in first).toBe(true);
    expect(s.pending.wasCompleted(requestId)).toBe(true);

    const second = handleLoginSubmit(s.deps, { requestId, accessKey: s.plaintext });
    expect(second, '刷新/重复提交不该显示成「请求已过期」').toEqual({ alreadyCompleted: true });
  });

  it('disabling the key between login and code exchange makes the exchange fail', async () => {
    const s = await setup();
    const requestId = newRequest(s.pending);
    const code = codeFrom(handleLoginSubmit(s.deps, { requestId, accessKey: s.plaintext }));
    await s.store.setAccessKeyEnabled(s.record.id, false);

    const err = await s.provider
      .exchangeAuthorizationCode(client, code, undefined, REDIRECT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect((err as Error).message).toMatch(ASCII_ONLY);
  });
});

describe('access tokens bound to an access key', () => {
  it('verifyAccessToken rejects tokens of a disabled or deleted key', async () => {
    const s = await setup();
    const tokens = await authorize(s);
    await s.store.setAccessKeyEnabled(s.record.id, false);
    const disabledErr = await s.provider.verifyAccessToken(tokens.access_token).catch((e: unknown) => e);
    expect(disabledErr).toBeInstanceOf(InvalidTokenError);
    expect((disabledErr as Error).message).toMatch(ASCII_ONLY);

    await s.store.setAccessKeyEnabled(s.record.id, true);
    await s.store.deleteAccessKey(s.record.id);
    const deletedErr = await s.provider.verifyAccessToken(tokens.access_token).catch((e: unknown) => e);
    expect(deletedErr, '删除密钥本身不吊销令牌记录，verify 必须自己看密钥还在不在').toBeInstanceOf(
      InvalidTokenError,
    );
    expect((deletedErr as Error).message).toMatch(ASCII_ONLY);
  });

  it('verifyAccessToken rejects a legacy token without access_key_id', async () => {
    const s = await setup();
    const now = Date.now();
    await s.store.saveTokens({
      family_id: 'legacy-family',
      client_id: 'client-1',
      access_token_hash: hashToken('legacy-access-token'),
      refresh_token_hash: hashToken('legacy-refresh-token'),
      scopes: ['mcp'],
      access_expires_at: now + 3600_000,
      refresh_expires_at: now + 3600_000,
      rotated: false,
    });
    const err = await s.provider.verifyAccessToken('legacy-access-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect((err as Error).message).toMatch(ASCII_ONLY);
  });

  it('refresh keeps access_key_id and refuses a disabled key', async () => {
    const s = await setup();
    const tokens = await authorize(s);
    const next = await s.provider.exchangeRefreshToken(client, tokens.refresh_token!);
    const info = await s.provider.verifyAccessToken(next.access_token);
    expect(info.extra?.[ACCESS_KEY_ID_KEY], '刷新出来的令牌必须还属于同一把密钥').toBe(s.record.id);

    await s.store.setAccessKeyEnabled(s.record.id, false);
    const err = await s.provider.exchangeRefreshToken(client, next.refresh_token!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect((err as Error).message).toMatch(ASCII_ONLY);
  });

  it('verifyAccessToken updates last_used_at', async () => {
    const s = await setup();
    const tokens = await authorize(s);
    expect(s.store.getAccessKey(s.record.id)?.last_used_at).toBeUndefined();
    await s.provider.verifyAccessToken(tokens.access_token);
    expect(s.store.getAccessKey(s.record.id)?.last_used_at).toBeTypeOf('number');
  });
});
