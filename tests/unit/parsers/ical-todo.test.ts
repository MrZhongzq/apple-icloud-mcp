import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTodoObject, applyTodoPatch, readTodoMeta, parseTodoObject } from '../../../src/parsers/ical.js';
import { encodeRef } from '../../../src/core/ids.js';

const ref = {
  collectionUrl: 'https://caldav.icloud.com/1/calendars/reminders/',
  resourceUrl: 'https://caldav.icloud.com/1/calendars/reminders/x.ics',
};

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/calendar', name), 'utf8');

describe('parseTodoObject', () => {
  it('reads title, notes, due and priority', () => {
    const [todo] = parseTodoObject(fixture('todo-basic.ics'), ref);
    expect(todo!.title).toBe('买咖啡豆');
    expect(todo!.notes).toBe('曼特宁，中深烘');
    expect(todo!.due).toBe('2026-08-15T09:00:00.000Z');
    expect(todo!.priority).toBe(1);
    expect(todo!.completed).toBe(false);
  });

  it('derives completed from STATUS and reports the completion instant', () => {
    const [todo] = parseTodoObject(fixture('todo-completed.ics'), ref);
    expect(todo!.completed).toBe(true);
    expect(todo!.completed_at).toBe('2026-08-11T13:30:00.000Z');
    expect(todo!.percent_complete).toBe(100);
  });

  it('gives the reminder an opaque id derived from its ref', () => {
    const [todo] = parseTodoObject(fixture('todo-basic.ics'), ref);
    expect(todo!.reminder_id).toBe(encodeRef(ref));
    expect(todo!.uid).toBe('todo-001');
  });

  it('handles a DATE-valued due without shifting it by the host timezone', () => {
    const [todo] = parseTodoObject(fixture('todo-with-extras.ics'), ref);
    expect(todo!.due!.slice(0, 10)).toBe('2026-09-01');
  });

  it('returns an empty array when the object holds no VTODO', () => {
    expect(parseTodoObject(fixture('all-day.ics'), ref)).toEqual([]);
  });

  it("treats STATUS:COMPLETED alone as completed", () => {
    const [todo] = parseTodoObject(fixture("todo-completed-status-only.ics"), ref);
    expect(todo!.completed).toBe(true);
    expect(todo!.completed_at).toBeUndefined();
  });

  it("treats PERCENT-COMPLETE:100 alone as completed", () => {
    const [todo] = parseTodoObject(fixture("todo-completed-percent-only.ics"), ref);
    expect(todo!.completed).toBe(true);
  });

  it("keeps an explicit PERCENT-COMPLETE:0 distinct from an absent one", () => {
    const zeroed = readFileSync(join(process.cwd(), "tests/fixtures/calendar", "todo-basic.ics"), "utf8")
      .replace("PRIORITY:1", "PRIORITY:1\r\nPERCENT-COMPLETE:0");
    const [todo] = parseTodoObject(zeroed, ref);
    expect(todo!.completed).toBe(false);
    expect(todo!.percent_complete).toBe(0);
  });
});

describe('buildTodoObject', () => {
  it('produces a parseable VTODO with UID and DTSTAMP', () => {
    const { ics, uid } = buildTodoObject({ title: '新待办', due: '2026-09-10T02:00:00.000Z' });
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('SUMMARY:新待办');
    expect(ics).toContain('DUE:20260910T020000Z');
    expect(ics).toContain('UID:' + uid);
    expect(ics).toContain('DTSTAMP:');
    const [parsed] = parseTodoObject(ics, ref);
    expect(parsed!.title).toBe('新待办');
    expect(parsed!.completed).toBe(false);
  });

  it('writes a DATE-valued due when all_day_due is set', () => {
    const { ics } = buildTodoObject({ title: 'x', due: '2026-09-01T00:00:00.000Z', all_day_due: true });
    expect(ics).toContain('DUE;VALUE=DATE:20260901');
  });

  it('omits DUE entirely when none is given', () => {
    const { ics } = buildTodoObject({ title: '无截止' });
    expect(ics).not.toContain('DUE');
  });
});

describe('applyTodoPatch', () => {
  it('preserves properties the model does not know about', () => {
    const updated = applyTodoPatch(fixture('todo-with-extras.ics'), { title: '改过的标题' });
    expect(updated).toContain('SUMMARY:改过的标题');
    expect(updated).toContain('CATEGORIES:工作,重要');
    expect(updated).toContain('RELATED-TO:todo-001');
    expect(updated).toContain('X-APPLE-SORT-ORDER:12');
    expect(updated).toContain('BEGIN:VALARM');
  });

  it('replaces rather than duplicates a patched property', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { title: '改名' });
    expect(updated.match(/^SUMMARY:/gm)).toHaveLength(1);
    expect(updated).not.toContain('买咖啡豆');
  });

  it('writes the completion trio together when marking done', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { completed: true });
    expect(updated).toContain('STATUS:COMPLETED');
    expect(updated).toMatch(/^COMPLETED:/m);
    expect(updated).toContain('PERCENT-COMPLETE:100');
    const [todo] = parseTodoObject(updated, ref);
    expect(todo!.completed).toBe(true);
  });

  it('clears the completion trio when un-completing', () => {
    const done = applyTodoPatch(fixture('todo-basic.ics'), { completed: true });
    const undone = applyTodoPatch(done, { completed: false });
    expect(undone).toContain('STATUS:NEEDS-ACTION');
    expect(undone).not.toMatch(/^COMPLETED:/m);
    expect(undone).not.toContain('PERCENT-COMPLETE');
    const [todo] = parseTodoObject(undone, ref);
    expect(todo!.completed).toBe(false);
  });

  it('bumps SEQUENCE', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { title: 'x' });
    expect(updated).toContain('SEQUENCE:1');
  });

  it('removes DUE when the patch sets it to null', () => {
    const updated = applyTodoPatch(fixture('todo-basic.ics'), { due: null as never });
    expect(updated).not.toMatch(/^DUE/m);
  });
});

describe('readTodoMeta', () => {
  it('reads the uid and defaults the sequence to zero', () => {
    expect(readTodoMeta(fixture('todo-basic.ics'))).toEqual({ uid: 'todo-001', sequence: 0 });
  });
});
