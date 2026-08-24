import type { Reminder } from '../../parsers/ical.js';

/** 提醒列表的对外摘要。list_id 是不透明字符串，由 core/ids.ts 的 encodeUrl 生成。 */
export interface ReminderListSummary {
  list_id: string;
  name: string;
  color?: string;
  writable: boolean;
}

export interface PartialFailure {
  list_id: string;
  name: string;
  reason: string;
}

export interface ListRemindersParams {
  list_ids?: string[];
  completed?: boolean;
  due_before?: string;
  due_after?: string;
  limit?: number;
}

export interface ListRemindersResult {
  reminders: Reminder[];
  /** 单个提醒列表读取失败时出现；其余列表的结果仍然完整返回。 */
  partial_failures?: PartialFailure[];
}
