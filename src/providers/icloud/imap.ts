import { ImapFlow, type ImapFlowOptions, type StatusObject } from 'imapflow';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';
import type { Logger } from '../../core/logger.js';

const HOST = 'imap.mail.me.com';
const PORT = 993;

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  total: number;
  unseen: number;
}

export interface RawMessage {
  uid: number;
  date: Date;
  flags: string[];
  source: Buffer;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unseen?: boolean;
  flagged?: boolean;
}

export interface ImapProvider {
  verify(): Promise<void>;
  listFolders(): Promise<FolderInfo[]>;
  searchUids(folder: string, criteria: SearchCriteria): Promise<number[]>;
  fetchMessages(folder: string, uids: number[]): Promise<RawMessage[]>;
  setFlags(folder: string, uids: number[], flags: string[], add: boolean): Promise<void>;
  moveMessages(folder: string, uids: number[], target: string): Promise<void>;
  expunge(folder: string, uids: number[]): Promise<void>;
  close(): Promise<void>;
}

const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE']);

/** 上游异常一律在此收口。原始 message 只进 cause，不外泄（可能含凭据）。 */
export function mapImapError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const error = err as { code?: string; authenticationFailed?: boolean; message?: string };
  const message = error.message ?? '';

  if (error.authenticationFailed || /invalid credentials|authentication failed/i.test(message)) {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了这组凭据', {
      hint: '确认 App 专用密码未被吊销，且 Apple ID 已开启双重认证',
      cause: err,
    });
  }

  if (error.code && NETWORK_CODES.has(error.code)) {
    return new AppError('UPSTREAM_ERROR', '无法连接 iCloud 邮件服务器', { retryable: true, cause: err });
  }

  if (/mailbox does not exist|no such mailbox|nonexistent/i.test(message)) {
    return new AppError('NOT_FOUND', '指定的邮件文件夹不存在', {
      hint: '先调用 mail_folders 查看实际的文件夹路径',
      cause: err,
    });
  }

  if (/over quota|too many|rate/i.test(message)) {
    return new AppError('RATE_LIMITED', 'iCloud 暂时限制了请求频率', { retryable: true, cause: err });
  }

  return new AppError('UPSTREAM_ERROR', 'iCloud 邮件操作失败', { retryable: true, cause: err });
}

/**
 * imapflow's `logger` option wants an object with debug/info/warn/error methods each
 * taking a single opaque object -- routed through our own Logger so nothing bypasses
 * stderr, and always at *our* debug level (regardless of imapflow's own level for the
 * call) since these frames can be verbose and may embed message metadata.
 */
/** 导出仅为测试。 */
export function toImapFlowLogger(logger: Logger): NonNullable<ImapFlowOptions['logger']> {
  const forward = (data: unknown): void => logger.debug('imapflow', { data });
  return { debug: forward, info: forward, warn: forward, error: forward };
}

function buildOptions(account: AccountConfig, logger?: Logger): ImapFlowOptions {
  return {
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: account.sender, pass: account.appPassword },
    logger: logger ? toImapFlowLogger(logger) : false,
  };
}

/** 导出仅为测试。 */
export function toImapQuery(criteria: SearchCriteria): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.text) query.body = criteria.text;
  if (criteria.since) query.since = criteria.since;
  if (criteria.before) query.before = criteria.before;
  // `unseen: false` / `flagged: false` are meaningful queries ("already read", "not
  // starred") -- a truthiness check silently drops them and the search falls back to
  // matching everything. Both must be checked against `undefined`, not truthiness.
  if (criteria.unseen !== undefined) query.seen = !criteria.unseen;
  if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
  return Object.keys(query).length > 0 ? query : { all: true };
}

export interface ImapProviderDeps {
  /** 测试注入点：默认构造真实 ImapFlow 连接。 */
  createClient?: () => ImapFlow;
  /** imapflow 自身诊断日志的落地点；缺省仍是 logger: false（完全静音）。 */
  logger?: Logger;
}

/**
 * IMAP 认证用 account.sender（iCloud 邮箱或别名），不是 account.email。
 * 这两者的混用是旧版本反复修过的 bug，改动此处务必确认。
 */
