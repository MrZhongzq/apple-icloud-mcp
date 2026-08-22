import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addExdate, upsertOverride, parseCalendarObject } from '../../../src/parsers/ical.js';

const ref = {
  collectionUrl: 'https://caldav.icloud.com/1/calendars/home/',
  resourceUrl: 'https://caldav.icloud.com/1/calendars/home/weekly-001.ics',
};

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/calendar', name), 'utf8');

const weekly = fixture('weekly-with-exdate.ics');
const withOverride = fixture('weekly-with-override.ics');
const allDayWeekly = fixture('all-day-weekly.ics');
const timedShanghaiWeekly = fixture('timed-shanghai-weekly.ics');

const range = {
  rangeStart: new Date('2026-08-01T00:00:00Z'),
  rangeEnd: new Date('2026-09-01T00:00:00Z'),
  expandRecurring: true,
};

/** 从 ICS 文本中取出指定的 VEVENT 块，避免用字符串位置去猜属性顺序。 */
function veventBlocks(ics: string): string[] {
  return ics
    .split('BEGIN:VEVENT')
    .slice(1)
    .map((block) => block.split('END:VEVENT')[0] ?? '');
}

function overrideBlock(ics: string): string {
  const found = veventBlocks(ics).find((b) => b.includes('RECURRENCE-ID'));
  if (!found) throw new Error('没有找到带 RECURRENCE-ID 的覆盖组件');
  return found;
}

describe('addExdate', () => {
  it('removes one occurrence from the expanded series', () => {
    const updated = addExdate(weekly, '2026-08-17T09:00:00.000Z');
    const starts = parseCalendarObject(updated, ref, range).map((e) => e.start);
    expect(starts).toEqual(['2026-08-03T09:00:00.000Z', '2026-08-24T09:00:00.000Z']);
  });

  it('keeps the pre-existing EXDATE', () => {
    const updated = addExdate(weekly, '2026-08-17T09:00:00.000Z');
    expect(updated).toContain('20260810T090000Z');
  });

  it('is idempotent for the same occurrence', () => {
    const once = addExdate(weekly, '2026-08-17T09:00:00.000Z');
    const twice = addExdate(once, '2026-08-17T09:00:00.000Z');
    const starts = parseCalendarObject(twice, ref, range).map((e) => e.start);
    expect(starts).toHaveLength(2);
  });
});

