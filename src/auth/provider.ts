import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthStore, StoredToken } from './store.js';
import { generateToken, hashToken } from './crypto.js';
import type { Logger } from '../core/logger.js';
import type { SessionStore } from '../core/session.js';

const DEFAULT_ACCESS_TOKEN_TTL_MS = 3600_000;
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
const DEFAULT_AUTH_CODE_TTL_MS = 60_000;

/**
 * `SessionStore.destroyByToken` 不属于本任务：它由 Task 5 加到 `src/core/session.ts` 上，
 * 本任务只按裁定五给出的签名去调用它，不实现、不改动 session.ts。这里本地声明这一个方法，
 * 调用处对 `sessions` 做一次窄化转换 —— 测试通过 `as unknown as SessionStore` 注入一个
 * `vi.fn()` 充当假实现。
 */
interface SessionStoreWithTokenDestroy extends SessionStore {
  destroyByToken(familyId: string): Promise<number>;
}

/** 一次签发的授权码，纯内存持有，绝不落盘 —— 它活得比一次页面跳转还短。 */
export interface PendingCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  expires_at: number;
}

export interface AppleOAuthProvider extends OAuthServerProvider {
  /** 由 Task 4 的登录流程调用：管理员通过校验后签发一次性授权码，返回原始码。 */
  issueAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
  }): string;
  /** 定期清理过期授权码与令牌，返回清理条数。 */
  sweep(): Promise<number>;
}

export function createOAuthProvider(deps: {
  store: AuthStore;
  sessions: SessionStore;
  logger: Logger;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  authCodeTtlMs?: number;
}): AppleOAuthProvider {
  const { store, logger } = deps;
  const sessions = deps.sessions as SessionStoreWithTokenDestroy;
  const accessTokenTtlMs = deps.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS;
  const refreshTokenTtlMs = deps.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS;
  const authCodeTtlMs = deps.authCodeTtlMs ?? DEFAULT_AUTH_CODE_TTL_MS;

  /** 授权码只在内存里活着：Map<hashToken(code), PendingCode>。 */
  const pendingCodes = new Map<string, PendingCode>();

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      const stored = await store.getClient(clientId);
      if (!stored) return undefined;
      return {
        client_id: stored.client_id,
        client_secret: stored.client_secret,
        redirect_uris: stored.redirect_uris,
        client_name: stored.client_name,
      } as OAuthClientInformationFull;
    },
    async registerClient(
      client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
    ): Promise<OAuthClientInformationFull> {
      const clientId = randomUUID();
      const saved = await store.registerClient({
        client_id: clientId,
        client_secret: client.client_secret,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
      });
      return {
        ...client,
        client_id: saved.client_id,
        client_secret: saved.client_secret,
        client_id_issued_at: Math.floor(saved.created_at / 1000),
      } as OAuthClientInformationFull;
    },
  };

  function issueAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
  }): string {
    const code = generateToken();
    const codeHash = hashToken(code);
    pendingCodes.set(codeHash, {
      code_hash: codeHash,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      scopes: params.scopes,
      expires_at: Date.now() + authCodeTtlMs,
    });
    return code;
  }

  /** 签发一对新令牌并落盘，返回 SDK 期望的响应形状。 */
  async function issueTokenPair(
    clientId: string,
    scopes: string[],
    familyId: string,
  ): Promise<{ tokens: OAuthTokens; record: StoredToken }> {
    const accessToken = generateToken();
    const refreshToken = generateToken();
    const now = Date.now();
    const record: StoredToken = {
      family_id: familyId,
      client_id: clientId,
      access_token_hash: hashToken(accessToken),
      refresh_token_hash: hashToken(refreshToken),
      scopes,
      access_expires_at: now + accessTokenTtlMs,
      refresh_expires_at: now + refreshTokenTtlMs,
      rotated: false,
    };
    await store.saveTokens(record);
    const tokens: OAuthTokens = {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(accessTokenTtlMs / 1000),
      scope: scopes.join(' '),
    };
    return { tokens, record };
  }

  async function challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = pendingCodes.get(hashToken(authorizationCode));
    if (!pending || pending.expires_at <= Date.now()) {
      throw new InvalidGrantError('授权码不存在或已过期');
    }
    return pending.code_challenge;
  }

  async function exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const pending = pendingCodes.get(codeHash);
    // 先删，再校验：任何失败路径都不能留下一个还能再试一次的码。
    pendingCodes.delete(codeHash);

    if (!pending) {
      throw new InvalidGrantError('授权码不存在、已被使用或已过期');
    }
    if (pending.expires_at <= Date.now()) {
      throw new InvalidGrantError('授权码已过期');
    }
    if (pending.client_id !== client.client_id) {
      throw new InvalidGrantError('授权码不属于该客户端');
    }
    if (redirectUri !== undefined && pending.redirect_uri !== redirectUri) {
      throw new InvalidGrantError('redirect_uri 与签发时不一致');
    }

    const { tokens } = await issueTokenPair(pending.client_id, pending.scopes, randomUUID());
    return tokens;
  }

  async function exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await store.findByRefreshToken(refreshToken);
    if (!record) {
      throw new InvalidGrantError('刷新令牌不存在或已过期');
    }
    if (record.client_id !== client.client_id) {
      throw new InvalidGrantError('刷新令牌不属于该客户端');
    }

    if (record.rotated) {
      // 已轮换的刷新令牌再次出现 = 泄露信号：无法分辨是本人还是窃贼，两个都断掉。
      await store.revokeFamily(record.family_id);
      await sessions.destroyByToken(record.family_id);
      throw new InvalidGrantError('检测到刷新令牌重放，已吊销整个令牌家族，请重新授权');
    }

    const nextScopes = scopes ?? record.scopes;
    const { tokens, record: nextRecord } = await issueTokenPair(
      record.client_id,
      nextScopes,
      record.family_id,
    );
    await store.rotateRefresh(refreshToken, nextRecord);
    return tokens;
  }

  async function verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await store.findByAccessToken(token);
    if (!record) {
      throw new InvalidTokenError('访问令牌不存在、已过期或已被吊销');
    }
    return {
      token,
      clientId: record.client_id,
      scopes: record.scopes,
      expiresAt: Math.floor(record.access_expires_at / 1000),
    };
  }

  async function revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const familyId = await store.revokeByToken(request.token);
    if (familyId === undefined) return;
    await sessions.destroyByToken(familyId);
  }

  async function sweep(): Promise<number> {
    const now = Date.now();
    let expiredCodes = 0;
    for (const [hash, pending] of pendingCodes) {
      if (pending.expires_at <= now) {
        pendingCodes.delete(hash);
        expiredCodes += 1;
      }
    }
    const expiredTokens = await store.sweep(now);
    const total = expiredCodes + expiredTokens;
    if (total > 0) {
      logger.debug('swept expired auth codes and tokens', { expiredCodes, expiredTokens });
    }
    return total;
  }

  return {
    get clientsStore() {
      return clientsStore;
    },
    // 参数类型交给 AppleOAuthProvider 的返回类型注解做上下文推断（第三个参数是 express 的
    // Response，本项目未装 @types/express，也不该为一个桩方法专门加依赖）。
    async authorize(_client, _params, _res): Promise<void> {
      // Task 4 实现登录流程后填充此方法。
      throw new ServerError('authorize() 尚未实现，将由 Task 4 的登录流程提供');
    },
    challengeForAuthorizationCode,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    verifyAccessToken,
    revokeToken,
    skipLocalPkceValidation: false,
    issueAuthorizationCode,
    sweep,
  };
}