export function createImapProvider(account: AccountConfig, deps: ImapProviderDeps = {}): ImapProvider {
  const createClient = deps.createClient ?? (() => new ImapFlow(buildOptions(account, deps.logger)));
  let client: ImapFlow | undefined;
  let connecting: Promise<ImapFlow> | undefined;

  /**
   * 单飞（single-flight）：并发调用共享同一次连接尝试。
   * 若不这样做，两个并发调用会各自建立并认证一条连接，闭包只保留后完成的那条，
   * 另一条成为永不关闭的泄漏 socket，并占用 iCloud 的每账号连接配额。
   */
  const connect = async (): Promise<ImapFlow> => {
    if (client?.usable) return client;
    connecting ??= (async () => {
      const next = createClient();
      try {
        await next.connect();
      } catch (err) {
        throw mapImapError(err);
      }
      client = next;
      return next;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  const withMailbox = async <T>(folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> => {
    const connection = await connect();
    let lock;
    try {
      lock = await connection.getMailboxLock(folder);
      return await fn(connection);
    } catch (err) {
      throw mapImapError(err);
    } finally {
      lock?.release();
    }
  };

  return {
    async verify() {
      const connection = await connect();
      try {
        await connection.noop();
      } catch (err) {
        throw mapImapError(err);
      }
    },

    async listFolders() {
      const connection = await connect();
      try {
        const list = await connection.list();
        const folders: FolderInfo[] = [];
        for (const box of list) {
          // imapflow's pinned .d.ts claims Promise<StatusObject>, but the runtime (see
          // lib/commands/status.js) returns `false` on a server NO/BAD -- the type doesn't
          // reflect the documented failure path, hence the cast.
          const status = (await connection.status(box.path, {
            messages: true,
            unseen: true,
          })) as StatusObject | false;
          // Coercing a `false` failure to `{ messages: 0, unseen: 0 }` via `??` would report
          // the folder as empty and fully-read instead of surfacing the failure.
          if (status === false) {
            throw new AppError('UPSTREAM_ERROR', `无法读取文件夹 ${box.path} 的状态`, { retryable: true });
          }
          const info: FolderInfo = {
            path: box.path,
            name: box.name,
            total: status.messages ?? 0,
            unseen: status.unseen ?? 0,
          };
          if (box.specialUse) info.specialUse = box.specialUse.replace('\\', '').toLowerCase();
          folders.push(info);
        }
        return folders;
      } catch (err) {
        throw mapImapError(err);
      }
    },

    async searchUids(folder, criteria) {
      return withMailbox(folder, async (connection) => {
        const uids = await connection.search(toImapQuery(criteria), { uid: true });
        // imapflow's search() *returns* `false` on a server NO/BAD, distinct from a
        // genuinely empty match set ([]). Collapsing both to [] turns a failed search into
        // a false "no matching mail" -- a false negative on a read path.
        if (uids === false) {
          throw new AppError('UPSTREAM_ERROR', `文件夹 ${folder} 中的搜索失败`, { retryable: true });
        }
        return [...uids].sort((a, b) => b - a);
      });
    },

    async fetchMessages(folder, uids) {
      if (uids.length === 0) return [];
      return withMailbox(folder, async (connection) => {
        const messages: RawMessage[] = [];
        for await (const message of connection.fetch(
          uids.join(','),
          { uid: true, flags: true, envelope: true, source: true },
          { uid: true },
        )) {
          if (!message.source) {
            throw new AppError('UPSTREAM_ERROR', 'iCloud 返回的邮件缺少正文数据', {
              hint: '稍后重试；若持续出现，请改用更小的 limit 分批读取',
              retryable: true,
            });
          }
          messages.push({
            uid: message.uid,
            date: message.envelope?.date ?? new Date(0),
            flags: message.flags ? [...message.flags] : [],
            source: message.source,
          });
        }
        return messages;
      });
    },

    async setFlags(folder, uids, flags, add) {
      if (uids.length === 0) return;
      await withMailbox(folder, async (connection) => {
        const range = uids.join(',');
        // imapflow's messageFlagsAdd/Remove *return* false on a server NO/BAD; awaiting and
        // discarding the result reports fabricated success on a failed STORE.
        const ok = add
          ? await connection.messageFlagsAdd(range, flags, { uid: true })
          : await connection.messageFlagsRemove(range, flags, { uid: true });
        if (!ok) {
          throw new AppError('UPSTREAM_ERROR', '设置邮件标记失败', { retryable: true });
        }
      });
    },

    async moveMessages(folder, uids, target) {
      if (uids.length === 0) return;
      await withMailbox(folder, async (connection) => {
        // imapflow's messageMove *returns* false on a server NO/BAD -- it does not throw.
        const ok = await connection.messageMove(uids.join(','), target, { uid: true });
        if (!ok) {
          throw new AppError('UPSTREAM_ERROR', '移动邮件失败', { retryable: true });
        }
      });
    },

    async expunge(folder, uids) {
      if (uids.length === 0) return;
      await withMailbox(folder, async (connection) => {
        // messageDelete() flags \Deleted then EXPUNGEs; a failed EXPUNGE leaves messages
        // flagged-and-hidden. imapflow *returns* false here on failure, it does not throw.
        const ok = await connection.messageDelete(uids.join(','), { uid: true });
        if (!ok) {
          throw new AppError('UPSTREAM_ERROR', '永久删除邮件失败', { retryable: true });
        }
      });
    },

    async close() {
      if (!client) return;
      try {
        await client.logout();
      } catch {
        client.close();
      } finally {
        client = undefined;
      }
    },
  };
}
