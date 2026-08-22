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

export function mapCalDavError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const status = (err as { status?: number }).status;

  if (status === 401) {
    return new AppError('AUTH_FAILED', 'iCloud 拒绝了日历访问凭据', {
      hint: '确认 App 专用密码有效，且 ICLOUD_ACCOUNT 是 Apple ID 邮箱',
      cause: err,
    });
  }
  if (status === 403) {
    return new AppError('PERMISSION_DENIED', '没有该日历的写入权限', { cause: err });
  }
  if (status === 404) {
    return new AppError('NOT_FOUND', '日历资源不存在或已被删除', {
      hint: '重新调用 calendar_list_events 获取最新的 event_id',
      cause: err,
    });
  }
  if (status === 412) {
    return new AppError('CONFLICT', '该事件已被其他客户端修改', {
      hint: '重新读取事件后再提交修改',
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new AppError('UPSTREAM_ERROR', 'iCloud 日历服务暂时不可用', { retryable: true, cause: err });
  }
  return new AppError('UPSTREAM_ERROR', '日历操作失败', { retryable: true, cause: err });
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

/** 在 current-user-privilege-set 的 xml-js compact 结构里递归寻找带 "write" 的节点名。 */
function hasWritePrivilege(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase().includes('write')) return true;
    if (hasWritePrivilege(value)) return true;
  }
  return false;
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
        return calendars.map((cal) => {
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
          throw new AppError('NOT_FOUND', '日历事件不存在或已被删除', {
            hint: '重新调用 calendar_list_events 获取最新的 event_id',
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
