import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { parseCalendarObject, addExdate } from '../../../src/parsers/ical.js';

const ref = { collectionUrl: 'https://c/1/cal/', resourceUrl: 'https://c/1/cal/a.ics' };
const CRLF = String.fromCharCode(13, 10);

/** 两份都声明 Asia/Shanghai，但偏移量不同 —— 现实中不会这样，正因如此它能证明串扰。
 *  带 RRULE，使 addExdate 有重复规则可以锚定。 */
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
    'RRULE:FREQ=DAILY;COUNT=10',
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

  it('does not let a polluted global registry corrupt an EXDATE', () => {
    // 解析路径优先用文档自带的 VTIMEZONE（Component#getTimeZoneByID），所以它看不见
    // 全局表的污染。真正会去查全局表的是 anchorToMaster（ical.ts:694），走
    // addExdate / upsertOverride 这两条补丁路径。
    const poisoned = new ICAL.Component(ICAL.parse(calendarWithTz('-0500', '10')))
      .getFirstSubcomponent('vtimezone')!;
    ICAL.TimezoneService.register(new ICAL.Timezone(poisoned), 'Asia/Shanghai');
    try {
      const out = addExdate(calendarWithTz('+0800', '10'), '2026-09-02T10:00:00+08:00');
      const exdate = out.split(/\r?\n/).find((l) => l.startsWith('EXDATE')) ?? '';
      expect(
        exdate,
        '全局表被别的租户污染时，EXDATE 会锚到错误的时刻——用户删掉的是另一天那一次',
      ).toContain('20260902T100000');
    } finally {
      ICAL.TimezoneService.remove('Asia/Shanghai');
    }
  });
});
