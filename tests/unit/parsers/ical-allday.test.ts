import { describe, it, expect } from 'vitest';
import { buildCalendarObject, buildTodoObject, applyEventPatch, applyTodoPatch } from '../../../src/parsers/ical.js';

/**
 * 全天值是"日历日期"，不是"瞬时时间"：它必须等于调用方在自己给出的偏移量里写下的
 * 那个年月日。把它当成瞬时时间再用 UTC 渲染，会让任何跨越午夜的偏移量整整错开一天
 * （2026-09-01T00:00:00+08:00 在 UTC 里是 8-31）。这组用例锁死三种偏移量：正、Z、负。
 *
 * 这些断言只依赖入参字符串本身，不依赖宿主机时区，因此在 TZ=Pacific/Auckland、
 * TZ=America/New_York、TZ=UTC 下结果必须完全一致。
 */
describe('all-day values keep the caller-supplied calendar date', () => {
  const cases: Array<{ label: string; iso: string; expected: string }> = [
    { label: 'positive offset (+08:00)', iso: '2026-09-01T00:00:00+08:00', expected: '20260901' },
    { label: 'UTC (Z)', iso: '2026-09-01T00:00:00Z', expected: '20260901' },
    { label: 'negative offset (-05:00)', iso: '2026-09-01T23:00:00-05:00', expected: '20260901' },
    { label: 'late hour, positive offset', iso: '2026-09-01T23:30:00+08:00', expected: '20260901' },
  ];

  describe('VEVENT all_day', () => {
    for (const { label, iso, expected } of cases) {
      it(`writes DTSTART;VALUE=DATE:${expected} for ${label}`, () => {
        const { ics } = buildCalendarObject({
          title: '休假',
          start: iso,
          end: iso,
          all_day: true,
        });
        expect(ics).toContain(`DTSTART;VALUE=DATE:${expected}`);
      });
    }

    it('keeps the caller date when all_day is applied through a patch', () => {
      const { ics } = buildCalendarObject({
        title: '休假',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-02T00:00:00Z',
      });
      const patched = applyEventPatch(ics, {
        start: '2026-09-01T00:00:00+08:00',
        end: '2026-09-02T00:00:00+08:00',
        all_day: true,
      });
      expect(patched).toContain('DTSTART;VALUE=DATE:20260901');
    });
  });

  describe('VTODO all_day_due', () => {
    for (const { label, iso, expected } of cases) {
      it(`writes DUE;VALUE=DATE:${expected} for ${label}`, () => {
        const { ics } = buildTodoObject({ title: '交房租', due: iso, all_day_due: true });
        expect(ics).toContain(`DUE;VALUE=DATE:${expected}`);
      });
    }

    it('keeps the caller date when all_day_due is applied through a patch', () => {
      const { ics } = buildTodoObject({ title: '交房租', due: '2026-01-01T00:00:00Z' });
      const patched = applyTodoPatch(ics, { due: '2026-09-01T00:00:00+08:00', all_day_due: true });
      expect(patched).toContain('DUE;VALUE=DATE:20260901');
    });
  });
});
