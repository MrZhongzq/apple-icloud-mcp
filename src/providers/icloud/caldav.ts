import { createDAVClient } from 'tsdav';
import { AppError } from '../../core/errors.js';
import type { AccountConfig } from '../../core/config.js';

const SERVER_URL = 'https://caldav.icloud.com/';

export interface CalendarInfo {
  url: string;
  name: string;
  color?: string;
  readOnly: boolean;
  components: string[];
}

export interface CalendarObject {
  collectionUrl: string;
  url: string;
  etag: string;
  data: string;
}

export interface CalDavProvider {
  verify(): Promise<void>;
  listCalendars(): Promise<CalendarInfo[]>;
  fetchObjects(calendarUrl: string, range?: { start: Date; end: Date }): Promise<CalendarObject[]>;
  fetchOne(collectionUrl: string, resourceUrl: string): Promise<CalendarObject>;
  create(calendarUrl: string, filename: string, ics: string): Promise<CalendarObject>;
  update(object: CalendarObject): Promise<void>;
  remove(object: { url: string; etag: string }): Promise<void>;
}

/**
 * 措辞必须是领域中立的（资源 / 集合，而不是日历 / 事件）：这一层同时服务日历和提醒，
 * 而它无从知道当前配置注册了哪些工具——一个账号完全可以关掉日历只留提醒，此时一句
 * "重新调用 calendar_list_events" 指向的是一个根本不存在的工具。需要给恢复提示时就把
 * 两个列举类工具都点名，让模型用手上有的那个。
 */
/**
 * tsdav 登录（createDAVClient）遇到 401 时抛的是**不带 status** 的普通 Error，消息形如
 * "Invalid credentials: PROPFIND https://caldav.icloud.com/ returned 401 Unauthorized"。
 * 只看 status 的话，密码失效会落进兜底分支，被报成 retryable 的 "CalDAV 操作失败"。
 */
const TSDAV_LOGIN_401 = /^Invalid credentials: .* returned 401\b/;

export function mapCalDavError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const status =
    (err as { status?: number }).status ??
    (err instanceof Error && TSDAV_LOGIN_401.test(err.message) ? 401 : undefined);

  if (status === 401) {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了 CalDAV 访问凭据', {
      hint: '确认 App 专用密码有效，且 ICLOUD_ACCOUNT 是 Apple ID 邮箱',
      cause: err,
    });
  }
  if (status === 403) {
    // Distinct from the service layer's PERMISSION_DENIED for a disabled capability (which
    // hints at an env var to flip) -- this is iCloud itself refusing the write on this one
    // collection (e.g. a shared calendar/list the account can read but not write, or
    // privilege discovery having fallen back to reporting it writable). SKILL.md's recovery
    // table distinguishes the two meanings by this hint.
    return new AppError('PERMISSION_DENIED', 'iCloud 拒绝了对该集合的写入', {
      hint: '换用 calendar_list 或 reminders_lists 返回的另一个 id 重试，而不是重试同一个集合',
      cause: err,
    });
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', '该 CalDAV 资源不存在或已被删除', {
      hint: '重新调用 calendar_list_events 或 reminders_list 获取最新的 id',
      cause: err,
    });
  }
  if (status === 412) {
    return new AppError('CONFLICT', '该资源已被其他客户端修改', {
      hint: '重新读取该资源后再提交修改',
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new AppError('UPSTREAM_ERROR', 'iCloud CalDAV 服务暂时不可用', { retryable: true, cause: err });
  }
  return new AppError('UPSTREAM_ERROR', 'CalDAV 操作失败', { retryable: true, cause: err });
}

/**
 * fetchCalendars() 默认请求的属性集合（对齐 tsdav 源码里的默认值），
 * 额外加上 current-user-privilege-set 以推导 readOnly——
 * tsdav 2.3.1 的 DAVCalendar 类型不直接暴露 privilege 字段，需要自行请求并投影。
 */
const CALENDAR_PROPS = {
  'c:calendar-description': {},
  'c:calendar-timezone': {},
  'd:displayname': {},
  'ca:calendar-color': {},
  'cs:getctag': {},
  'd:resourcetype': {},
  'c:supported-calendar-component-set': {},
  'd:sync-token': {},
  'd:current-user-privilege-set': {},
};
const CALENDAR_PROJECTED_PROPS = { currentUserPrivilegeSet: true };

/**
 * 在 current-user-privilege-set 的 xml-js compact 结构里递归寻找带 "write" 的节点名。
 * 导出仅为测试。
 */
export function hasWritePrivilege(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase().includes('write')) return true;
    if (hasWritePrivilege(value)) return true;
  }
  return false;
}

