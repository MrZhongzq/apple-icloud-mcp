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
  /** 按 due 升序排列（无 due 的排在最后，同 due 按 title），再截断到 limit。 */
  reminders: Reminder[];
  /**
   * 命中条数超过 limit、结果被截断时为 true，否则不出现。
   * 没有这个信号的话，"我有没有关于 X 的提醒"会得到一个来自任意窗口的、
   * 自信的"没有"——因为 completed 默认不过滤，账号里历年累积的已完成提醒
   * 也在争夺这 limit 个名额。
   */
  truncated?: true;
  /** 单个提醒列表读取失败时出现；其余列表的结果仍然完整返回。 */
  partial_failures?: PartialFailure[];
}
