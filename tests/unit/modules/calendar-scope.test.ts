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

function makeCalDav(): CalDavProvider {
  return {
    verify: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi
      .fn()
      .mockResolvedValue([{ url: HOME, name: '个人', readOnly: false, components: ['VEVENT'] }]),
    fetchObjects: vi.fn().mockResolvedValue([]),
    fetchOne: vi
      .fn()
      .mockResolvedValue({ collectionUrl: HOME, url: EVENT_URL, etag: 'etag-1', data: weekly }),
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
    await service.updateEvent(
      eventId,
      { title: '这次改到下午', start: '2026-08-17T14:00:00.000Z', end: '2026-08-17T15:00:00.000Z' },
      { scope: 'this', recurrence_id: '2026-08-17T09:00:00.000Z' },
    );

    const written = (caldav.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data as string;
    expect(written).toContain('RECURRENCE-ID');
    expect(written).toContain('这次改到下午');
  });

  it('requires recurrence_id when scope is this', async () => {
    const service = createCalendarService({ account, caldav: makeCalDav() });
    await expect(
      service.updateEvent(eventId, { title: 'x' }, { scope: 'this' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('still deletes the whole series when scope is all', async () => {
    const caldav = makeCalDav();
    const service = createCalendarService({ account, caldav });
    await service.deleteEvent(eventId);
    expect(caldav.remove).toHaveBeenCalled();
  });
});