/**
 * 权限发现的兜底：全部日历都判为只读时，更可能是 current-user-privilege-set
 * 未按预期返回，而非该账号真的没有可写日历（iCloud 用户总有一个默认日历可写）。
 * 此时视为“权限信息不可用”，一律报可写，由服务器用 403 做真正的裁决。
 * 只要有任意一个日历探测到写权限，就说明机制正常，逐个结果照原样采信。
 */
export function applyPrivilegeFallback(calendars: CalendarInfo[]): CalendarInfo[] {
  if (calendars.length === 0) return calendars;
  if (calendars.some((c) => !c.readOnly)) return calendars;
  return calendars.map((c) => ({ ...c, readOnly: false }));
}

/** CalDAV 认证用 account.email（Apple ID），与 IMAP 使用的 sender 不同。 */
export function createCalDavProvider(account: AccountConfig): CalDavProvider {
  type DavClient = Awaited<ReturnType<typeof createDAVClient>>;
  let clientPromise: Promise<DavClient> | undefined;

  const getClient = async (): Promise<DavClient> => {
    clientPromise ??= createDAVClient({
      serverUrl: SERVER_URL,
      credentials: { username: account.email, password: account.appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    }).catch((err: unknown) => {
      clientPromise = undefined;
      throw mapCalDavError(err);
    });
    return clientPromise;
  };

  const toObject = (collectionUrl: string, raw: { url: string; etag?: string; data?: unknown }): CalendarObject => ({
    collectionUrl,
    url: raw.url,
    etag: raw.etag ?? '',
    data: typeof raw.data === 'string' ? raw.data : '',
  });

  return {
    async verify() {
      const client = await getClient();
      try {
        await client.fetchCalendars();
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async listCalendars() {
      const client = await getClient();
      try {
        const calendars = await client.fetchCalendars({
          props: CALENDAR_PROPS,
          projectedProps: CALENDAR_PROJECTED_PROPS,
        });
        const infos = calendars.map((cal) => {
          const components = (cal.components ?? []).map(String);
          const info: CalendarInfo = {
            url: cal.url,
            name: typeof cal.displayName === 'string' ? cal.displayName : cal.url,
            readOnly: !hasWritePrivilege(cal.projectedProps?.['currentUserPrivilegeSet']),
            components,
          };
          if (typeof cal.calendarColor === 'string') info.color = cal.calendarColor;
          return info;
        });
        return applyPrivilegeFallback(infos);
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async fetchObjects(calendarUrl, range) {
      const client = await getClient();
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: { url: calendarUrl },
          timeRange: range
            ? { start: range.start.toISOString(), end: range.end.toISOString() }
            : undefined,
        });
        return objects.map((o) => toObject(calendarUrl, o));
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async fetchOne(collectionUrl, resourceUrl) {
      const client = await getClient();
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: { url: collectionUrl },
          objectUrls: [resourceUrl],
        });
        const found = objects[0];
        if (!found) {
          throw new AppError('NOT_FOUND', '该 CalDAV 资源不存在或已被删除', {
            hint: '重新调用 calendar_list_events 或 reminders_list 获取最新的 id',
          });
        }
        return toObject(collectionUrl, found);
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async create(calendarUrl, filename, ics) {
      const client = await getClient();
      try {
        const response = await client.createCalendarObject({
          calendar: { url: calendarUrl },
          filename: filename.endsWith('.ics') ? filename : `${filename}.ics`,
          iCalString: ics,
        });
        if (!response.ok) throw mapCalDavError({ status: response.status });
        return {
          collectionUrl: calendarUrl,
          url: response.url || `${calendarUrl}${filename}`,
          etag: response.headers.get('etag') ?? '',
          data: ics,
        };
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async update(object) {
      const client = await getClient();
      try {
        const response = await client.updateCalendarObject({
          calendarObject: { url: object.url, etag: object.etag, data: object.data },
        });
        if (!response.ok) throw mapCalDavError({ status: response.status });
      } catch (err) {
        throw mapCalDavError(err);
      }
    },

    async remove(object) {
      const client = await getClient();
      try {
        const response = await client.deleteCalendarObject({
          calendarObject: { url: object.url, etag: object.etag, data: '' },
        });
        if (!response.ok) throw mapCalDavError({ status: response.status });
      } catch (err) {
        throw mapCalDavError(err);
      }
    },
  };
}
