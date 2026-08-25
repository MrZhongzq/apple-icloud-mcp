import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthStore, StoredToken } from './store.js';
import { generateToken, hashToken } from './crypto.js';
import { createPendingStore, renderLoginPage, renderAuthorizeErrorPage } from './login.js';
import type { PendingStore } from './login.js';
import type { Logger } from '../core/logger.js';
import type { SessionStore } from '../core/session.js';

const DEFAULT_ACCESS_TOKEN_TTL_MS = 3600_000;
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
const DEFAULT_AUTH_CODE_TTL_MS = 60_000;
/** 一次待授权请求（等管理员在登录页确认）的存活时间——比授权码本身（60s）宽松得多，
 *  因为这段时间里有一个真人在输密码，不是机器瞬时兑换。 */
const DEFAULT_PENDING_AUTH_TTL_MS = 10 * 60_000;

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
  /** Task 4：authorize() 把待授权请求暂存在这里。不传时内部自建一份——
   *  这个依赖是新加的，老调用方（如既有的令牌测试）不必跟着改。 */
  pending?: PendingStore;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  authCodeTtlMs?: number;
}): AppleOAuthProvider {
  const { store, logger } = deps;
  const sessions = deps.sessions as SessionStoreWithTokenDestroy;
  const pending = deps.pending ?? createPendingStore();
  const accessTokenTtlMs = deps.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS;
  const refreshTokenTtlMs = deps.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS;
  const authCodeTtlMs = deps.authCodeTtlMs ?? DEFAULT_AUTH_CODE_TTL_MS;
  const pendingAuthTtlMs = DEFAULT_PENDING_AUTH_TTL_MS;

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

  // 下面这一组 InvalidGrantError / InvalidTokenError（到 verifyAccessToken 为止）故意用
  // 英文而不是本文件其余部分的中文：SDK 的 requireBearerAuth 把 error.message 原样塞进
  // WWW-Authenticate 响应头（bearerAuth.js 的 buildWwwAuthHeader），token 端点的错误
  // JSON body 同样直接带上这段文本。HTTP 头值必须是 ASCII——中文字符会让
  // res.set() 抛 ERR_INVALID_CHAR，把本该返回的 401 变成一个 500，而且是那种只在真实
  // provider 上才会暴露、mock 掉 verifyAccessToken 的单测完全看不见的 500。
  // 这不是风格不一致，是这条路径唯一能安全经过的字符集；别为了和别处统一改回中文。
  async function challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = pendingCodes.get(hashToken(authorizationCode));
    if (!pending || pending.expires_at <= Date.now()) {
      throw new InvalidGrantError('authorization code not found or expired');
    }
    // 目前这个返回值只在 SDK 内部做哈希比对，从不回显，且 exchangeAuthorizationCode 会在
    // 签发令牌前再核对一次归属——但检查的价值不只在于挡住了什么，也在于下一个读者不必
    // 自己重建这三步论证来确认「不检查也安全」。那个论证现在成立，不代表它会一直成立。
    if (pending.client_id !== client.client_id) {
      throw new InvalidGrantError('authorization code does not belong to this client');
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
      throw new InvalidGrantError('authorization code not found, already used, or expired');
    }
    if (pending.expires_at <= Date.now()) {
      throw new InvalidGrantError('authorization code expired');
    }
    if (pending.client_id !== client.client_id) {
      throw new InvalidGrantError('authorization code does not belong to this client');
    }
    // redirectUri 在 SDK 的 token schema 里是 optional 字段——调用方可以整个不发。
    // 签发时 issueAuthorizationCode 总是记录一个具体的 redirect_uri，所以「没发」
    // 和「发的不一样」都算不一致：RFC 6749 §4.1.3 要求无条件回比，不能因为字段缺席就放行。
    if (pending.redirect_uri !== redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the value used when the code was issued');
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
      throw new InvalidGrantError('refresh token not found or expired');
    }
    if (record.client_id !== client.client_id) {
      throw new InvalidGrantError('refresh token does not belong to this client');
    }

    if (record.rotated) {
      // 已轮换的刷新令牌再次出现 = 泄露信号：无法分辨是本人还是窃贼，两个都断掉。
      await store.revokeFamily(record.family_id);
      await sessions.destroyByToken(record.family_id);
      throw new InvalidGrantError('refresh token replay detected; the token family has been revoked, re-authorize');
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
      throw new InvalidTokenError('access token not found, expired, or revoked');
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
    // 第三个参数是真正的 express Response（@types/express 已装，见 Task 4 报告）——
    // res.set()/res.status()/res.send() 在这里是类型检查过的，不是 any。这个方法本身只渲染
    // 登录页或错误页，从不跳转：真正的 302（把 code/state 带回 redirect_uri，或早退时的
    // res.redirect()）发生在管理员提交登录表单之后，由消费 handleLoginSubmit() 结果的路由完成。
    async authorize(client, params, res): Promise<void> {
      // redirect_uri 必须与客户端注册时的完全一致：不做前缀匹配、不做通配。
      // 不匹配就不跳转——跳到一个未注册的地址正是开放重定向，这里是唯一会把用户
      // 交给攻击者的地方。改成"仍然跳转但带错误"看起来更友好，实际上是同一个洞。
      if (!client.redirect_uris.includes(params.redirectUri)) {
        logger.warn('authorize: redirect_uri 未注册，拒绝跳转', {
          clientId: client.client_id,
        });
        res.set('Cache-Control', 'no-store');
        res.status(400).send(renderAuthorizeErrorPage('redirect_uri 未在客户端注册信息中登记，已拒绝'));
        return;
      }

      const requestId = pending.put({
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        scopes: params.scopes ?? [],
        state: params.state,
        expires_at: Date.now() + pendingAuthTtlMs,
      });

      res.set('Cache-Control', 'no-store');
      res.send(renderLoginPage({ requestId }));
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
