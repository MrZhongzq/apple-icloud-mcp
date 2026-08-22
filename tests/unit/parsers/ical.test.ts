import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCalendarObject, buildCalendarObject } from '../../../src/parsers/ical.js';

const ref = {
  collectionUrl: 'https://caldav.icloud.com/1/calendars/home/',
  resourceUrl: 'https://caldav.icloud.com/1/calendars/home/x.ics',
};

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/calendar', name), 'utf8');

describe('parseCalendarObject', () => {
  it('resolves a TZID-qualified start time to the correct instant', () => {
    const [event] = parseCalendarObject(fixture('timed-shanghai.ics'), ref);
    expect(event!.start).toBe('2026-08-17T06:00:00.000Z');
    expect(event!.end).toBe('2026-08-17T07:00:00.000Z');
    expect(event!.all_day).toBe(false);
    expect(event!.timezone).toBe('Asia/Shanghai');
  });

  it('extracts title, location, description and alarms', () => {
    const [event] = parseCalendarObject(fixture('timed-shanghai.ics'), ref);
    expect(event!.title).toBe('项目评审');
    expect(event!.location).toBe('会议室 A');
    expect(event!.description).toBe('讨论重构方案');
    expect(event!.alarms).toEqual([{ minutes_before: 15, action: 'display' }]);
  });

  it('marks a DATE-valued event as all day', () => {
    const [event] = parseCalendarObject(fixture('all-day.ics'), ref);
    expect(event!.all_day).toBe(true);
    expect(event!.start.slice(0, 10)).toBe('2026-09-01');
  });

  it('returns the unexpanded series when expandRecurring is false', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      expandRecurring: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.recurrence).toEqual({ freq: 'WEEKLY', count: 4, byday: ['MO'] });
    expect(events[0]!.recurrence_id).toBeUndefined();
  });

  it('expands occurrences within the range and honours EXDATE', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    expect(events.map((e) => e.start)).toEqual([
      '2026-08-03T09:00:00.000Z',
      '2026-08-17T09:00:00.000Z',
      '2026-08-24T09:00:00.000Z',
    ]);
    expect(events.every((e) => e.series_id === 'weekly-001')).toBe(true);
    expect(events[1]!.recurrence_id).toBe('2026-08-17T09:00:00.000Z');
  });

  it('clips expansion to the requested range', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      rangeStart: new Date('2026-08-16T00:00:00Z'),
      rangeEnd: new Date('2026-08-20T00:00:00Z'),
      expandRecurring: true,
    });
    expect(events.map((e) => e.start)).toEqual(['2026-08-17T09:00:00.000Z']);
  });

  it('keeps the local wall-clock time across a DST transition', () => {
    const events = parseCalendarObject(fixture('dst-newyork.ics'), ref, {
      rangeStart: new Date('2026-10-01T00:00:00Z'),
      rangeEnd: new Date('2026-12-01T00:00:00Z'),
      expandRecurring: true,
    });
    // 本地时间都是 09:00，但 11 月 1 日回拨后 UTC 时刻要晚一小时
    expect(events.map((e) => e.start)).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-09T14:00:00.000Z',
    ]);
  });

  it('gives every event the same opaque id derived from its ref', () => {
    const events = parseCalendarObject(fixture('weekly-with-exdate.ics'), ref, {
      rangeStart: new Date('2026-08-01T00:00:00Z'),
      rangeEnd: new Date('2026-09-01T00:00:00Z'),
      expandRecurring: true,
    });
    const ids = new Set(events.map((e) => e.event_id));
    expect(ids.size).toBe(1);
  });
});

describe('buildCalendarObject', () => {
  it('produces a parseable VEVENT with UTC timestamps', () => {
    const { ics, uid } = buildCalendarObject({
      title: '新会议',
      start: '2026-09-10T02:00:00.000Z',
      end: '2026-09-10T03:00:00.000Z',
    });
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:新会议');
    expect(ics).toContain('DTSTART:20260910T020000Z');
    expect(uid).toMatch(/.+/);

    const [parsed] = parseCalendarObject(ics, ref);
    expect(parsed!.start).toBe('2026-09-10T02:00:00.000Z');
    expect(parsed!.title).toBe('新会议');
  });

  it('writes all-day events as DATE values', () => {
    const { ics } = buildCalendarObject({
      title: '休假',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
      all_day: true,
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260901');
  });

  it('serialises a structured recurrence rule', () => {
    const { ics } = buildCalendarObject({
      title: '周会',
      start: '2026-09-07T09:00:00.000Z',
      end: '2026-09-07T09:30:00.000Z',
      recurrence: { freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'] },
    });
    expect(ics).toMatch(/RRULE:.*FREQ=WEEKLY/);
    expect(ics).toMatch(/RRULE:.*INTERVAL=2/);
    expect(ics).toMatch(/RRULE:.*BYDAY=MO,WE/);
  });

  it('serialises alarms as relative triggers', () => {
    const { ics } = buildCalendarObject({
      title: '提醒测试',
      start: '2026-09-07T09:00:00.000Z',
      end: '2026-09-07T09:30:00.000Z',
      alarms: [{ minutes_before: 30, action: 'display' }],
    });
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT30M');
  });

  it('keeps the uid and bumps the sequence when updating', () => {
    const { ics, uid } = buildCalendarObject(
      { title: '改过的会议', start: '2026-09-10T02:00:00.000Z', end: '2026-09-10T03:00:00.000Z' },
      { uid: 'existing-uid', sequence: 2 },
    );
    expect(uid).toBe('existing-uid');
    expect(ics).toContain('UID:existing-uid');
    expect(ics).toContain('SEQUENCE:3');
  });
});
