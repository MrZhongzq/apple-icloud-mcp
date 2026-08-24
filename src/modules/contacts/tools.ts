import { z } from 'zod';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';
import type { Session } from '../../core/session.js';
import type { ContactService } from './service.js';
import type { ContactInput } from '../../parsers/vcard.js';

export interface ContactToolDeps extends ToolDeps {
  contactFor: (session: Session) => ContactService;
}

const sessionId = z.string().describe('apple_login 返回的 session_id');

const typedValueSchema = z.object({
  value: z.string(),
  type: z.array(z.string()).optional(),
  label: z.string().optional(),
  primary: z.boolean().optional(),
});

const addressSchema = z.object({
  type: z.array(z.string()).optional(),
  label: z.string().optional(),
  primary: z.boolean().optional(),
  po_box: z.string().optional(),
  extended: z.string().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
});

const nameSchema = z.object({
  full: z.string().optional(),
  family: z.string().optional(),
  given: z.string().optional(),
  middle: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

// 标量字段全部三态：省略表示不改动，null 表示清除该字段，字符串表示设置为该值。
// 数组字段（emails/phones/addresses/urls/impp）是整体替换：传数组即用该数组覆盖
// 原有全部条目，传空数组即清空，省略则完全不动——不支持"追加一条"这种局部操作。
const contactShape = {
  name: nameSchema.describe('姓名结构。full 与 family/given 至少填一个（创建时由 schema 校验）。'),
  nickname: z.string().nullable().optional().describe('昵称。传 null 清除；省略不改动。'),
  organization: z.string().nullable().optional().describe('公司/组织。传 null 清除；省略不改动。'),
  department: z.string().nullable().optional().describe('部门。传 null 清除；省略不改动。'),
  title: z.string().nullable().optional().describe('职位。传 null 清除；省略不改动。'),
  emails: z.array(typedValueSchema).optional().describe('邮箱地址列表，整体替换：传空数组清空，省略不改动。'),
  phones: z.array(typedValueSchema).optional().describe('电话号码列表，整体替换：传空数组清空，省略不改动。'),
  addresses: z.array(addressSchema).optional().describe('地址列表，整体替换：传空数组清空，省略不改动。'),
  urls: z.array(typedValueSchema).optional().describe('网址列表，整体替换：传空数组清空，省略不改动。'),
  impp: z.array(typedValueSchema).optional().describe('即时通讯账号列表，整体替换：传空数组清空，省略不改动。'),
  birthday: z
    .string()
    .nullable()
    .optional()
    .describe('生日，YYYY-MM-DD（无年份用 --MM-DD）。传 null 清除；省略不改动。'),
  note: z.string().nullable().optional().describe('备注。传 null 清除；省略不改动。'),
};

const contactSchema = z
  .object(contactShape)
  .refine((value) => Boolean(value.name.full) || Boolean(value.name.family) || Boolean(value.name.given), {
    message: 'name 至少需要 full 或 family/given 之一',
    path: ['name'],
  });

const patchSchema = z.object(contactShape).partial();

export function registerContactTools(server: ToolRegistrar, deps: ContactToolDeps): void {
  const { sessions, logger, contactFor } = deps;
  const serviceOf = (sessionId_: string): ContactService => contactFor(sessions.get(sessionId_));

  server.registerTool(
    'contacts_search',
    {
      title: '搜索联系人',
      description:
        '按关键词搜索联系人，匹配范围含姓名、公司、部门、职位、昵称、邮箱、电话（电话额外做去除非数字字符后的子串匹配）、备注。' +
        '搜索命中的是会话内缓存，不是服务端实时查询——iCloud 不支持服务端过滤（addressbook-query）。' +
        '首次搜索会全量拉取该会话可见的所有联系人（实测约 1429 张卡片耗时约 7 秒），此后的搜索走增量同步、通常在 1 秒以内。' +
        '首次调用偏慢是预期行为，不要因此判定失败并重试。' +
        '留空 query 则返回全部联系人（受 limit 截断）。结果按 name.full 升序排列，' +
        '超出 limit 时截断并置 truncated: true；某个通讯簿同步失败不影响其它通讯簿的结果，会在 partial_failures 中报告。',
      inputSchema: {
        session_id: sessionId,
        query: z.string().optional().describe('留空则返回全部联系人'),
        address_book_ids: z.array(z.string()).optional().describe('留空则搜索全部通讯簿'),
        limit: z.number().int().min(1).max(500).optional().describe('默认 50，最大 500'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'contacts_search',
      async (args: { session_id: string; query?: string; address_book_ids?: string[]; limit?: number }) =>
        serviceOf(args.session_id).search({
          query: args.query,
          address_book_ids: args.address_book_ids,
          limit: args.limit,
        }),
    ),
  );

  server.registerTool(
    'contacts_read',
    {
      title: '读取联系人',
      description:
        '按 contact_id 读取单个联系人的完整信息。has_photo 只是一个布尔值，表示该联系人是否设置了头像；' +
        '本工具（以及所有联系人工具）永远不会返回头像的二进制或 base64 内容，不要尝试反复获取。',
      inputSchema: {
        session_id: sessionId,
        contact_id: z.string().describe('contacts_search 返回的 contact_id'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'contacts_read', async (args: { session_id: string; contact_id: string }) =>
      serviceOf(args.session_id).read(args.contact_id),
    ),
  );

  server.registerTool(
    'contacts_create',
    {
      title: '创建联系人',
      description:
        '用结构化字段创建联系人。address_book_id 留空则写入第一个可写通讯簿。' +
        'contact.name 至少需要 full 或 family/given 之一。emails/phones/addresses/urls/impp 均为整体数组，' +
        '省略某个数组字段表示该联系人不设置该项。',
      inputSchema: {
        session_id: sessionId,
        address_book_id: z.string().optional().describe('留空则写入第一个可写通讯簿'),
        contact: contactSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'contacts_create',
      async (args: { session_id: string; address_book_id?: string; contact: ContactInput }) =>
        serviceOf(args.session_id).create(args.contact, args.address_book_id),
    ),
  );

  server.registerTool(
    'contacts_update',
    {
      title: '修改联系人',
      description:
        '按 contact_id 修改联系人，patch 中只写需要变更的字段。标量字段传 null 表示清除该字段，省略表示不改动；' +
        'emails/phones/addresses/urls/impp 是整体替换，传空数组表示清空该项，省略表示不改动。',
      inputSchema: {
        session_id: sessionId,
        contact_id: z.string().describe('contacts_search 或 contacts_read 返回的 contact_id'),
        patch: patchSchema,
        expected_etag: z.string().optional().describe('乐观锁，可留空'),
      },
      // idempotentHint 故意不设（与 reminders_update/calendar_update_event 一致）：
      // 每次写入都会刷新 REV，重复同一次调用会产生不同的结果，因而不是幂等的。
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'contacts_update',
      async (args: {
        session_id: string;
        contact_id: string;
        patch: z.infer<typeof patchSchema>;
        expected_etag?: string;
      }) => serviceOf(args.session_id).update(args.contact_id, args.patch, { expected_etag: args.expected_etag }),
    ),
  );

  server.registerTool(
    'contacts_delete',
    {
      title: '删除联系人',
      description: '删除联系人，无法撤销。',
      inputSchema: {
        session_id: sessionId,
        contact_id: z.string().describe('contacts_search 或 contacts_read 返回的 contact_id'),
        expected_etag: z.string().optional().describe('乐观锁，可留空'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(
      logger,
      'contacts_delete',
      async (args: { session_id: string; contact_id: string; expected_etag?: string }) =>
        serviceOf(args.session_id).remove(args.contact_id, { expected_etag: args.expected_etag }),
    ),
  );
}
