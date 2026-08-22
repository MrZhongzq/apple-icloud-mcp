import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';
import { makeSnippet, parseEmail, type ParsedEmail } from '../../parsers/mime.js';
import type { FolderInfo, ImapProvider } from '../../providers/icloud/imap.js';
import type { OutgoingMessage, SendResult, SmtpProvider } from '../../providers/icloud/smtp.js';
import type { SearchParams, SearchResult } from './types.js';

const DEFAULT_FOLDER = 'INBOX';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface FolderPartialFailure {
  path: string;
  reason: string;
}

export interface ListFoldersResult {
  folders: FolderInfo[];
  /** 单个文件夹状态读取失败时出现；其余文件夹的结果仍然完整返回（I1）。 */
  partial_failures?: FolderPartialFailure[];
}

export interface MailService {
  listFolders(): Promise<ListFoldersResult>;
  search(params: SearchParams): Promise<SearchResult>;
  read(
    uid: number,
    folder?: string,
    format?: 'text' | 'html' | 'both',
  ): Promise<ParsedEmail & { uid: number; parse_error?: true }>;
  send(message: OutgoingMessage): Promise<SendResult>;
  mark(uids: number[], flags: { seen?: boolean; flagged?: boolean }, folder?: string): Promise<{ updated: number }>;
  move(uids: number[], from: string, to: string): Promise<{ moved: number }>;
  remove(uids: number[], folder?: string, permanent?: boolean): Promise<{ deleted: number; permanent: boolean }>;
}

export interface MailServiceDeps {
  account: AccountConfig;
  imap: ImapProvider;
  smtp: SmtpProvider;
}

