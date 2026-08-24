import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import type { AccountConfig } from './config.js';
import type { ImapProvider } from '../providers/icloud/imap.js';
import type { SmtpProvider } from '../providers/icloud/smtp.js';
import type { CalDavProvider } from '../providers/icloud/caldav.js';
import type { CardDavProvider } from '../providers/icloud/carddav.js';

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
}

export interface SessionStore {
  create(account: AccountConfig): Session;
  get(id: string): Session;
  destroy(id: string): Promise<boolean>;
  destroyAll(): Promise<void>;
  sweep(): Promise<number>;
  size(): number;
}

export interface SessionStoreOptions {
  ttlMs: number;
  providerFactory: ProviderFactory;
  now?: () => number;
}

const EXPIRED_HINT = '会话已失效，请调用 apple_login 重新获取 session_id 后重试本次操作';

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

  return {
    create(account) {
      const timestamp = now();
      const session: Session = {
        id: randomUUID(),
        account,
        createdAt: timestamp,
        lastActiveAt: timestamp,
        providers: options.providerFactory(account),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(id) {
      const session = sessions.get(id);
      if (!session) {
        throw new AppError('SESSION_EXPIRED', '无效的 session_id', { hint: EXPIRED_HINT });
      }
      const timestamp = now();
      if (timestamp - session.lastActiveAt > options.ttlMs) {
        sessions.delete(id);
        void closeQuietly(session);
        throw new AppError('SESSION_EXPIRED', '会话已超时', { hint: EXPIRED_HINT });
      }
      session.lastActiveAt = timestamp;
      return session;
    },

    async destroy(id) {
      const session = sessions.get(id);
      if (!session) return false;
      sessions.delete(id);
      await closeQuietly(session);
      return true;
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