describe('upsertOverride', () => {
  it('changes only the targeted occurrence', () => {
    const updated = upsertOverride(weekly, '2026-08-17T09:00:00.000Z', {
      title: '临时改到下午',
      start: '2026-08-17T14:00:00.000Z',
      end: '2026-08-17T15:00:00.000Z',
    });
    const events = parseCalendarObject(updated, ref, range);
    const changed = events.find((e) => e.start === '2026-08-17T14:00:00.000Z');
    expect(changed?.title).toBe('临时改到下午');
    expect(events.find((e) => e.start === '2026-08-03T09:00:00.000Z')?.title).toBe('周会');
  });

  it('reuses the series uid for the override', () => {
    const updated = upsertOverride(weekly, '2026-08-17T09:00:00.000Z', {
      title: 'x',
      start: '2026-08-17T14:00:00.000Z',
      end: '2026-08-17T15:00:00.000Z',
    });
    expect(updated.match(/UID:weekly-001/g)).toHaveLength(2);
    expect(updated).toContain('RECURRENCE-ID');
  });

  it('replaces an existing override instead of appending a second one', () => {
    const once = upsertOverride(weekly, '2026-08-17T09:00:00.000Z', {
      title: '第一次改',
      start: '2026-08-17T14:00:00.000Z',
      end: '2026-08-17T15:00:00.000Z',
    });
    const twice = upsertOverride(once, '2026-08-17T09:00:00.000Z', {
      title: '第二次改',
      start: '2026-08-17T16:00:00.000Z',
      end: '2026-08-17T17:00:00.000Z',
    });
    expect(twice.match(/RECURRENCE-ID/g)).toHaveLength(1);
    expect(twice).toContain('第二次改');
    expect(twice).not.toContain('第一次改');
  });

  it('carries the series attendees onto a newly created override', () => {
    const updated = upsertOverride(fixture('recurring-with-attendees.ics'), '2026-08-10T09:00:00.000Z', {
      title: '改到大会议室',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T09:30:00.000Z',
    });
    const block = overrideBlock(updated);
    expect(block).toContain('zhangsan@example.com');
    expect(block).toContain('ORGANIZER');
    expect(block).not.toContain('RRULE');
  });

  it("preserves an existing override's own properties when patching it again", () => {
    const once = upsertOverride(fixture('recurring-with-attendees.ics'), '2026-08-10T09:00:00.000Z', {
      title: '第一次改', start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T09:30:00.000Z',
    });
    const twice = upsertOverride(once, '2026-08-10T09:00:00.000Z', {
      title: '第二次改', start: '2026-08-10T14:00:00.000Z', end: '2026-08-10T14:30:00.000Z',
    });
    expect(twice).toContain('第二次改');
    expect(twice).not.toContain('第一次改');
    expect(twice.match(/RECURRENCE-ID/g)).toHaveLength(1);
    expect(overrideBlock(twice)).toContain('zhangsan@example.com');
  });

  it('keeps recurrence_id pinned to the original slot after an occurrence is moved', () => {
    const moved = upsertOverride(fixture('weekly-with-override.ics'), '2026-08-10T09:00:00.000Z', {
      title: '挪到下午',
      start: '2026-08-10T14:00:00.000Z',
      end: '2026-08-10T14:30:00.000Z',
    });
    const events = parseCalendarObject(moved, ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    const occurrence = events.find((e) => e.title === '挪到下午');
    expect(occurrence!.start).toBe('2026-08-10T14:00:00.000Z');
    expect(occurrence!.recurrence_id).toBe('2026-08-10T09:00:00.000Z');
  });
});

describe('addExdate removes an orphaned override (I2)', () => {
  it('removes the RECURRENCE-ID component for the excluded slot, not just adds EXDATE to the master', () => {
    const updated = addExdate(withOverride, '2026-08-10T09:00:00.000Z');
    expect(veventBlocks(updated).some((b) => b.includes('RECURRENCE-ID'))).toBe(false);
    const master = veventBlocks(updated).find((b) => !b.includes('RECURRENCE-ID'));
    expect(master).toContain('EXDATE');
    expect(master).toContain('20260810T090000Z');
  });

  it('leaves an override at a different slot untouched', () => {
    const updated = addExdate(withOverride, '2026-08-17T09:00:00.000Z');
    // override-001's only RECURRENCE-ID is 20260810T090000Z, unrelated to the excluded slot
    expect(overrideBlock(updated)).toContain('20260810T090000Z');
  });
});

describe('RECURRENCE-ID / EXDATE value-type matching the master (I3)', () => {
  it('addExdate writes VALUE=DATE for an all-day series, and the excluded occurrence stops appearing', () => {
    const updated = addExdate(allDayWeekly, '2026-09-08T00:00:00.000Z');
    const master = veventBlocks(updated)[0]!;
    expect(master).toMatch(/EXDATE;VALUE=DATE:20260908/);

    const events = parseCalendarObject(updated, ref, {
      rangeStart: new Date('2026-09-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-30T00:00:00Z'),
      expandRecurring: true,
    });
    expect(events.map((e) => e.start.slice(0, 10))).toEqual(['2026-09-01', '2026-09-15']);
  });

  it('upsertOverride writes a VALUE=DATE RECURRENCE-ID for an all-day series, and the override actually relates', () => {
    const updated = upsertOverride(allDayWeekly, '2026-09-08T00:00:00.000Z', {
      title: '改到别处',
      start: '2026-09-08T00:00:00.000Z',
      end: '2026-09-09T00:00:00.000Z',
      all_day: true,
    });
    expect(overrideBlock(updated)).toMatch(/RECURRENCE-ID;VALUE=DATE:20260908/);

    const events = parseCalendarObject(updated, ref, {
      rangeStart: new Date('2026-09-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-30T00:00:00Z'),
      expandRecurring: true,
    });
    const edited = events.find((e) => e.start.slice(0, 10) === '2026-09-08');
    expect(edited!.title).toBe('改到别处');
    expect(events.find((e) => e.start.slice(0, 10) === '2026-09-01')!.title).toBe('全天周会');
    expect(events.find((e) => e.start.slice(0, 10) === '2026-09-15')!.title).toBe('全天周会');
  });

  it('addExdate writes the same TZID as the master for a TZID-anchored series', () => {
    const updated = addExdate(timedShanghaiWeekly, '2026-08-10T06:00:00.000Z');
    const master = veventBlocks(updated)[0]!;
    expect(master).toContain('EXDATE;TZID=Asia/Shanghai:20260810T140000');

    const events = parseCalendarObject(updated, ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    expect(events.map((e) => e.start)).toEqual(['2026-08-03T06:00:00.000Z', '2026-08-17T06:00:00.000Z']);
  });

  it('upsertOverride writes a TZID-matching RECURRENCE-ID for a TZID-anchored series, and the override actually relates', () => {
    const updated = upsertOverride(timedShanghaiWeekly, '2026-08-10T06:00:00.000Z', {
      title: '临时改期',
      start: '2026-08-10T07:00:00.000Z',
      end: '2026-08-10T08:00:00.000Z',
    });
    expect(overrideBlock(updated)).toContain('RECURRENCE-ID;TZID=Asia/Shanghai:20260810T140000');

    const events = parseCalendarObject(updated, ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    const edited = events.find((e) => e.title === '临时改期');
    expect(edited).toBeDefined();
    expect(events.find((e) => e.start === '2026-08-03T06:00:00.000Z')!.title).toBe('周三会议');
    expect(events.find((e) => e.start === '2026-08-17T06:00:00.000Z')!.title).toBe('周三会议');
  });
});
