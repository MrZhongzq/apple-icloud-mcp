import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { parseCalendarObject, addExdate, applyEventPatch } from '../../../src/parsers/ical.js';

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

/** 同一份文档里同一个 TZID 出现两次（畸形输入）——用来证明去重逻辑不会把"这次调用
 *  自己刚注册的值"错当成"调用前的原值"存进快照。 */
function calendarWithDuplicateTz(offsetA: string, offsetB: string, hour: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//probe//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:' + offsetA,
    'TZOFFSETTO:' + offsetA,
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:' + offsetB,
    'TZOFFSETTO:' + offsetB,
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

  it('restores the registry when the wrapped work throws after registration', () => {
    const before = ICAL.TimezoneService.has('Asia/Shanghai');
    // 只有 VTIMEZONE、没有 VEVENT：registerTimezones 会先注册成功，
    // 随后 applyEventPatch 因为找不到 VEVENT 而抛 —— 这才走到 finally。
    // 原来那条测试用截断日历，异常在 parseRoot 里就抛了，根本没注册过东西。
    const noEvent = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//p//EN',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai',
      'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST',
      'END:STANDARD', 'END:VTIMEZONE',
      'END:VCALENDAR',
    ].join(CRLF);

    expect(() => applyEventPatch(noEvent, { title: 'x' })).toThrow();
    expect(
      ICAL.TimezoneService.has('Asia/Shanghai'),
      '注册之后才抛的异常必须走到 finally，否则一份坏日历就在全局表里留下永久占位',
    ).toBe(before);
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

  it('restores the true prior entry, not its own leaked copy, when a document repeats one TZID', () => {
    // 先放一个"别处合法注册"的哨兵定义，代表调用前的真实状态。
    const sentinel = new ICAL.Component(ICAL.parse(calendarWithTz('+0900', '10')))
      .getFirstSubcomponent('vtimezone')!;
    const sentinelZone = new ICAL.Timezone(sentinel);
    ICAL.TimezoneService.register(sentinelZone, 'Asia/Shanghai');
    try {
      parseCalendarObject(calendarWithDuplicateTz('+0800', '+0100', '10'), ref);
      expect(
        ICAL.TimezoneService.get('Asia/Shanghai'),
        '恢复顺序错了的话，真正的哨兵定义会先被放回去，随后又被这次调用自己（第二个重复 TZID）泄漏的对象覆盖',
      ).toBe(sentinelZone);
    } finally {
      ICAL.TimezoneService.remove('Asia/Shanghai');
    }
  });
});
