import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCalendarService } from '../../../src/modules/calendar/service.js';
import { encodeRef } from '../../../src/core/ids.js';
import type { AccountConfig } from '../../../src/core/config.js';
import type { CalDavProvider } from '../../../src/providers/icloud/caldav.js';

const HOME = 'https://caldav.icloud.com/1/calendars/home/';
const EVENT_URL = `${HOME}weekly-001.ics`;
const eventId = encodeRef({ collectionUrl: HOME, resourceUrl: EVENT_URL });

const weekly = readFileSync(
  join(process.cwd(), 'tests/fixtures/calendar/weekly-with-exdate.ics'),
  'utf8',
);
const nonRecurring = readFileSync(
  join(process.cwd(), 'tests/fixtures/calendar/with-attendees.ics'),
  'utf8',
);

const account: AccountConfig = {
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
  },
};

function makeCalDav(data: string = weekly): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi
      .fn()
      .mockResolvedValue([{ url: HOME, name: '个人', readOnly: false, components: ['VEVENT'] }]),
    fetchObjects: vi.fn().mockResolvedValue([]),
    fetchOne: vi
      .fn()
      .mockResolvedValue({ collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data }),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('single-occurrence scope', () => {
  it('adds an EXDATE instead of deleting the series', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    await service.deleteEvent(eventId, { scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' });

    expect(caldav.remove).not.toHaveBeenCalled();
    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('20260817T090000Z');
    expect(written).toContain('RRULE');
  });

  it('writes an override when updating a single occurrence', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    const result = await service.updateEvent(
      eventId,
      { title: '这次改到下午', start: '2026-08-17T14:00:00.000Z', end: '2026-08-17T15:00:00.000Z' },
      { scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' },
    );

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('RECURRENCE-ID');
    expect(written).toContain('这次改到下午');

    expect(result.title).toBe('这次改到下午');
    expect(result.start).toBe('2026-08-17T14:00:00.000Z');
  });

  it('requires recurrence_id when scope is this', async () => {
    const service = createCalendarService({ account, caldav: makeCalDav() });
    await expect(
      service.updateEvent(eventId, { title: 'x' }, { scope: 'this' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps the occurrence duration when patching only a non-time field', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });

    await service.updateEvent(eventId, { title: '只改标题' }, {
      scope: 'this',
      recurrence_id: '2026-08-17T09:00:00.000Z',
    });

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    const override = written
      .split('BEGIN:VEVENT')
      .find((block) => block.includes('RECURRENCE-ID'));
    expect(override).toBeDefined();
    expect(override).toContain('DTSTART:20260817T090000Z');
    expect(override).toContain('DTEND:20260817T093000Z');
  });

  it('requires recurrence_id when deleting a single occurrence', async () => {
    const service = createCalendarService({ account, caldav: makeCalDav() });
    await expect(service.deleteEvent(eventId, { scope: 'this' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a malformed start with a clear error rather than a generic one', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });

    await expect(
      service.updateEvent(eventId, { start: 'next tuesday' }, {
        scope: 'this',
        recurrence_id: '2026-08-17T09:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(caldav.update).not.toHaveBeenCalled();
  });

  it('still deletes the whole series when scope is all', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    await service.deleteEvent(eventId);
    expect(caldav.remove).toHaveBeenCalled();
  });
});

describe('scope: this on a non-recurring event (I4)', () => {
  it('rejects deleteEvent with INVALID_INPUT and writes nothing', async () => {
    const caldav = makeCalDav(nonRecurring);
    const service = createCalendarService({ account, caldav });
    await expect(
      service.deleteEvent(eventId, { scope: 'this', recurrence_id: '2026-08-17T06:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.update).not.toHaveBeenCalled();
    expect(caldav.remove).not.toHaveBeenCalled();
  });

  it('rejects updateEvent with INVALID_INPUT and writes nothing', async () => {
    const caldav = makeCalDav(nonRecurring);
    const service = createCalendarService({ account, caldav });
    await expect(
      service.updateEvent(
        eventId,
        { title: 'x' },
        { scope: 'this', recurrence_id: '2026-08-17T06:00:00.000Z' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.update).not.toHaveBeenCalled();
  });

  it('the non-recurring rejection hint points at scope: all', async () => {
    const caldav = makeCalDav(nonRecurring);
    const service = createCalendarService({ account, caldav });
    try {
      await service.deleteEvent(eventId, { scope: 'this', recurrence_id: '2026-08-17T06:00:00.000Z' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain('all');
    }
  });
});

describe('scope: this with a recurrence_id that matches no real occurrence (I4)', () => {
  it('rejects updateEvent before writing anything', async () => {
    const caldav = makeCalDav(weekly);
    const service = createCalendarService({ account, caldav });
    // weekly-with-exdate.ics only has occurrences on 08-03, 08-17, 08-24 (08-10 is
    // excluded); this instant does not correspond to any actual occurrence at all.
    await expect(
      service.updateEvent(
        eventId,
        { title: 'x' },
        { scope: 'this', recurrence_id: '2026-08-05T09:00:00.000Z' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.update).not.toHaveBeenCalled();
  });

  it('rejects deleteEvent before writing anything', async () => {
    const caldav = makeCalDav(weekly);
    const service = createCalendarService({ account, caldav });
    await expect(
      service.deleteEvent(eventId, { scope: 'this', recurrence_id: '2026-08-05T09:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(caldav.update).not.toHaveBeenCalled();
    expect(caldav.remove).not.toHaveBeenCalled();
  });
});
