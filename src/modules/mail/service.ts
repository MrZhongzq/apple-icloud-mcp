import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';
import { makeSnippet, parseEmail, type ParsedEmail } from '../../parsers/mime.js';
import type { FolderInfo, ImapProvider } from '../../providers/icloud/imap.js';
import type { OutgoingMessage, SendResult, SmtpProvider } from '../../providers/icloud/smtp.js';
import type { SearchParams, SearchResult } from './types.js';

const DEFAULT_FOLDER = 'INBOX';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface MailService {
  listFolders(): Promise<FolderInfo[]>;
  search(params: SearchParams): Promise<SearchResult>;
  read(uid: number, folder?: string, format?: 'text' | 'html' | 'both'): Promise<ParsedEmail & { uid: number }>;
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
    const folders = await imap.listFolders();
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
      return imap.listFolders();
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
          const parsed = await parseEmail(message.source);
          return {
            uid: message.uid,
            date: parsed.date ?? message.date.toISOString(),
            from: parsed.from,
            to: parsed.to,
            subject: parsed.subject,
            snippet: makeSnippet(parsed.text),
            seen: message.flags.includes('\\Seen'),
            flagged: message.flags.includes('\\Flagged'),
            hasAttachments: parsed.attachments.length > 0,
          };
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

      const parsed = await parseEmail(message.source);
      const result = { ...parsed, uid: message.uid };
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
