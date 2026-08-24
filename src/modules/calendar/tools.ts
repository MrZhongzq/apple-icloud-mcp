import { z } from 'zod';
import { wrapTool } from '../../server/wrap.js';
import type { ToolDeps, ToolRegistrar } from '../../server/types.js';
import type { Session } from '../../core/session.js';
import type { CalendarService } from './service.js';

export interface CalendarToolDeps extends ToolDeps {
  calendarFor: (session: Session) => CalendarService;
}

const sessionId = z.string().describe('apple_login 返回的 session_id');

const recurrenceSchema = z
  .object({
    freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).optional(),
    count: z.number().int().min(1).optional(),
    until: z.string().optional().describe('ISO 8601 时间'),
    byday: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
    bymonthday: z.array(z.number().int().min(1).max(31)).optional(),
  })
  .optional();

const alarmsSchema = z
  .array(
    z.object({
      minutes_before: z.number().int().min(0),
      action: z.enum(['display', 'email']),
    }),
  )
  .optional();

// 注意：这里故意不包含 timezone 字段。EventInput（Task 7）没有 timezone，
// 正确输出 DTSTART;TZID= 需要随附 VTIMEZONE 数据，本阶段未实现，
// 因此事件创建以 UTC 锚定。工具 schema 不暴露一个会被静默丢弃的参数。
const eventShape = {
  title: z.string(),
  start: z.string().describe('ISO 8601 时间，必须带时区偏移，例如 2026-09-10T14:00:00+08:00'),
  end: z.string().describe('ISO 8601 时间，必须带时区偏移，且晚于 start'),
  all_day: z.boolean().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  recurrence: recurrenceSchema,
  alarms: alarmsSchema,
};

const eventSchema = z.object(eventShape);
const patchSchema = z.object(eventShape).partial();

export function registerCalendarTools(server: ToolRegistrar, deps: CalendarToolDeps): void {
  const { sessions, logger, calendarFor } = deps;
  const serviceOf = (sessionId_: string): CalendarService => calendarFor(sessions.get(sessionId_));

  server.registerTool(
    'calendar_list',
    {
      title: '列出日历',
      description: '返回所有可用日历及其是否可写。calendar_id 是不透明字符串，供其他日历工具使用。',
      inputSchema: { session_id: sessionId },
      annotations: { readOnlyHint: true },
    },
    wrapTool(logger, 'calendar_list', async (args: { session_id: string }) =>
      serviceOf(args.session_id).listCalendars(),
    ),
  );

  server.registerTool(
    'calendar_list_events',
    {
      title: '查询日程',
      description:
        '按时间范围查询日程，返回结构化事件。重复事件默认展开为具体发生实例，每个实例带 recurrence_id。' +
        '结果按开始时间升序排列，最多返回 1000 条，超出时截断并置 truncated: true；' +
        '被截断的结果不能用来回答"这段时间里没有 X"，请缩小时间范围或用 calendar_ids 缩小范围后重查。',
      inputSchema: {
        session_id: sessionId,
        start: z.string().describe('范围起点，ISO 8601'),
        end: z.string().describe('范围终点，ISO 8601'),
        calendar_ids: z.array(z.string()).optional().describe('留空则查询全部日历'),
        expand_recurring: z.boolean().optional().describe('默认 true'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapTool(
      logger,
      'calendar_list_events',
      async (args: {
        session_id: string;
        start: string;
        end: string;
        calendar_ids?: string[];
        expand_recurring?: boolean;
      }) =>
        serviceOf(args.session_id).listEvents({
          start: args.start,
          end: args.end,
          calendar_ids: args.calendar_ids,
          expand_recurring: args.expand_recurring,
        }),
    ),
  );

  server.registerTool(
    'calendar_create_event',
    {
      title: '创建日程',
      description:
        '用结构化字段创建日程，无需手写 iCal。calendar_id 留空则写入第一个可写日历。' +
        'start/end 必须是带显式时区偏移的 ISO 8601 时间（例如 2026-09-10T14:00:00+08:00）；' +
        '不带偏移的本地时间会被当作 UTC 解释，导致时间错误。',
      inputSchema: {
        session_id: sessionId,
        calendar_id: z.string().optional(),
        event: eventSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'calendar_create_event',
      async (args: { session_id: string; calendar_id?: string; event: z.infer<typeof eventSchema> }) =>
        serviceOf(args.session_id).createEvent(args.event, args.calendar_id),
    ),
  );

  server.registerTool(
    'calendar_update_event',
    {
      title: '修改日程',
      description:
        '按 event_id 修改日程，patch 中只写需要变更的字段。重复事件默认改整条序列；scope 为 this 时只改 recurrence_id 指定的那一次。',
      inputSchema: {
        session_id: sessionId,
        event_id: z.string().describe('calendar_list_events 返回的 event_id'),
        patch: patchSchema,
        scope: z.enum(['this', 'all']).optional().describe('默认 all'),
        recurrence_id: z.string().optional().describe('scope 为 this 时必填'),
        expected_etag: z.string().optional().describe('乐观锁，可留空'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    wrapTool(
      logger,
      'calendar_update_event',
      async (args: {
        session_id: string;
        event_id: string;
        patch: z.infer<typeof patchSchema>;
        scope?: 'this' | 'all';
        recurrence_id?: string;
        expected_etag?: string;
      }) =>
        serviceOf(args.session_id).updateEvent(args.event_id, args.patch, {
          expected_etag: args.expected_etag,
          scope: args.scope,
          recurrence_id: args.recurrence_id,
        }),
    ),
  );

  server.registerTool(
    'calendar_delete_event',
    {
      title: '删除日程',
      description:
        '删除日程，无法撤销。重复事件默认删除整条序列；scope 为 this 时只删除 recurrence_id 指定的那一次。',
      inputSchema: {
        session_id: sessionId,
        event_id: z.string(),
        scope: z.enum(['this', 'all']).optional().describe('默认 all'),
        recurrence_id: z.string().optional().describe('scope 为 this 时必填'),
        expected_etag: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrapTool(
      logger,
      'calendar_delete_event',
      async (args: {
        session_id: string;
        event_id: string;
        scope?: 'this' | 'all';
        recurrence_id?: string;
        expected_etag?: string;
      }) =>
        serviceOf(args.session_id).deleteEvent(args.event_id, {
          expected_etag: args.expected_etag,
          scope: args.scope,
          recurrence_id: args.recurrence_id,
        }),
    ),
  );
}
