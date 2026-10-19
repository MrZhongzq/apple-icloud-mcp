import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import type { AccountConfig } from './config.js';
import type { ImapProvider } from '../providers/icloud/imap.js';
import type { SmtpProvider } from '../providers/icloud/smtp.js';
import type { CalDavProvider } from '../providers/icloud/caldav.js';
import type { CardDavProvider } from '../providers/icloud/carddav.js';
import type { ContactsCache } from '../modules/contacts/cache.js';

export interface SessionProviders {
  imap: ImapProvider;
  smtp: SmtpProvider;
  caldav: CalDavProvider;
  carddav: CardDavProvider;
}

export type ProviderFactory = (account: AccountConfig) => SessionProviders;

export interface Session {
  id: string;
  account: AccountConfig;
  createdAt: number;
  lastActiveAt: number;
  providers: SessionProviders;
  /** 通讯录搜索缓存，首次搜索时才创建；随会话销毁而消失。 */
  contactsCache?: ContactsCache;
  /** 建立会话时所属的 OAuth 令牌家族；stdio 入口不传，值为 undefined。
   *  令牌被吊销时，`destroyByToken` 靠这个字段找到该家族名下的全部会话。 */
  tokenFamilyId?: string;
  /** 建立会话的访问密钥 id；stdio / CLI 入口不传，值为 undefined。
   *  之后的每次 get/destroy 都要拿调用方的密钥 id 来比对，不一致就当这个会话不存在。 */
  ownerKeyId?: string;
}

export interface SessionStore {
  /** stdio 入口不传第二、三参数，行为与今天完全一致。 */
  create(account: AccountConfig, tokenFamilyId?: string, ownerKeyId?: string): Session;
  /** callerKeyId 与会话的 ownerKeyId 不一致（两边都 undefined 视为一致）时，表现与 id 不存在完全相同。 */
  get(id: string, callerKeyId?: string): Session;
  /** 非属主调用返回 false 且不动会话，与 id 不存在时一样。 */
  destroy(id: string, callerKeyId?: string): Promise<boolean>;
  /** 销毁所有满足条件的会话（逐个走 destroyById，关闭底层连接），返回销毁数量。 */
  destroyMatching(predicate: (s: Session) => boolean): Promise<number>;
  /** 吊销令牌时调用：销毁该家族名下全部会话（逐个走 destroy，关闭底层连接），返回销毁数量。 */
  destroyByToken(tokenFamilyId: string): Promise<number>;
  destroyAll(): Promise<void>;
  sweep(): Promise<number>;
  size(): number;
}

/**
 * `AuthInfo.extra` 里存放令牌家族 ID 的键名。两端共用同一个常量而不是各写一遍字符串：
 * 写入端是 `auth/provider.ts::verifyAccessToken`，读取端是 `modules/session/tools.ts`
 * 里的 `apple_login`，中间隔着整个 SDK（requireBearerAuth → RequestHandlerExtra →
 * 工具回调的第二个参数）。这条链上没有任何一步会对键名做类型检查，两边各写一个字面量
 * 拼错了也不会有人报错——只会安静地退回"会话不带家族"，也就是吊销令牌销毁不了会话的那个
 * bug 本身。放在这里而不是 auth/ 下，是为了不让 modules 反向依赖 auth：会话属于哪个令牌
 * 家族本来就是 Session 自己的字段。
 *
 * `ACCESS_KEY_ID_KEY` 走的是同一条链路（verifyAccessToken 写入 AuthInfo.extra →
 * SDK → wrapTool 透传的第二个参数 → 工具里的 accessKeyIdFrom），也放在这里，
 * 理由和失败方式都一样：键名写错不会有人报错，只会安静退回"调用方没有密钥"，
 * 于是带密钥的会话和不带密钥的调用方互相对不上，或者更糟——两边都读不到而放行。
 */
export const TOKEN_FAMILY_KEY = 'tokenFamilyId';
export const ACCESS_KEY_ID_KEY = 'accessKeyId';

export interface ToolExtraLike {
  authInfo?: { extra?: Record<string, unknown> | undefined } | undefined;
}

