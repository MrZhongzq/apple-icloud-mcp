import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReminderService } from '../../../src/modules/reminders/service.js';
import { encodeRef, encodeUrl } from '../../../src/core/ids.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { CalDavProvider } from '../../../src/providers/icloud/caldav.js';

const LIST = 'https://caldav.icloud.com/1/calendars/reminders/';
const OTHER = 'https://caldav.icloud.com/1/calendars/work-reminders/';
const CAL = 'https://caldav.icloud.com/1/calendars/home/';
const TODO_URL = `${LIST}todo-001.ics`;
const reminderId = encodeRef({ collectionUrl: LIST, resourceUrl: TODO_URL });

const fx = (n: string) => readFileSync(join(process.cwd(), 'tests/fixtures/calendar', n), 'utf8');
const basic = fx('todo-basic.ics');
const completed = fx('todo-completed.ics');
const extras = fx('todo-with-extras.ics');

function makeAccount(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
    email: 'me@icloud.com',
    sender: 'me@icloud.com',
    label: 'me@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    capabilities: {
      mailRead: true, mailWrite: true,
      calendarRead: true, calendarWrite: true,
      remindersRead: true, remindersWrite: true,
      contactsRead: true, contactsWrite: true,
      ...overrides,
    },
  };
}

function makeCalDav(overrides: Partial<CalDavProvider> = {}): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi.fn().mockResolvedValue([
      { url: LIST, name: '提醒', color: '#00FF00', readOnly: false, components: ['VTODO'] },
      { url: CAL, name: '个人', readOnly: false, components: ['VEVENT'] },
    ]),
    fetchObjects: vi.fn().mockResolvedValue([
      { collectionUrl: LIST, url: TODO_URL, etag: 'etag-1', data: basic },
    ]),
    fetchOne: vi.fn().mockResolvedValue({
      collectionUrl: LIST, url: TODO_URL, etag: 'etag-1', data: basic,
    }),
    create: vi.fn().mockImplementation(async (url: string, filename: string, ics: string) => ({
      collectionUrl: url, url: `${url}${filename}`, etag: 'etag-new', data: ics,
    })),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ReminderService permissions', () => {
  it('refuses to list when reminders read is disabled', async () => {
    const service = createReminderService({ account: makeAccount({ remindersRead: false }), caldav: makeCalDav() });
    await expect(service.list({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to create when reminders write is disabled', async () => {
    const service = createReminderService({ account: makeAccount({ remindersWrite: false }), caldav: makeCalDav() });
    await expect(service.create({ title: 'x' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('names the environment variable in the hint', async () => {
    const service = createReminderService({ account: makeAccount({ remindersWrite: false }), caldav: makeCalDav() });
    try {
      await service.remove(reminderId);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain('ALLOW_REMINDERS_WRITE');
    }
  });

  it('checks the gate before touching the provider', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount({ remindersRead: false }), caldav });
    await expect(service.listLists()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(caldav.listCalendars).not.toHaveBeenCalled();
  });
});

describe('ReminderService.listLists', () => {
  it('returns only VTODO collections with opaque ids', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    const lists = await service.listLists();
    expect(lists).toEqual([
      { list_id: encodeUrl(LIST), name: '提醒', color: '#00FF00', writable: true },
    ]);
  });

  it('does not claim a collection that declares no components', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([{ url: CAL, name: '未声明', readOnly: false, components: [] }]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    expect(await service.listLists()).toEqual([]);
  });
});

describe('ReminderService.list', () => {
  it('returns parsed reminders from every VTODO list', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    const result = await service.list({});
    expect(result.reminders).toHaveLength(1);
    expect(result.reminders[0]!.title).toBe('买咖啡豆');
    expect(result.partial_failures).toBeUndefined();
  });

  it('queries only VTODO collections, never the calendar', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.list({});
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(1);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(LIST, undefined);
  });

  it('filters by completion state', async () => {
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic },
        { collectionUrl: LIST, url: `${LIST}todo-002.ics`, etag: 'e2', data: completed },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    expect((await service.list({ completed: true })).reminders.map((r) => r.title)).toEqual(['交房租']);
    expect((await service.list({ completed: false })).reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    expect((await service.list({})).reminders).toHaveLength(2);
  });

  it('filters by due range and drops reminders with no due date', async () => {
    const noDue = basic.replace(/^DUE:.*$/m, '');
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic },
        { collectionUrl: LIST, url: `${LIST}nodue.ics`, etag: 'e2', data: noDue },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const inRange = await service.list({ due_after: '2026-08-01T00:00:00Z', due_before: '2026-09-01T00:00:00Z' });
    expect(inRange.reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    const outOfRange = await service.list({ due_after: '2026-09-01T00:00:00Z' });
    expect(outOfRange.reminders).toEqual([]);
  });

  it('restricts to the requested lists', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '提醒', readOnly: false, components: ['VTODO'] },
        { url: OTHER, name: '工作', readOnly: false, components: ['VTODO'] },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.list({ list_ids: [encodeUrl(OTHER)] });
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(1);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(OTHER, undefined);
  });

  it('raises NOT_FOUND naming a list_id that matches nothing', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(service.list({ list_ids: [encodeUrl('https://caldav.icloud.com/1/calendars/gone/')] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sorts by due ascending, undated last, title as tiebreak', async () => {
    const todo = (uid: string, summary: string, due?: string): string =>
      [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO',
        `UID:${uid}`, 'DTSTAMP:20260801T000000Z', `SUMMARY:${summary}`,
        ...(due ? [`DUE:${due}`] : []),
        'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
      ].join('\r\n');
    // 故意打乱投喂顺序：排序必须来自服务端，而不是碰巧等于 CalDAV 的返回顺序。
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: `${LIST}a.ics`, etag: 'e1', data: todo('a', 'zeta', '20260910T090000Z') },
        { collectionUrl: LIST, url: `${LIST}b.ics`, etag: 'e2', data: todo('b', 'beta') },
        { collectionUrl: LIST, url: `${LIST}c.ics`, etag: 'e3', data: todo('c', 'alpha', '20260901T090000Z') },
        { collectionUrl: LIST, url: `${LIST}d.ics`, etag: 'e4', data: todo('d', 'alpha') },
        { collectionUrl: LIST, url: `${LIST}e.ics`, etag: 'e5', data: todo('e', 'omega', '20260901T090000Z') },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const result = await service.list({});
    expect(result.reminders.map((r) => r.title)).toEqual(['alpha', 'omega', 'zeta', 'alpha', 'beta']);
    expect(result.truncated).toBeUndefined();
  });

  it('keeps the earliest reminders when limit truncates, and says so', async () => {
    const objects = Array.from({ length: 5 }, (_, i) => ({
      collectionUrl: LIST,
      url: `${LIST}t${i}.ics`,
      etag: `e${i}`,
      data: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', `UID:t${i}`, 'DTSTAMP:20260801T000000Z',
        `SUMMARY:任务${i}`, `DUE:2026090${5 - i}T090000Z`, 'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
      ].join('\r\n'),
    }));
    const caldav = makeCalDav({ fetchObjects: vi.fn().mockResolvedValue(objects) });
    const service = createReminderService({ account: makeAccount(), caldav });
    const result = await service.list({ limit: 2 });
    expect(result.reminders.map((r) => r.title)).toEqual(['任务4', '任务3']);
    expect(result.truncated).toBe(true);
  });

  it('does not flag truncation when the result exactly fills the limit', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    expect((await service.list({ limit: 1 })).truncated).toBeUndefined();
  });

  it('rejects a limit outside the allowed range', async () => {
    const service = createReminderService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(service.list({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.list({ limit: 5000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('isolates a failing list instead of failing the whole query', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '提醒', readOnly: false, components: ['VTODO'] },
        { url: OTHER, name: '工作', readOnly: false, components: ['VTODO'] },
      ]),
      fetchObjects: vi.fn().mockImplementation(async (url: string) => {
        if (url === OTHER) throw new Error('boom');
        return [{ collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic }];
      }),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const result = await service.list({});
    expect(result.reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    expect(result.partial_failures).toHaveLength(1);
    expect(result.partial_failures![0]!.name).toBe('工作');
  });

  it('isolates a single unparseable object within a list', async () => {
    const caldav = makeCalDav({
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: LIST, url: TODO_URL, etag: 'e1', data: basic },
        { collectionUrl: LIST, url: `${LIST}broken.ics`, etag: 'e2', data: 'NOT ICALENDAR AT ALL' },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    const result = await service.list({});
    expect(result.reminders.map((r) => r.title)).toEqual(['买咖啡豆']);
    expect(result.partial_failures).toHaveLength(1);
  });
});

describe('ReminderService.create', () => {
  it('writes to the first writable VTODO list by default', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    const created = await service.create({ title: '新待办' });
    expect(caldav.create).toHaveBeenCalledWith(LIST, expect.stringMatching(/\.ics$/), expect.stringContaining('SUMMARY:新待办'));
    expect(created.title).toBe('新待办');
    expect(created.completed).toBe(false);
  });

  it('honours an explicit list_id', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '提醒', readOnly: false, components: ['VTODO'] },
        { url: OTHER, name: '工作', readOnly: false, components: ['VTODO'] },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.create({ title: 'x' }, encodeUrl(OTHER));
    expect(caldav.create).toHaveBeenCalledWith(OTHER, expect.anything(), expect.anything());
  });

  it('raises NOT_FOUND when no writable list exists', async () => {
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: LIST, name: '只读', readOnly: true, components: ['VTODO'] },
      ]),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.create({ title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ReminderService.update', () => {
  it('patches in place and preserves unmodelled properties', async () => {
    const caldav = makeCalDav({
      fetchOne: vi.fn().mockResolvedValue({ collectionUrl: LIST, url: TODO_URL, etag: 'etag-1', data: extras }),
    });
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.update(reminderId, { title: '改过的标题' });

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('SUMMARY:改过的标题');
    expect(written).toContain('CATEGORIES:工作,重要');
    expect(written).toContain('RELATED-TO:todo-001');
    expect(written).toContain('X-APPLE-SORT-ORDER:12');
    expect(written).toContain('BEGIN:VALARM');
  });

  it('writes with the freshly read etag, not the supplied one', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await service.update(reminderId, { title: 'x' }, { expected_etag: 'etag-1' });
    expect((caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].etag).toBe('etag-1');
  });

  it('raises CONFLICT when expected_etag does not match, without writing', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.update(reminderId, { title: 'x' }, { expected_etag: 'stale' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(caldav.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed reminder_id before any network call', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.update('garbage', { title: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.fetchOne).not.toHaveBeenCalled();
  });

  it('round-trips a completion toggle', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    const updated = await service.update(reminderId, { completed: true });
    expect(updated.completed).toBe(true);
    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('STATUS:COMPLETED');
    expect(written).toContain('PERCENT-COMPLETE:100');
  });
});

describe('ReminderService.remove', () => {
  it('deletes with the current etag', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    expect(await service.remove(reminderId)).toEqual({ deleted: true });
    expect(caldav.remove).toHaveBeenCalledWith({ url: TODO_URL, etag: 'etag-1' });
  });

  it('rejects a malformed reminder_id before any network call', async () => {
    const caldav = makeCalDav();
    const service = createReminderService({ account: makeAccount(), caldav });
    await expect(service.remove('garbage')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.fetchOne).not.toHaveBeenCalled();
  });
});
