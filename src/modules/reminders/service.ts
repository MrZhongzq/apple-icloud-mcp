import { AppError } from '../../core/errors.js';
import { decodeRef, decodeUrl, encodeUrl } from '../../core/ids.js';
import type { AccountConfig } from '../../core/config.js';
import {
  applyTodoPatch,
  buildTodoObject,
  parseTodoObject,
  type Reminder,
  type ReminderInput,
} from '../../parsers/ical.js';
import type { CalDavProvider, CalendarInfo } from '../../providers/icloud/caldav.js';
import type {
  ListRemindersParams,
  ListRemindersResult,
  PartialFailure,
  ReminderListSummary,
} from './types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export interface UpdateOptions {
  expected_etag?: string;
}

export interface ReminderService {
  listLists(): Promise<ReminderListSummary[]>;
  list(params: ListRemindersParams): Promise<ListRemindersResult>;
  create(input: ReminderInput, listId?: string): Promise<Reminder>;
  update(reminderId: string, patch: Partial<ReminderInput>, options?: UpdateOptions): Promise<Reminder>;
  remove(reminderId: string, options?: UpdateOptions): Promise<{ deleted: true }>;
}

export interface ReminderServiceDeps {
  account: AccountConfig;
  caldav: CalDavProvider;
}

function parseLimit(limit?: number): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AppError('INVALID_INPUT', `limit 必须在 1 到 ${MAX_LIMIT} 之间`);
  }
  return value;
}

function parseDueBound(label: string, value?: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('INVALID_INPUT', `${label} 必须是 ISO 8601 时间`, {
      hint: '例如 2026-09-01T00:00:00Z',
    });
  }
  return date;
}

