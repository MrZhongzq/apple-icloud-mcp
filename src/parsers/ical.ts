import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';
import { encodeRef, type ResourceRef } from '../core/ids.js';

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number;
  count?: number;
  until?: string;
  byday?: string[];
  bymonthday?: number[];
}

export interface AlarmSpec {
  minutes_before: number;
  action: 'display' | 'email';
}

export interface Attendee {
  email: string;
  name?: string;
  status?: string;
}

export interface CalendarEvent {
  event_id: string;
  series_id: string;
  recurrence_id?: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  url?: string;
  attendees: Attendee[];
  recurrence?: RecurrenceRule;
  alarms: AlarmSpec[];
}

export interface EventInput {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  url?: string;
  recurrence?: RecurrenceRule;
  alarms?: AlarmSpec[];
}

export interface ParseOptions {
  rangeStart?: Date;
  rangeEnd?: Date;
  expandRecurring?: boolean;
}

const MAX_OCCURRENCES = 500;
const PRODID = '-//apple-icloud-mcp//EN';

function parseRoot(icsText: string): ICAL.Component {
  try {
    return new ICAL.Component(ICAL.parse(icsText));
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', '日历数据解析失败', { cause });
  }
}

/** iCloud 下发的 VTIMEZONE 必须先注册，TZID 才能解析成正确的瞬时时间。 */
function registerTimezones(root: ICAL.Component): void {
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtimezone.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || ICAL.TimezoneService.has(tzid)) continue;
    ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone), tzid);
  }
}

function recurrenceFromEvent(vevent: ICAL.Component): RecurrenceRule | undefined {
  const raw = vevent.getFirstPropertyValue('rrule');
  if (!raw) return undefined;
  const recur = raw as ICAL.Recur;
  const rule: RecurrenceRule = { freq: recur.freq as RecurrenceRule['freq'] };
  if (recur.interval && recur.interval > 1) rule.interval = recur.interval;
  if (recur.count) rule.count = recur.count;
  if (recur.until) rule.until = toIsoString(recur.until);

  const parts = recur.parts as Record<string, unknown> | undefined;
  const byday = parts?.BYDAY;
  if (Array.isArray(byday) && byday.length > 0) rule.byday = byday.map(String);
  const bymonthday = parts?.BYMONTHDAY;
  if (Array.isArray(bymonthday) && bymonthday.length > 0) {
    rule.bymonthday = bymonthday.map(Number);
  }
  return rule;
}

function alarmsFromEvent(vevent: ICAL.Component): AlarmSpec[] {
  const alarms: AlarmSpec[] = [];
  for (const valarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = valarm.getFirstPropertyValue('trigger');
    if (!trigger || typeof trigger === 'string') continue;
    const duration = trigger as ICAL.Duration;
    const minutes = Math.round(Math.abs(duration.toSeconds()) / 60);
    const rawAction = valarm.getFirstPropertyValue('action');
    const action = String(rawAction ?? 'DISPLAY').toUpperCase() === 'EMAIL' ? 'email' : 'display';
    alarms.push({ minutes_before: minutes, action });
  }
  return alarms;
}

function attendeesFromEvent(vevent: ICAL.Component): Attendee[] {
  const out: Attendee[] = [];
  for (const property of vevent.getAllProperties('attendee')) {
    const value = String(property.getFirstValue() ?? '');
    const email = value.replace(/^mailto:/i, '');
    if (!email) continue;
    const attendee: Attendee = { email };
    const name = property.getParameter('cn');
    if (typeof name === 'string') attendee.name = name;
    const status = property.getParameter('partstat');
    if (typeof status === 'string') attendee.status = status;
    out.push(attendee);
  }
  return out;
}

/**
 * `ICAL.Time#toJSDate()` for a DATE-only (all-day) value routes through the JS `Date`
 * constructor's *local* fields (see ical.js `Time#toJSDate`), so the resulting instant
 * shifts by the host machine's UTC offset — an all-day event parsed on a machine west
 * of UTC comes out a day early. All-day values carry no real instant, so we serialise
 * their Y-M-D directly as UTC midnight instead of bouncing through local time.
 */
function toIsoString(time: ICAL.Time): string {
  if (time.isDate) {
    const year = String(time.year).padStart(4, '0');
    const month = String(time.month).padStart(2, '0');
    const day = String(time.day).padStart(2, '0');
    return `${year}-${month}-${day}T00:00:00.000Z`;
  }
  return time.toJSDate().toISOString();
}

function timezoneOf(vevent: ICAL.Component): string | undefined {
  const dtstart = vevent.getFirstProperty('dtstart');
  const tzid = dtstart?.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : undefined;
}

