import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCalendarService } from '../../../src/modules/calendar/service.js';
import { encodeRef, encodeUrl } from '../../../src/core/ids.js';
import { AppError } from '../../../src/core/errors.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { CalDavProvider } from '../../../src/providers/icloud/caldav.js';

const HOME = 'https://caldav.icloud.com/1/calendars/home/';
const WORK = 'https://caldav.icloud.com/1/calendars/work/';
const EVENT_URL = `${HOME}timed-001.ics`;

const timedIcs = readFileSync(join(process.cwd(), 'tests/fixtures/calendar/timed-shanghai.ics'), 'utf8');
const invalidTzidIcs = readFileSync(join(process.cwd(), 'tests/fixtures/calendar/invalid-tzid.ics'), 'utf8');

function makeAccount(overrides: Partial<AccountConfig['capabilities']> = {}): AccountConfig {
  return {
    id: 'account_1',
    email: 'me@icloud.com',
    sender: 'me@icloud.com',
    label: 'me@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
    capabilities: {
      mailRead: true,
      mailWrite: true,
      calendarRead: true,
      calendarWrite: true,
      remindersRead: true,
      remindersWrite: true,
      contactsRead: true,
      contactsWrite: true,
      ...overrides,
    },
  };
}

function makeCalDav(overrides: Partial<CalDavProvider> = {}): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi.fn().mockResolvedValue([
      { url: HOME, name: '个人', color: '#FF0000', readOnly: false, components: ['VEVENT'] },
      { url: WORK, name: '工作', readOnly: true, components: ['VEVENT'] },
      { url: `${HOME}todo/`, name: '提醒', readOnly: false, components: ['VTODO'] },
    ]),
    fetchObjects: vi.fn().mockResolvedValue([
      { collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: timedIcs },
    ]),
    fetchOne: vi.fn().mockResolvedValue({
      collectionUrl: HOME,
      url: EVENT_URL,
      etag: 'etag-1',
      data: timedIcs,
    }),
    create: vi.fn().mockImplementation(async (calendarUrl: string, filename: string, ics: string) => ({
      collectionUrl: calendarUrl,
      url: `${calendarUrl}${filename}`,
      etag: 'etag-new',
      data: ics,
    })),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const range = { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' };

describe('CalendarService permissions', () => {
  it('refuses to list events when calendar read is off', async () => {
    const service = createCalendarService({
      account: makeAccount({ calendarRead: false }),
      caldav: makeCalDav(),
    });
    await expect(service.listEvents(range)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to create when calendar write is off', async () => {
    const service = createCalendarService({
      account: makeAccount({ calendarWrite: false }),
      caldav: makeCalDav(),
    });
    await expect(
      service.createEvent({ title: 'x', start: range.start, end: range.end }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('CalendarService.listCalendars', () => {
  it('returns only VEVENT calendars with opaque ids', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    const calendars = await service.listCalendars();
    expect(calendars).toHaveLength(2);
    expect(calendars[0]).toEqual({
      calendar_id: encodeUrl(HOME),
      name: '个人',
      color: '#FF0000',
      writable: true,
      supports: ['VEVENT'],
    });
    expect(calendars[1]!.writable).toBe(false);
  });
});

describe('CalendarService.listEvents', () => {
  it('queries every VEVENT calendar within the range', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.listEvents(range);
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(2);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(HOME, {
      start: new Date(range.start),
      end: new Date(range.end),
    });
  });

  it('restricts the query when calendar_ids is given', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.listEvents({ ...range, calendar_ids: [encodeUrl(WORK)] });
    expect(caldav.fetchObjects).toHaveBeenCalledTimes(1);
    expect(caldav.fetchObjects).toHaveBeenCalledWith(WORK, expect.anything());
  });

  it('returns parsed events sorted by start time', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    const result = await service.listEvents(range);
    expect(result.events[0]!.title).toBe('项目评审');
    expect(result.events[0]!.start).toBe('2026-08-17T06:00:00.000Z');
    expect(result.events[0]!.event_id).toBe(encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL }));
    expect(result.partial_failures).toBeUndefined();
  });

  it('rejects a range whose end precedes its start', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(
      service.listEvents({ start: range.end, end: range.start }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('isolates a per-calendar fetch failure: other calendars still return events, and the failure is reported (I1)', async () => {
    const caldav = makeCalDav({
      fetchObjects: vi
        .fn()
        .mockImplementation(async (calendarUrl: string) => {
          if (calendarUrl === WORK) {
            throw new AppError('PERMISSION_DENIED', '没有该日历的写入权限');
          }
          return [{ collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: timedIcs }];
        }),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });
    const result = await service.listEvents(range);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.title).toBe('项目评审');
    expect(result.partial_failures).toEqual([
      { calendar_id: encodeUrl(WORK), name: '工作', reason: expect.stringContaining('权限') },
    ]);
  });

  it('throws NOT_FOUND naming a calendar_ids entry that matches no known calendar (I10)', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    const bogus = encodeUrl('https://caldav.icloud.com/1/calendars/does-not-exist/');
    await expect(
      service.listEvents({ ...range, calendar_ids: [encodeUrl(WORK), bogus] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('isolates a single unparseable object within a calendar: the other event still returns, and the calendar is reported in partial_failures (R2)', async () => {
    const caldav = makeCalDav({
      listCalendars: vi
        .fn()
        .mockResolvedValue([{ url: HOME, name: '个人', readOnly: false, components: ['VEVENT'] }]),
      fetchObjects: vi.fn().mockResolvedValue([
        { collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: timedIcs },
        { collectionUrl: HOME, url: `${HOME}bad-tz.ics`, etag: 'etag-2', data: invalidTzidIcs },
      ]),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });
    const result = await service.listEvents(range);

    // The whole calendar must not vanish: the good object's event is still returned.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.title).toBe('项目评审');
    expect(result.partial_failures).toEqual([
      { calendar_id: encodeUrl(HOME), name: '个人', reason: expect.any(String) },
    ]);
  });
});

describe('CalendarService.createEvent', () => {
  it('writes to the first writable VEVENT calendar by default', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    const event = await service.createEvent({
      title: '新会议',
      start: '2026-09-10T02:00:00Z',
      end: '2026-09-10T03:00:00Z',
    });
    expect(caldav.create).toHaveBeenCalledWith(HOME, expect.stringMatching(/\.ics$/), expect.stringContaining('SUMMARY:新会议'));
    expect(event.title).toBe('新会议');
  });

  it('honours an explicit calendar_id', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.createEvent(
      { title: 'x', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
      encodeUrl(WORK),
    );
    expect(caldav.create).toHaveBeenCalledWith(WORK, expect.anything(), expect.anything());
  });

  it('rejects an end that is not after the start', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(
      service.createEvent({ title: 'x', start: '2026-09-10T03:00:00Z', end: '2026-09-10T02:00:00Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('retries once against the next writable calendar when no calendar_id was given and the default target refuses the write (I6)', async () => {
    const secondWritable = 'https://caldav.icloud.com/1/calendars/second/';
    const caldav = makeCalDav({
      listCalendars: vi.fn().mockResolvedValue([
        { url: HOME, name: '个人', readOnly: false, components: ['VEVENT'] },
        { url: secondWritable, name: '备用', readOnly: false, components: ['VEVENT'] },
      ]),
      create: vi
        .fn()
        .mockImplementationOnce(async () => {
          throw new AppError('PERMISSION_DENIED', 'iCloud 拒绝了对该日历的写入');
        })
        .mockImplementationOnce(async (calendarUrl: string, filename: string, ics: string) => ({
          collectionUrl: calendarUrl,
          url: `${calendarUrl}${filename}`,
          etag: 'etag-new',
          data: ics,
        })),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });

    const event = await service.createEvent({
      title: '新会议',
      start: '2026-09-10T02:00:00Z',
      end: '2026-09-10T03:00:00Z',
    });

    expect(caldav.create).toHaveBeenCalledTimes(2);
    expect((caldav.create as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(HOME);
    expect((caldav.create as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toBe(secondWritable);
    expect(event.title).toBe('新会议');
  });

  it('does not retry against a different calendar when an explicit calendar_id was given', async () => {
    const caldav = makeCalDav({
      create: vi.fn().mockImplementationOnce(async () => {
        throw new AppError('PERMISSION_DENIED', 'iCloud 拒绝了对该日历的写入');
      }),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });

    await expect(
      service.createEvent(
        { title: 'x', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' },
        encodeUrl(HOME),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(caldav.create).toHaveBeenCalledTimes(1);
  });

  it('surfaces the failure when no second writable calendar exists to retry against', async () => {
    const caldav = makeCalDav({
      create: vi.fn().mockImplementationOnce(async () => {
        throw new AppError('PERMISSION_DENIED', 'iCloud 拒绝了对该日历的写入');
      }),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });

    await expect(
      service.createEvent({ title: 'x', start: '2026-09-10T02:00:00Z', end: '2026-09-10T03:00:00Z' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(caldav.create).toHaveBeenCalledTimes(1);
  });
});

describe('CalendarService.updateEvent', () => {
  const eventId = encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL });

  it('merges the patch onto the existing event and bumps the sequence', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.updateEvent(eventId, { title: '改期后的评审' });

    const call = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.url).toBe(EVENT_URL);
    expect(call.etag).toBe('etag-1');
    expect(call.data).toContain('SUMMARY:改期后的评审');
    expect(call.data).toContain('UID:timed-001');
    expect(call.data).toContain('SEQUENCE:1');
  });

  it('keeps untouched fields intact', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.updateEvent(eventId, { location: '会议室 B' });
    const call = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.data).toContain('SUMMARY:项目评审');
    expect(call.data).toContain('LOCATION:会议室 B');
  });

  it('raises CONFLICT when expected_etag does not match', async () => {
    const service = createCalendarService({ account: makeAccount(), caldav: makeCalDav() });
    await expect(
      service.updateEvent(eventId, { title: 'x' }, { expected_etag: 'stale' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a malformed event_id before touching the network', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    await expect(service.updateEvent('garbage', { title: 'x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(caldav.fetchOne).not.toHaveBeenCalled();
  });

  it('keeps attendees when updating an event through the service', async () => {
    const withAttendees = readFileSync(join(process.cwd(), 'tests/fixtures/calendar/with-attendees.ics'), 'utf8');
    const caldav = makeCalDav({
      fetchOne: vi.fn().mockResolvedValue({
        collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: withAttendees,
      }),
    });
    const service = createCalendarService({ account: makeAccount(), caldav });
    await service.updateEvent(encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL }), { location: '会议室 B' });

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('zhangsan@example.com');
    expect(written).toContain('LOCATION:会议室 B');
  });
});

describe('CalendarService.deleteEvent', () => {
  it('deletes with the current etag', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account: makeAccount(), caldav });
    const result = await service.deleteEvent(encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL }));
    expect(caldav.remove).toHaveBeenCalledWith({ url: EVENT_URL, etag: 'etag-1' });
    expect(result).toEqual({ deleted: true });
  });
});
