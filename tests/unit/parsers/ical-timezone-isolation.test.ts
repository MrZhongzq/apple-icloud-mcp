import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { parseCalendarObject } from '../../../src/parsers/ical.js';

const ref = { collectionUrl: 'https://c/1/cal/', resourceUrl: 'https://c/1/cal/a.ics' };
const CRLF = String.fromCharCode(13, 10);

/** 两份都声明 Asia/Shanghai，但偏移量不同 —— 现实中不会这样，正因如此它能证明串扰。 */
function calendarWithTz(offset: string, hour: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//probe//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:' + offset,
    'TZOFFSETTO:' + offset,
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:evt-1',
    'DTSTAMP:20260101T000000Z',
    'SUMMARY:probe',
    'DTSTART;TZID=Asia/Shanghai:20260901T' + hour + '0000',
    'DTEND;TZID=Asia/Shanghai:20260901T' + hour + '3000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF);
}

describe('timezone registry isolation', () => {
  it('leaves no TZID registered after parsing', () => {
    const before = ICAL.TimezoneService.has('Asia/Shanghai');
    parseCalendarObject(calendarWithTz('+0800', '10'), ref);
    expect(
      ICAL.TimezoneService.has('Asia/Shanghai'),
      '解析完必须把自己注册的 TZID 摘掉，否则下一个租户的同名时区会被它支配',
    ).toBe(before);
  });

  it('cleans up even when parsing throws', () => {
    const before = ICAL.TimezoneService.has('Asia/Shanghai');
    const broken = calendarWithTz('+0800', '10').replace('END:VCALENDAR', '');
    try {
      parseCalendarObject(broken, ref);
    } catch {
      // 预期可能抛
    }
    expect(ICAL.TimezoneService.has('Asia/Shanghai')).toBe(before);
  });

  it('does not let one calendar definition govern another with the same TZID', () => {
    const first = parseCalendarObject(calendarWithTz('+0800', '10'), ref);
    const second = parseCalendarObject(calendarWithTz('+0100', '10'), ref);
    // 两份都写 10:00 本地时间，但偏移量差 7 小时，所以 UTC 瞬时必须不同。
    // 若第一份的定义残留在全局表里支配了第二份，两个值会相等。
    expect(
      second[0]!.start,
      '两份日历对同一 TZID 的定义不同，解析结果就必须不同',
    ).not.toBe(first[0]!.start);
  });
});