function baseEvent(vevent: ICAL.Component, ref: ResourceRef): Omit<CalendarEvent, 'start' | 'end'> {
  const event = new ICAL.Event(vevent);
  const result: Omit<CalendarEvent, 'start' | 'end'> = {
    event_id: encodeRef(ref),
    series_id: event.uid,
    title: event.summary ?? '',
    all_day: event.startDate.isDate,
    attendees: attendeesFromEvent(vevent),
    alarms: alarmsFromEvent(vevent),
  };

  const tz = timezoneOf(vevent);
  if (tz) result.timezone = tz;
  if (event.location) result.location = event.location;
  if (event.description) result.description = event.description;

  const url = vevent.getFirstPropertyValue('url');
  if (typeof url === 'string' && url) result.url = url;

  const recurrence = recurrenceFromEvent(vevent);
  if (recurrence) result.recurrence = recurrence;

  return result;
}

export function parseCalendarObject(
  icsText: string,
  ref: ResourceRef,
  options: ParseOptions = {},
): CalendarEvent[] {
  const root = parseRoot(icsText);
  registerTimezones(root);

  const vevents = root.getAllSubcomponents('vevent');
  const master = vevents.find((c) => !c.hasProperty('recurrence-id'));
  if (!master) return [];

  const event = new ICAL.Event(master);
  for (const exception of vevents) {
    if (exception === master) continue;
    event.relateException(new ICAL.Event(exception));
  }

  const template = baseEvent(master, ref);

  if (!options.expandRecurring || !event.isRecurring()) {
    return [
      {
        ...template,
        start: toIsoString(event.startDate),
        end: toIsoString(event.endDate),
      },
    ];
  }

  const rangeStart = options.rangeStart ?? event.startDate.toJSDate();
  const rangeEnd = options.rangeEnd;
  // NOTE: Event#iterator(startTime) treats startTime as an override of DTSTART for the
  // RecurExpansion, not a "resume after" cursor — passing rangeStart here silently
  // recomputes the recurrence from midnight UTC on that date, discarding the original
  // wall-clock time and weekday. Always expand from the true startDate and filter below.
  const iterator = event.iterator();

  const occurrences: CalendarEvent[] = [];
  let next = iterator.next();
  while (next && occurrences.length < MAX_OCCURRENCES) {
    const startsAt = next.toJSDate();
    if (rangeEnd && startsAt >= rangeEnd) break;

    if (startsAt >= rangeStart) {
      const details = event.getOccurrenceDetails(next);
      occurrences.push({
        ...template,
        title: details.item.summary ?? template.title,
        recurrence_id: toIsoString(details.startDate),
        start: toIsoString(details.startDate),
        end: toIsoString(details.endDate),
      });
    }
    next = iterator.next();
  }

  return occurrences;
}

function toIcalTime(iso: string, allDay: boolean): ICAL.Time {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('INVALID_INPUT', `时间格式不正确：${iso}`, {
      hint: '请使用 ISO 8601 格式，例如 2026-09-10T14:00:00+08:00',
    });
  }
  const time = ICAL.Time.fromJSDate(date, true);
  if (allDay) {
    return ICAL.Time.fromData({
      year: time.year,
      month: time.month,
      day: time.day,
      isDate: true,
    });
  }
  return time;
}

function recurrenceToString(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const until = ICAL.Time.fromJSDate(new Date(rule.until), true);
    parts.push(`UNTIL=${until.toICALString()}`);
  }
  if (rule.byday && rule.byday.length > 0) parts.push(`BYDAY=${rule.byday.join(',')}`);
  if (rule.bymonthday && rule.bymonthday.length > 0) {
    parts.push(`BYMONTHDAY=${rule.bymonthday.join(',')}`);
  }
  return parts.join(';');
}

export function buildCalendarObject(
  input: EventInput,
  existing?: { uid: string; sequence: number },
): { ics: string; uid: string } {
  const uid = existing?.uid ?? randomUUID();
  const allDay = input.all_day === true;

  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', PRODID);

  const vevent = new ICAL.Component(['vevent', [], []]);
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue('sequence', String((existing?.sequence ?? -1) + 1));
  vevent.addPropertyWithValue('summary', input.title);
  vevent.addPropertyWithValue('dtstart', toIcalTime(input.start, allDay));
  vevent.addPropertyWithValue('dtend', toIcalTime(input.end, allDay));

  if (input.location) vevent.addPropertyWithValue('location', input.location);
  if (input.description) vevent.addPropertyWithValue('description', input.description);
  if (input.url) vevent.addPropertyWithValue('url', input.url);
  if (input.recurrence) {
    vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(recurrenceToString(input.recurrence)));
  }

  for (const alarm of input.alarms ?? []) {
    const valarm = new ICAL.Component(['valarm', [], []]);
    valarm.addPropertyWithValue('action', alarm.action === 'email' ? 'EMAIL' : 'DISPLAY');
    valarm.addPropertyWithValue('description', input.title);
    valarm.addPropertyWithValue(
      'trigger',
      ICAL.Duration.fromSeconds(-Math.abs(alarm.minutes_before) * 60),
    );
    vevent.addSubcomponent(valarm);
  }

  calendar.addSubcomponent(vevent);
  return { ics: calendar.toString(), uid };
}