function stringFromExtra(extra: ToolExtraLike | undefined, key: string): string | undefined {
  const value = extra?.authInfo?.extra?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 从工具回调的 `extra` 里取出令牌家族 ID；没有（stdio 入口）或类型不对时返回 undefined。 */
export function tokenFamilyIdFrom(extra?: ToolExtraLike): string | undefined {
  return stringFromExtra(extra, TOKEN_FAMILY_KEY);
}

/** 从工具回调的 `extra` 里取出访问密钥 ID；没有（stdio / CLI 入口）或类型不对时返回 undefined。 */
export function accessKeyIdFrom(extra?: ToolExtraLike): string | undefined {
  return stringFromExtra(extra, ACCESS_KEY_ID_KEY);
}

export interface SessionStoreOptions {
  ttlMs: number;
  providerFactory: ProviderFactory;
  now?: () => number;
}

const EXPIRED_HINT = '会话已失效，请调用 apple_login 重新获取 session_id 后重试本次操作';

/** 会话不存在与会话归属不符共用这一个错误：调用方不能借此探测别人的 session_id 是否存在。 */
const unknownSession = (): AppError =>
  new AppError('SESSION_EXPIRED', '无效的 session_id', { hint: EXPIRED_HINT });

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => Date.now());

  const closeQuietly = async (session: Session): Promise<void> => {
    try {
      await session.providers.imap.close();
    } catch {
      // 连接可能已被对端关闭，销毁流程不因此失败
    }
    try {
      // I9: the nodemailer transporter holds the App password and was never torn down
      // before -- work_done's description claimed credentials were cleared from memory,
      // which was false. It still lives in `account.appPassword` for the process
      // lifetime; this closes the transporter's connection(s), it does not erase memory.
      await session.providers.smtp.close();
    } catch {
      // 同上：连接可能已经关闭
    }
  };

  const destroyById = async (id: string): Promise<boolean> => {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    await closeQuietly(session);
    return true;
  };

  return {
    create(account, tokenFamilyId, ownerKeyId) {
      const timestamp = now();
      const session: Session = {
        id: randomUUID(),
        account,
        createdAt: timestamp,
        lastActiveAt: timestamp,
        providers: options.providerFactory(account),
        tokenFamilyId,
        ownerKeyId,
      };
      sessions.set(session.id, session);
      return session;
    },

    get(id, callerKeyId) {
      const session = sessions.get(id);
      // 归属不符必须在刷新 lastActiveAt 之前拒绝，否则别人猜 id 就能让我的会话一直不过期。
      if (!session || session.ownerKeyId !== callerKeyId) throw unknownSession();
      const timestamp = now();
      if (timestamp - session.lastActiveAt > options.ttlMs) {
        sessions.delete(id);
        void closeQuietly(session);
        throw new AppError('SESSION_EXPIRED', '会话已超时', { hint: EXPIRED_HINT });
      }
      session.lastActiveAt = timestamp;
      return session;
    },

    async destroy(id, callerKeyId) {
      const session = sessions.get(id);
      if (!session || session.ownerKeyId !== callerKeyId) return false;
      return destroyById(id);
    },

    async destroyMatching(predicate) {
      const matches = [...sessions.values()].filter(predicate);
      let count = 0;
      for (const session of matches) {
        if (await destroyById(session.id)) count += 1;
      }
      return count;
    },

    async destroyByToken(tokenFamilyId) {
      const matches = [...sessions.values()].filter((s) => s.tokenFamilyId === tokenFamilyId);
      // 逐个走 destroyById：那条路径已经会关闭 IMAP/SMTP 连接，不能只从 Map 里删除——
      // 否则会留下一条仍连着用户 iCloud 邮箱的活跃连接，而这正是吊销要阻止的事。
      let count = 0;
      for (const session of matches) {
        if (await destroyById(session.id)) count += 1;
      }
      return count;
    },

    async destroyAll() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map(closeQuietly));
    },

    async sweep() {
      const timestamp = now();
      const expired = [...sessions.values()].filter((s) => timestamp - s.lastActiveAt > options.ttlMs);
      for (const session of expired) sessions.delete(session.id);
      await Promise.all(expired.map(closeQuietly));
      return expired.length;
    },

    size() {
      return sessions.size;
    },
  };
}
