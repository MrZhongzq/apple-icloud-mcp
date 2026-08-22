import { AppError } from '../../core/errors.js';
import { decodeRef, decodeUrl, encodeRef, encodeUrl } from '../../core/ids.js';
import type { ResourceRef } from '../../core/ids.js';
import type { AccountConfig } from '../../core/config.js';
import {
  addExdate,
  applyEventPatch,
  buildCalendarObject,
  parseCalendarObject,
  upsertOverride,
  type CalendarEvent,
  type EventInput,
} from '../../parsers/ical.js';
import type { CalDavProvider } from '../../providers/icloud/caldav.js';

const MAX_EVENTS = 1000;

export interface CalendarSummary {
  calendar_id: string;
  name: string;
  color?: string;
  writable: boolean;
}

export interface ListEventsParams {
  start: string;
  end: string;
  calendar_ids?: string[];
  expand_recurring?: boolean;
}

export interface PartialFailure {
  calendar_id: string;
  name: string;
  reason: string;
}

export interface ListEventsResult {
  events: CalendarEvent[];
  /** 单个日历读取失败时出现；其余日历的结果仍然完整返回（I1）。 */
  partial_failures?: PartialFailure[];
}

export interface UpdateOptions {
  expected_etag?: string;
  scope?: 'this' | 'all';
  recurrence_id?: string;
}

export interface CalendarService {
  listCalendars(): Promise<CalendarSummary[]>;
  listEvents(params: ListEventsParams): Promise<ListEventsResult>;
  createEvent(input: EventInput, calendarId?: string): Promise<CalendarEvent>;
  updateEvent(eventId: string, patch: Partial<EventInput>, options?: UpdateOptions): Promise<CalendarEvent>;
  deleteEvent(eventId: string, options?: UpdateOptions): Promise<{ deleted: true }>;
}

export interface CalendarServiceDeps {
  account: AccountConfig;
  caldav: CalDavProvider;
}

function parseRange(start: string, end: string): { start: Date; end: Date } {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('INVALID_INPUT', 'start / end 必须是 ISO 8601 时间', {
      hint: '例如 2026-09-01T00:00:00Z',
    });
  }
  if (to <= from) {
    throw new AppError('INVALID_INPUT', 'end 必须晚于 start');
  }
  return { start: from, end: to };
}

