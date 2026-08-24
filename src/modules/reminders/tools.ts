import { z } from 'zod';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';
import type { Session } from '../../core/session.js';
import type { ReminderService } from './service.js';

export interface ReminderToolDeps extends ToolDeps {
  reminderFor: (session: Session) => ReminderService;
}

const sessionId = z.string().describe('apple_login 返回的 session_id');

// due 是三态：省略表示不改动，null 表示清除截止日期，字符串表示设置为该值。
// 这与日历侧 eventShape 不同（日历没有"清除某字段"的需求），因此不能照搬
// z.string().optional() —— 那样会让"清除截止日期"永远无法通过这个 API 表达。
// priority 是 iCal 的 0-9，数值越小优先级越高（Apple 客户端 1=高、5=中、9=低，
// 0=未设置）：这与直觉相反，必须在 description 里写明，否则模型必然用反。
const reminderShape = {
  title: z.string(),
  notes: z.string().optional(),
  due: z
    .string()
    .nullable()
    .optional()
    .describe('ISO 8601 时间。传 null 表示清除截止日期；省略表示不改动。'),
  all_day_due: z.boolean().optional(),
  priority: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .describe('iCal 优先级 0-9，数值越小优先级越高：1=高，5=中，9=低，0=未设置（与直觉相反）。'),
  completed: z.boolean().optional(),
};

const reminderSchema = z.object(reminderShape);
const patchSchema = z.object(reminderShape).partial();

export function registerReminderTools(server: ToolRegistrar, deps: ReminderToolDeps): void {
  const { sessions, logger, reminderFor } = deps;
  const serviceOf = (sessionId_: string): ReminderService => reminderFor(sessions.get(sessionId_));

  server.registerTool(
    'reminders_lists',
    {
      title: '列出提醒列表',
      description: '返回所有可用提醒列表及其是否可写。list_id 是不透明字符串，供其他提醒工具使用。',
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'reminders_lists', async (args: { session_id: string }) =>
      serviceOf(args.session_id).listLists(),
    ),
  );

  server.registerTool(
    'reminders_list',
    {
      title: '查询提醒事项',
      description:
        '按列表、完成状态、截止时间范围查询提醒事项。留空 list_ids 则查询全部列表；' +
        '某个列表读取失败不影响其它列表的结果，会在 partial_failures 中报告。',
      inputSchema: {
        session_id: sessionId,
        list_ids: z.array(z.string()).optional().describe('留空则查询全部列表'),
        completed: z.boolean().optional(),
        due_before: z.string().optional().describe('ISO 8601 时间'),
        due_after: z.string().optional().describe('ISO 8601 时间'),
        limit: z.number().int().min(1).max(1000).optional().describe('默认 100，最大 1000'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'reminders_list',
      async (args: {
        session_id: string;
        list_ids?: string[];
        completed?: boolean;
        due_before?: string;
        due_after?: string;
        limit?: number;
      }) =>
        serviceOf(args.session_id).list({
          list_ids: args.list_ids,
          completed: args.completed,
          due_before: args.due_before,
          due_after: args.due_after,
          limit: args.limit,
        }),
    ),
  );

  server.registerTool(
    'reminders_create',
    {
      title: '创建提醒事项',
      description:
        '用结构化字段创建提醒事项。list_id 留空则写入第一个可写列表。' +
        'reminder.priority 是 iCal 优先级 0-9，数值越小优先级越高（1=高，5=中，9=低）。',
      inputSchema: {
        session_id: sessionId,
        list_id: z.string().optional(),
        reminder: reminderSchema,
        // 与 reminder.priority 共享同一个 zod 定义，不是独立输入通道——handler 只读取
        // args.reminder。之所以在顶层重复暴露，是因为 priority 的方向违反直觉，调用方
        // （包括仅检查顶层 schema、不深入嵌套对象的客户端）必须无需展开 reminder 就能
        // 读到这条说明；这里的重复纯粹是文档可见性，不代表第二个可写入口。
        priority: reminderShape.priority,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'reminders_create',
      async (args: { session_id: string; list_id?: string; reminder: z.infer<typeof reminderSchema> }) =>
        serviceOf(args.session_id).create(args.reminder, args.list_id),
    ),
  );

  server.registerTool(
    'reminders_update',
    {
      title: '修改提醒事项',
      description: '按 reminder_id 修改提醒事项，patch 中只写需要变更的字段。',
      inputSchema: {
        session_id: sessionId,
        reminder_id: z.string().describe('reminders_list 返回的 reminder_id'),
        patch: patchSchema,
        expected_etag: z.string().optional().describe('乐观锁，可留空'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapTool(
      logger,
      'reminders_update',
      async (args: {
        session_id: string;
        reminder_id: string;
        patch: z.infer<typeof patchSchema>;
        expected_etag?: string;
      }) => serviceOf(args.session_id).update(args.reminder_id, args.patch, { expected_etag: args.expected_etag }),
    ),
  );

  server.registerTool(
    'reminders_delete',
    {
      title: '删除提醒事项',
      description: '删除提醒事项，无法撤销。',
      inputSchema: {
        session_id: sessionId,
        reminder_id: z.string(),
        expected_etag: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(
      logger,
      'reminders_delete',
      async (args: { session_id: string; reminder_id: string; expected_etag?: string }) =>
        serviceOf(args.session_id).remove(args.reminder_id, { expected_etag: args.expected_etag }),
    ),
  );
}
