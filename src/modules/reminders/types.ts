/** 提醒列表的对外摘要。list_id 是不透明字符串，由 core/ids.ts 的 encodeUrl 生成。 */
export interface ReminderListSummary {
  list_id: string;
  name: string;
  color?: string;
  writable: boolean;
}