export function createReminderService(deps: ReminderServiceDeps): ReminderService {
  const { account, caldav } = deps;
  const suffix = account.id.split('_')[1];

  const requireRead = (): void => {
    if (!account.capabilities.remindersRead) {
      throw new AppError('PERMISSION_DENIED', '该账号的提醒事项读取权限未开启', {
        hint: `设置环境变量 ALLOW_REMINDERS_READ_${suffix}=true 后重启服务`,
      });
    }
  };

  const requireWrite = (): void => {
    if (!account.capabilities.remindersWrite) {
      throw new AppError('PERMISSION_DENIED', '该账号的提醒事项写入权限未开启', {
        hint: `设置环境变量 ALLOW_REMINDERS_WRITE_${suffix}=true 后重启服务`,
      });
    }
  };

  // 严格匹配：与日历侧 components.length === 0 的宽松分支不同——一个未声明
  // components 的集合不应同时被日历和提醒两侧认领。
  const todoLists = async (): Promise<CalendarInfo[]> => {
    const calendars = await caldav.listCalendars();
    return calendars.filter((c) => c.components.includes('VTODO'));
  };

  /** 写操作前统一走这里：先解码 id（不发请求），再读回当前状态并校验乐观锁。 */
  const loadForWrite = async (reminderId: string, expectedEtag?: string) => {
    const ref = decodeRef(reminderId);
    const current = await caldav.fetchOne(ref.collectionUrl, ref.resourceUrl);
    if (expectedEtag !== undefined && current.etag !== expectedEtag) {
      throw new AppError('CONFLICT', '该提醒事项已被其他客户端修改', {
        hint: '重新调用 reminders_list 读取最新状态后再提交',
      });
    }
    return { ref, current };
  };

  return {
    async listLists() {
      requireRead();
      const lists = await todoLists();
      return lists.map((list) => {
        const summary: ReminderListSummary = {
          list_id: encodeUrl(list.url),
          name: list.name,
          writable: !list.readOnly,
        };
        if (list.color) summary.color = list.color;
        return summary;
      });
    },

    async list(params) {
      requireRead();
      const limit = parseLimit(params.limit);
      const dueAfter = parseDueBound('due_after', params.due_after);
      const dueBefore = parseDueBound('due_before', params.due_before);

      const allLists = await todoLists();

      // I10 的提醒版本：一个不再对应任何列表的 list_id 不能悄悄降级为"查询不到东西"，
      // 要把已删除/改名的那个 list_id 明确点出来。
      const wanted = params.list_ids?.map(decodeUrl);
      if (wanted) {
        const missing = wanted.filter((url) => !allLists.some((list) => list.url === url));
        if (missing.length > 0) {
          throw new AppError(
            'NOT_FOUND',
            `以下 list_id 不对应任何提醒列表：${missing.map(encodeUrl).join('、')}`,
            { hint: '重新调用 reminders_lists 获取当前有效的 list_id' },
          );
        }
      }
      const lists = allLists.filter((list) => !wanted || wanted.includes(list.url));

      // I1 的提醒版本：一个订阅/共享列表出问题（403、超时……）不能拖垮其它列表的读取——
      // 按列表隔离，把失败原因带出去。
      const settled = await Promise.allSettled(
        lists.map(async (list) => {
          const objects = await caldav.fetchObjects(list.url, undefined);
          const reminders: Reminder[] = [];
          // R2 的提醒版本：单个对象解析失败不能拖垮同一列表里的其它对象——
          // 隔离在这一层，比外层的按列表 allSettled 低一级。
          let unparseableObjects = 0;
          for (const object of objects) {
            try {
              reminders.push(
                ...parseTodoObject(object.data, { collectionUrl: object.collectionUrl, resourceUrl: object.url }),
              );
            } catch {
              unparseableObjects += 1;
            }
          }
          return { reminders, unparseableObjects };
        }),
      );

      const reminders: Reminder[] = [];
      const partial_failures: PartialFailure[] = [];
      settled.forEach((outcome, index) => {
        const list = lists[index]!;
        if (outcome.status === 'fulfilled') {
          reminders.push(...outcome.value.reminders);
          if (outcome.value.unparseableObjects > 0) {
            partial_failures.push({
              list_id: encodeUrl(list.url),
              name: list.name,
              reason: `${outcome.value.unparseableObjects} 个提醒对象无法解析`,
            });
          }
        } else {
          const reason = outcome.reason instanceof AppError ? outcome.reason.message : '未知错误';
          partial_failures.push({ list_id: encodeUrl(list.url), name: list.name, reason });
        }
      });

      let filtered = reminders;
      if (params.completed !== undefined) {
        filtered = filtered.filter((r) => r.completed === params.completed);
      }
      if (dueAfter || dueBefore) {
        filtered = filtered.filter((r) => {
          if (!r.due) return false;
          const due = new Date(r.due);
          if (dueAfter && due < dueAfter) return false;
          if (dueBefore && due > dueBefore) return false;
          return true;
        });
      }

      const result: ListRemindersResult = { reminders: filtered.slice(0, limit) };
      if (partial_failures.length > 0) result.partial_failures = partial_failures;
      return result;
    },

    async create(input, listId) {
      requireWrite();

      const lists = await todoLists();
      const { ics, uid } = buildTodoObject(input);

      const writeTo = async (target: CalendarInfo): Promise<Reminder> => {
        const created = await caldav.create(target.url, `${uid}.ics`, ics);
        const [reminder] = parseTodoObject(ics, {
          collectionUrl: created.collectionUrl,
          resourceUrl: created.url,
        });
        if (!reminder) throw new AppError('INTERNAL', '提醒事项创建后无法回读');
        return reminder;
      };

      if (listId) {
        const target = lists.find((l) => l.url === decodeUrl(listId));
        if (!target) {
          throw new AppError('NOT_FOUND', '找不到可写入的提醒列表', {
            hint: '调用 reminders_lists 查看可用列表及其 writable 状态',
          });
        }
        return writeTo(target);
      }

      const writable = lists.filter((l) => !l.readOnly);
      const primary = writable[0];
      if (!primary) {
        throw new AppError('NOT_FOUND', '找不到可写入的提醒列表', {
          hint: '调用 reminders_lists 查看可用列表及其 writable 状态',
        });
      }

      try {
        return await writeTo(primary);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'PERMISSION_DENIED') throw err;
        const fallback = writable[1];
        if (!fallback) throw err;
        return writeTo(fallback);
      }
    },

    async update(reminderId, patch, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(reminderId, options.expected_etag);

      // 原地补丁而非按模型重建——重建会把 CATEGORIES/RELATED-TO/X-APPLE-SORT-ORDER/
      // VALARM 等我们数据模型未覆盖的属性静默丢弃，而这是用户的真实提醒事项数据。
      const ics = applyTodoPatch(current.data, patch);
      await caldav.update({
        collectionUrl: ref.collectionUrl,
        url: ref.resourceUrl,
        etag: current.etag,
        data: ics,
      });

      const [updated] = parseTodoObject(ics, ref);
      if (!updated) throw new AppError('INTERNAL', '提醒事项更新后无法回读');
      return updated;
    },

    async remove(reminderId, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(reminderId, options.expected_etag);
      await caldav.remove({ url: ref.resourceUrl, etag: current.etag });
      return { deleted: true };
    },
  };
}
