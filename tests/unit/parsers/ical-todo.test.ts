import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTodoObject } from '../../../src/parsers/ical.js';
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