/** CalendarEvent → EventInput，用于把补丁合并到既有事件上。 */
export function toInput(event: CalendarEvent): EventInput {
  const input: EventInput = {
    title: event.title,
    start: event.start,
    end: event.end,
    all_day: event.all_day,
  };
  if (event.location) input.location = event.location;
  if (event.description) input.description = event.description;
  if (event.url) input.url = event.url;
  if (event.recurrence) input.recurrence = event.recurrence;
  if (event.alarms.length > 0) input.alarms = event.alarms;
  return input;
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const { account, caldav } = deps;
  const suffix = account.id.split('_')[1];

  const requireRead = (): void => {
    if (!account.capabilities.calendarRead) {
      throw new AppError('PERMISSION_DENIED', '该账号的日历读取权限未开启', {
        hint: `设置环境变量 ALLOW_CALENDAR_READ_${suffix}=true 后重启服务`,
      });
    }
  };

  const requireWrite = (): void => {
    if (!account.capabilities.calendarWrite) {
      throw new AppError('PERMISSION_DENIED', '该账号的日历写入权限未开启', {
        hint: `设置环境变量 ALLOW_CALENDAR_WRITE_${suffix}=true 后重启服务`,
      });
    }
  };

  const eventCalendars = async () => {
    const calendars = await caldav.listCalendars();
    return calendars.filter((c) => c.components.length === 0 || c.components.includes('VEVENT'));
  };

  /** 读回当前状态并校验乐观锁，写操作前统一走这里。 */
  const loadForWrite = async (eventId: string, expectedEtag?: string) => {
    const ref = decodeRef(eventId);
    const current = await caldav.fetchOne(ref.collectionUrl, ref.resourceUrl);
    if (expectedEtag !== undefined && current.etag !== expectedEtag) {
      throw new AppError('CONFLICT', '该事件已被其他客户端修改', {
        hint: '重新调用 calendar_list_events 读取最新状态后再提交',
      });
    }
    return { ref, current };
  };

  /** scope 为 'this' 时必须知道目标是哪一次发生，否则无从定位。 */
  const requireRecurrenceId = (options: UpdateOptions): string => {
    if (!options.recurrence_id) {
      throw new AppError('INVALID_INPUT', 'scope 为 this 时必须提供 recurrence_id', {
        hint: 'recurrence_id 取自 calendar_list_events 展开后的事件对象',
      });
    }
    return options.recurrence_id;
  };

  /**
   * scope: 'this' 只对重复事件有意义。findMaster 类的底层解析函数接受任何不带
   * RECURRENCE-ID 的 VEVENT（重复与否都行），两条 scope:'this' 路径都没有另行校验——
   * 对非重复事件，deleteEvent 会写入一个不起作用的 EXDATE 却报告删除成功，
   * updateEvent 会给一个没有 RRULE 的对象附加 RECURRENCE-ID，写盘后回读失败，
   * 报出让人费解的 INTERNAL——都发生在已经改动日历之后。
   */
  const requireRecurringSeries = (series: CalendarEvent): void => {
    if (!series.recurrence) {
      throw new AppError('INVALID_INPUT', '该事件不是重复事件，scope 为 this 时没有意义', {
        hint: '非重复事件请省略 scope（等同 scope: "all"）',
      });
    }
  };

  /** 写入前校验 recurrence_id 确实对应一次真实发生（未被 EXDATE 排除、未超出 COUNT/UNTIL）。 */
  const requireRealOccurrence = (icsText: string, ref: ResourceRef, recurrenceId: string): void => {
    const anchor = new Date(recurrenceId).getTime();
    if (Number.isNaN(anchor)) {
      throw new AppError('INVALID_INPUT', `recurrence_id 不是合法的时间格式：${recurrenceId}`, {
        hint: '请使用 ISO 8601 格式，例如 2026-09-10T14:00:00+08:00',
      });
    }
    const occurrences = parseCalendarObject(icsText, ref, {
      rangeStart: new Date(anchor - 1_000),
      rangeEnd: new Date(anchor + 1_000),
      expandRecurring: true,
    });
    if (!occurrences.some((e) => e.recurrence_id === recurrenceId)) {
      throw new AppError('INVALID_INPUT', `recurrence_id ${recurrenceId} 不对应该事件的任何实际发生`, {
        hint: '从 calendar_list_events 展开后的事件对象中取 recurrence_id',
      });
    }
  };

  return {
    async listCalendars() {
      requireRead();
      const calendars = await eventCalendars();
      return calendars.map((cal) => {
        const summary: CalendarSummary = {
          calendar_id: encodeUrl(cal.url),
          name: cal.name,
          writable: !cal.readOnly,
        };
        if (cal.color) summary.color = cal.color;
        return summary;
      });
    },

    async listEvents(params) {
      requireRead();
      const range = parseRange(params.start, params.end);
      const allCalendars = await eventCalendars();

      // I10: an id that no longer resolves to any calendar must not silently degrade to
      // "query nothing" -- the deleted/renamed calendar_ids entry gets named explicitly.
      const wanted = params.calendar_ids?.map(decodeUrl);
      if (wanted) {
        const missing = wanted.filter((url) => !allCalendars.some((cal) => cal.url === url));
        if (missing.length > 0) {
          throw new AppError(
            'NOT_FOUND',
            `以下 calendar_id 不对应任何日历：${missing.map(encodeUrl).join('、')}`,
            { hint: '重新调用 calendar_list 获取当前有效的 calendar_id' },
          );
        }
      }
      const calendars = allCalendars.filter((cal) => !wanted || wanted.includes(cal.url));

      // I1: one subscribed/shared calendar going stale (403, timeout, ...) must not abort
      // every other calendar's read -- isolate per calendar and surface the failures.
      const settled = await Promise.allSettled(
        calendars.map(async (calendar) => {
          const objects = await caldav.fetchObjects(calendar.url, range);
          const events: CalendarEvent[] = [];
          for (const object of objects) {
            events.push(
              ...parseCalendarObject(
                object.data,
                { collectionUrl: object.collectionUrl, resourceUrl: object.url },
                {
                  rangeStart: range.start,
                  rangeEnd: range.end,
                  expandRecurring: params.expand_recurring !== false,
                },
              ),
            );
          }
          return events;
        }),
      );

      const events: CalendarEvent[] = [];
      const partial_failures: PartialFailure[] = [];
      settled.forEach((outcome, index) => {
        const calendar = calendars[index]!;
        if (outcome.status === 'fulfilled') {
          events.push(...outcome.value);
        } else {
          const reason = outcome.reason instanceof AppError ? outcome.reason.message : '未知错误';
          partial_failures.push({ calendar_id: encodeUrl(calendar.url), name: calendar.name, reason });
        }
      });

      const result: ListEventsResult = {
        events: events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_EVENTS),
      };
      if (partial_failures.length > 0) result.partial_failures = partial_failures;
      return result;
    },

    async createEvent(input, calendarId) {
      requireWrite();
      parseRange(input.start, input.end);

      const calendars = await eventCalendars();
      const target = calendarId
        ? calendars.find((c) => c.url === decodeUrl(calendarId))
        : calendars.find((c) => !c.readOnly);

      // 权限发现失败的系统性风险已在 provider 层用 applyPrivilegeFallback 兜住
      // （全部只读即视为探测失败、一律报可写），因此这里为空只可能是真的没有日历。
      if (!target) {
        throw new AppError('NOT_FOUND', '找不到可写入的日历', {
          hint: '调用 calendar_list 查看可用日历及其 writable 状态',
        });
      }

      const { ics, uid } = buildCalendarObject(input);
      const created = await caldav.create(target.url, `${uid}.ics`, ics);
      const [event] = parseCalendarObject(ics, {
        collectionUrl: created.collectionUrl,
        resourceUrl: created.url,
      });
      if (!event) throw new AppError('INTERNAL', '事件创建后无法回读');
      return event;
    },

    async updateEvent(eventId, patch, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(eventId, options.expected_etag);

      if (options.scope === 'this') {
        const recurrenceId = requireRecurrenceId(options);
        const [existingSeries] = parseCalendarObject(current.data, ref);
        if (!existingSeries) throw new AppError('NOT_FOUND', '该事件已不存在');
        requireRecurringSeries(existingSeries);
        requireRealOccurrence(current.data, ref, recurrenceId);

        // existingSeries 的 start/end 是主事件自身的模板时间，与本次发生无关。
        // 直接沿用它的 end 会让 DTEND 落在别的日期上（常见结果是早于 DTSTART，
        // 写出畸形 VEVENT）。正确做法是把序列的时长套到本次发生的起点上。
        const seriesDurationMs =
          new Date(existingSeries.end).getTime() - new Date(existingSeries.start).getTime();
        const overrideStart = patch.start ?? recurrenceId;
        const overrideStartMs = new Date(overrideStart).getTime();
        if (Number.isNaN(overrideStartMs)) {
          throw new AppError('INVALID_INPUT', `start 不是合法的时间格式：${overrideStart}`, {
            hint: '请使用 ISO 8601 格式，例如 2026-09-10T14:00:00+08:00',
          });
        }
        const overrideEnd =
          patch.end ?? new Date(overrideStartMs + seriesDurationMs).toISOString();

        const overrideInput: EventInput = {
          ...toInput(existingSeries),
          ...patch,
          start: overrideStart,
          end: overrideEnd,
        };
        parseRange(overrideInput.start, overrideInput.end);
        const data = upsertOverride(current.data, recurrenceId, overrideInput);
        await caldav.update({
          collectionUrl: ref.collectionUrl,
          url: ref.resourceUrl,
          etag: current.etag,
          data,
        });

        // scope 'this' writes an exception occurrence, not the master -- re-parse
        // with expansion and hand back the occurrence actually edited (matched by its
        // *original* recurrence_id, which stays pinned to the slot even if the patch
        // moved the occurrence's start) rather than the series' own unmoved template.
        const anchor = new Date(recurrenceId).getTime();
        const movedTo = new Date(overrideInput.start).getTime();
        const occurrences = parseCalendarObject(data, ref, {
          rangeStart: new Date(Math.min(anchor, movedTo) - 86_400_000),
          rangeEnd: new Date(Math.max(anchor, movedTo) + 86_400_000),
          expandRecurring: true,
        });
        const edited = occurrences.find((e) => e.recurrence_id === recurrenceId);
        if (!edited) throw new AppError('INTERNAL', '事件更新后无法回读该次发生');
        return edited;
      }

      const [existing] = parseCalendarObject(current.data, ref);
      if (!existing) {
        throw new AppError('NOT_FOUND', '该事件已不存在');
      }

      // 校验合并后的时间区间，但写盘走原地补丁而非按模型重建——
      // 重建会把 ATTENDEE/ORGANIZER/CATEGORIES/STATUS/X-APPLE-* 等
      // 我们的数据模型未覆盖的属性静默丢弃，而这是用户的真实日历数据。
      const merged: EventInput = { ...toInput(existing), ...patch };
      parseRange(merged.start, merged.end);

      const ics = applyEventPatch(current.data, patch);
      await caldav.update({
        collectionUrl: ref.collectionUrl,
        url: ref.resourceUrl,
        etag: current.etag,
        data: ics,
      });

      const [updated] = parseCalendarObject(ics, ref);
      if (!updated) throw new AppError('INTERNAL', '事件更新后无法回读');
      return updated;
    },

    async deleteEvent(eventId, options = {}) {
      requireWrite();
      const { ref, current } = await loadForWrite(eventId, options.expected_etag);

      if (options.scope === 'this') {
        const recurrenceId = requireRecurrenceId(options);
        const [existingSeries] = parseCalendarObject(current.data, ref);
        if (!existingSeries) throw new AppError('NOT_FOUND', '该事件已不存在');
        requireRecurringSeries(existingSeries);
        requireRealOccurrence(current.data, ref, recurrenceId);

        const data = addExdate(current.data, recurrenceId);
        await caldav.update({
          collectionUrl: ref.collectionUrl,
          url: ref.resourceUrl,
          etag: current.etag,
          data,
        });
        return { deleted: true };
      }

      await caldav.remove({ url: ref.resourceUrl, etag: current.etag });
      return { deleted: true };
    },
  };
}
