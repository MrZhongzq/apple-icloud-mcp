import { z } from 'zod';
import { wrapTool } from '../../server/wrap.js';
import { AppError } from '../../core/errors.js';
import type { ToolDeps, ToolExtra, ToolRegistrar } from '../../server/types.js';
import { accessKeyIdFrom, type Session } from '../../core/session.js';
import type { MailService } from './service.js';

export interface MailToolDeps extends ToolDeps {
  /** 由 createServer 注入：从会话持有的 provider 构造 MailService。 */
  mailFor: (session: Session) => MailService;
}

const sessionId = z.string().describe('apple_login 返回的 session_id');
const folder = z.string().optional().describe('文件夹路径，默认 INBOX');

const querySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    since: z.string().optional().describe('ISO 8601 时间，只看该时刻之后的邮件'),
    before: z.string().optional(),
    unseen: z.boolean().optional(),
    flagged: z.boolean().optional(),
  })
  .optional();

function toDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('INVALID_INPUT', `${field} 不是合法的时间格式：${value}`, {
      hint: '请使用 ISO 8601 格式，例如 2026-09-01T00:00:00Z',
    });
  }
  return date;
}

export function registerMailTools(server: ToolRegistrar, deps: MailToolDeps): void {
  const { sessions, logger, mailFor } = deps;

  /** 每次调用先校验会话（过期即抛 SESSION_EXPIRED），再取该会话的 service。 */
  const serviceOf = (sessionId: string, extra?: ToolExtra): MailService => mailFor(sessions.get(sessionId, accessKeyIdFrom(extra)));

  server.registerTool(
    'mail_folders',
    {
      title: '列出邮件文件夹',
      description: '返回所有邮件文件夹及其未读数。specialUse 标出收件箱、已发送、废纸篓等特殊用途。',
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'mail_folders', async (args: { session_id: string }, extra) =>
      serviceOf(args.session_id, extra).listFolders(),
    ),
  );

  server.registerTool(
    'mail_search',
    {
      title: '搜索邮件',
      description:
        '按条件搜索邮件，返回解码后的摘要列表（不含完整正文）。用 nextCursor 翻页，用 mail_read 读取正文。',
      inputSchema: {
        session_id: sessionId,
        folder,
        query: querySchema,
        limit: z.number().int().min(1).max(100).optional().describe('默认 20'),
        cursor: z.string().optional().describe('上一次返回的 nextCursor'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'mail_search',
      async (args: {
        session_id: string;
        folder?: string;
        query?: Record<string, unknown>;
        limit?: number;
        cursor?: string;
      }, extra) => {
        const query = args.query
          ? {
              ...args.query,
              since: toDate(args.query.since as string | undefined, 'since'),
              before: toDate(args.query.before as string | undefined, 'before'),
            }
          : undefined;
        return serviceOf(args.session_id, extra).search({
          folder: args.folder,
          query: query as never,
          limit: args.limit,
          cursor: args.cursor,
        });
      },
    ),
  );

  server.registerTool(
    'mail_read',
    {
      title: '读取邮件正文',
      description: '按 uid 读取单封邮件，返回已解码的正文、收发件人与附件元信息。',
      inputSchema: {
        session_id: sessionId,
        uid: z.number().int().describe('mail_search 返回的 uid'),
        folder,
        format: z.enum(['text', 'html', 'both']).optional().describe('默认 text'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'mail_read',
      async (args: { session_id: string; uid: number; folder?: string; format?: 'text' | 'html' | 'both' }, extra) =>
        serviceOf(args.session_id, extra).read(args.uid, args.folder, args.format),
    ),
  );

  server.registerTool(
    'mail_send',
    {
      title: '发送邮件',
      description: '以配置的发信身份发送一封新邮件。text 与 html 至少提供一个。',
      inputSchema: {
        session_id: sessionId,
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        in_reply_to: z.string().optional().describe('被回复邮件的 messageId'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'mail_send',
      async (args: {
        session_id: string;
        to: string[];
        cc?: string[];
        bcc?: string[];
        subject: string;
        text?: string;
        html?: string;
        in_reply_to?: string;
      }, extra) =>
        serviceOf(args.session_id, extra).send({
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          inReplyTo: args.in_reply_to,
        }),
    ),
  );

  server.registerTool(
    'mail_mark',
    {
      title: '标记邮件',
      description: '批量设置或清除已读、加星标记。',
      inputSchema: {
        session_id: sessionId,
        uid: z.array(z.number().int()).min(1),
        folder,
        flags: z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() }),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapTool(
      logger,
      'mail_mark',
      async (args: {
        session_id: string;
        uid: number[];
        folder?: string;
        flags: { seen?: boolean; flagged?: boolean };
      }, extra) => serviceOf(args.session_id, extra).mark(args.uid, args.flags, args.folder),
    ),
  );

  server.registerTool(
    'mail_move',
    {
      title: '移动邮件',
      description: '把邮件批量移动到另一个文件夹。文件夹路径用 mail_folders 获取。',
      inputSchema: {
        session_id: sessionId,
        uid: z.array(z.number().int()).min(1),
        from_folder: z.string(),
        to_folder: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'mail_move',
      async (args: { session_id: string; uid: number[]; from_folder: string; to_folder: string }, extra) =>
        serviceOf(args.session_id, extra).move(args.uid, args.from_folder, args.to_folder),
    ),
  );

  server.registerTool(
    'mail_delete',
    {
      title: '删除邮件',
      description:
        '默认把邮件移入废纸篓（可恢复）。permanent 为 true 时直接永久删除，无法撤销。',
      inputSchema: {
        session_id: sessionId,
        uid: z.array(z.number().int()).min(1),
        folder,
        permanent: z.boolean().optional().describe('默认 false，即移入废纸篓'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(
      logger,
      'mail_delete',
      async (args: { session_id: string; uid: number[]; folder?: string; permanent?: boolean }, extra) =>
        serviceOf(args.session_id, extra).remove(args.uid, args.folder, args.permanent),
    ),
  );
}