export function createMailService(deps: MailServiceDeps): MailService {
  const { account, imap, smtp } = deps;

  const requireRead = (): void => {
    if (!account.capabilities.mailRead) {
      throw new AppError('PERMISSION_DENIED', '该账号的邮件读取权限未开启', {
        hint: `设置环境变量 ALLOW_MAIL_READ_${account.id.split('_')[1]}=true 后重启服务`,
      });
    }
  };

  const requireWrite = (): void => {
    if (!account.capabilities.mailWrite) {
      throw new AppError('PERMISSION_DENIED', '该账号的邮件写入权限未开启', {
        hint: `设置环境变量 ALLOW_MAIL_WRITE_${account.id.split('_')[1]}=true 后重启服务`,
      });
    }
  };

  const requireUids = (uids: number[]): void => {
    if (uids.length === 0) {
      throw new AppError('INVALID_INPUT', 'uid 列表不能为空');
    }
  };

  const findTrash = async (): Promise<string> => {
    const { folders } = await imap.listFolders();
    const trash = folders.find((f) => f.specialUse === 'trash');
    if (!trash) {
      throw new AppError('NOT_FOUND', '找不到废纸篓文件夹', {
        hint: '调用 mail_folders 查看可用文件夹，或使用 permanent: true 直接删除',
      });
    }
    return trash.path;
  };

  return {
    async listFolders() {
      requireRead();
      const { folders, failures } = await imap.listFolders();
      return failures.length > 0 ? { folders, partial_failures: failures } : { folders };
    },

    async search(params) {
      requireRead();
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (limit < 1 || limit > MAX_LIMIT) {
        throw new AppError('INVALID_INPUT', `limit 必须在 1 到 ${MAX_LIMIT} 之间`);
      }

      const folder = params.folder ?? DEFAULT_FOLDER;
      const offset = params.cursor ? Number(params.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new AppError('INVALID_INPUT', 'cursor 不合法', {
          hint: '请原样使用上一次返回的 nextCursor',
        });
      }

      const allUids = await imap.searchUids(folder, params.query ?? {});
      const page = allUids.slice(offset, offset + limit);
      const raw = await imap.fetchMessages(folder, page);

      const messages = await Promise.all(
        raw.map(async (message) => {
          const seen = message.flags.includes('\\Seen');
          const flagged = message.flags.includes('\\Flagged');
          try {
            const parsed = await parseEmail(message.source);
            return {
              uid: message.uid,
              date: parsed.date ?? message.date.toISOString(),
              from: parsed.from,
              to: parsed.to,
              subject: parsed.subject,
              snippet: makeSnippet(parsed.text),
              seen,
              flagged,
              hasAttachments: parsed.attachments.length > 0,
            };
          } catch {
            // 单封邮件解析失败不应让整页搜索失败——邮箱内容并非用户所写
            return {
              uid: message.uid,
              date: message.date.toISOString(),
              to: [],
              subject: '(此邮件无法解析)',
              snippet: '',
              seen,
              flagged,
              hasAttachments: false,
            };
          }
        }),
      );

      const result: SearchResult = { messages };
      if (offset + page.length < allUids.length) {
        result.nextCursor = String(offset + page.length);
      }
      return result;
    },

    async read(uid, folder = DEFAULT_FOLDER, format = 'text') {
      requireRead();
      const [message] = await imap.fetchMessages(folder, [uid]);
      if (!message) {
        throw new AppError('NOT_FOUND', `文件夹 ${folder} 中不存在 uid 为 ${uid} 的邮件`, {
          hint: '先用 mail_search 获取有效的 uid',
        });
      }

      // I8: search() already degrades a single unparseable message to a placeholder
      // instead of failing the whole page (mailbox content is not something the user
      // wrote, and can be malformed). read() bare-called parseEmail, so the *same*
      // message surfaced here as an opaque INTERNAL '服务内部错误' with no hint at all.
      // Chosen fallback shape: return the IMAP-known envelope (uid; nothing decodable)
      // with an explicit parse_error: true field, matching search()'s "degrade, don't
      // fail" approach rather than mapping to UPSTREAM_ERROR.
      let parsed: ParsedEmail;
      let parseError = false;
      try {
        parsed = await parseEmail(message.source);
      } catch {
        parseError = true;
        parsed = {
          to: [],
          cc: [],
          subject: '(此邮件无法解析)',
          text: '',
          attachments: [],
          references: [],
        };
      }

      const result: ParsedEmail & { uid: number; parse_error?: true } = { ...parsed, uid: message.uid };
      if (parseError) result.parse_error = true;
      // html 是可选字段，可以直接删除；text 是必填字段，类型上不允许 undefined，
      // 只能清空为空字符串。若邮件本身没有 html 部分，'html' 分支的守卫不会触发，
      // text 会原样保留，调用方仍能拿到正文。
      if (format === 'text') delete result.html;
      if (format === 'html' && parsed.html) result.text = '';
      return result;
    },

    async send(message) {
      requireWrite();
      if (!message.text && !message.html) {
        throw new AppError('INVALID_INPUT', '邮件必须包含 text 或 html 之一');
      }
      if (message.to.length === 0) {
        throw new AppError('INVALID_INPUT', '收件人不能为空');
      }
      return smtp.send(message);
    },

    async mark(uids, flags, folder = DEFAULT_FOLDER) {
      requireWrite();
      requireUids(uids);
      if (flags.seen !== undefined) await imap.setFlags(folder, uids, ['\\Seen'], flags.seen);
      if (flags.flagged !== undefined) await imap.setFlags(folder, uids, ['\\Flagged'], flags.flagged);
      return { updated: uids.length };
    },

    async move(uids, from, to) {
      requireWrite();
      requireUids(uids);
      await imap.moveMessages(from, uids, to);
      return { moved: uids.length };
    },

    async remove(uids, folder = DEFAULT_FOLDER, permanent = false) {
      requireWrite();
      requireUids(uids);
      if (permanent) {
        await imap.expunge(folder, uids);
      } else {
        await imap.moveMessages(folder, uids, await findTrash());
      }
      return { deleted: uids.length, permanent };
    },
  };
}
