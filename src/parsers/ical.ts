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

/**
 * `timezone` is intentionally absent here (unlike on `CalendarEvent`). Creating an event
 * with a local-wall-clock anchor (`DTSTART;TZID=...`) requires shipping a matching
 * VTIMEZONE component, which needs timezone rule data phase one does not have. Every
 * event we build is UTC-anchored instead: fine for a one-off event, since the ISO
 * `start`/`end` already carry an absolute instant, but a UTC-anchored *recurring* event
 * drifts an hour across any DST transition its RRULE crosses. This is a deliberate,
 * documented gap for phase one, not an oversight -- local-wall-clock anchoring for
 * recurring events is deferred to a later task that can supply VTIMEZONE data.
 */
export interface EventInput {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
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
/** Hard stop on RecurExpansion steps, independent of how many occurrences fall in range.
 *  Expansion always walks forward from the true DTSTART (see the note on `iterator()`
 *  below), so a query far in the future against a FREQ=SECONDLY/MINUTELY rule from a
 *  subscribed third-party calendar would otherwise iterate for a very long time before
 *  ever reaching rangeEnd. This is a stdio server; an unbounded loop is a hang, not an
 *  error, so we cap iteration count itself, separately from the emitted-occurrence cap. */
const MAX_ITERATIONS = 50000;
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

const RECUR_FREQS: ReadonlySet<string> = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

function recurrenceFromEvent(vevent: ICAL.Component): RecurrenceRule | undefined {
  const raw = vevent.getFirstPropertyValue('rrule');
  if (!raw) return undefined;
  const recur = raw as ICAL.Recur;

  // recur.freq is typed as the bare string alias `frequencyValues`, so a rule this
  // module cannot represent (e.g. FREQ=SECONDLY) must be validated against our own
  // closed union rather than asserted into it -- otherwise we would report a value our
  // own type claims is impossible.
  if (!RECUR_FREQS.has(recur.freq)) return undefined;
  const rule: RecurrenceRule = { freq: recur.freq as RecurrenceRule['freq'] };
  if (recur.interval && recur.interval > 1) rule.interval = recur.interval;
  if (recur.count) rule.count = recur.count;
  if (recur.until) rule.until = toIsoString(recur.until);

  const byday = recur.parts.BYDAY;
  if (Array.isArray(byday) && byday.length > 0) rule.byday = byday.map(String);
  const bymonthday = recur.parts.BYMONTHDAY;
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
 * `ICAL.Time#toJSDate()` routes DATE-only (all-day) *and* floating (no `Z`, no `TZID`)
 * values through the JS `Date` constructor's *local* fields, so serialising the result
 * shifts by the host machine's UTC offset -- the same value parses to a different instant
 * on different machines. Neither case carries a real timezone to interpret against: a
 * DATE value has none by definition, and a floating DATE-TIME has none because the
 * calendar author omitted TZID/Z. We have no user-configured timezone to fall back to,
 * so both are deliberately read as **UTC wall-clock** -- a deterministic reading beats a
 * host-dependent one. Do not "fix" this by routing floating values through host-local
 * time; that reintroduces exactly the bug this function exists to avoid.
 */
function toIsoString(time: ICAL.Time): string {
  if (time.isDate || time.zone === ICAL.Timezone.localTimezone) {
    const year = String(time.year).padStart(4, '0');
    const month = String(time.month).padStart(2, '0');
    const day = String(time.day).padStart(2, '0');
    if (time.isDate) return `${year}-${month}-${day}T00:00:00.000Z`;
    const hour = String(time.hour).padStart(2, '0');
    const minute = String(time.minute).padStart(2, '0');
    const second = String(time.second).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
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

  // The comparison instant for range clipping must be derived the same way as the
  // emitted `start` (via toIsoString), not via the raw `toJSDate()`: for an all-day or
  // floating occurrence those two disagree by up to the host's UTC offset, so an
  // occurrence could be included/excluded on one machine and not another while its
  // reported `start` stayed the same.
  const rangeStart = options.rangeStart ?? new Date(toIsoString(event.startDate));
  const rangeEnd = options.rangeEnd;
  // NOTE: Event#iterator(startTime) treats startTime as an override of DTSTART for the
  // RecurExpansion, not a "resume after" cursor -- passing rangeStart here silently
  // recomputes the recurrence from midnight UTC on that date, discarding the original
  // wall-clock time and weekday. Always expand from the true startDate and filter below.
  const iterator = event.iterator();

  const occurrences: CalendarEvent[] = [];
  let next = iterator.next();
  let iterations = 0;
  while (next && occurrences.length < MAX_OCCURRENCES && iterations < MAX_ITERATIONS) {
    iterations += 1;
    const startsAt = new Date(toIsoString(next));
    if (rangeEnd && startsAt >= rangeEnd) break;

    if (startsAt >= rangeStart) {
      const details = event.getOccurrenceDetails(next);
      // A RECURRENCE-ID override supplies its own VEVENT with its own title, location,
      // description, url, alarms and attendees -- only the master's occurrence should
      // fall back to the series template. `event_id`/`series_id` stay pinned to the
      // master's regardless, so every occurrence of one series still shares one id.
      const isOverride = details.item.component !== master;
      const fields = isOverride ? baseEvent(details.item.component, ref) : template;
      occurrences.push({
        ...fields,
        event_id: template.event_id,
        series_id: template.series_id,
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

export function readEventMeta(icsText: string): { uid: string; sequence: number } {
  const root = parseRoot(icsText);
  const vevent = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
  if (!vevent) {
    throw new AppError('UPSTREAM_ERROR', '日历数据中没有可识别的事件');
  }
  const uid = vevent.getFirstPropertyValue('uid');
  const sequence = vevent.getFirstPropertyValue('sequence');
  return {
    uid: String(uid ?? ''),
    sequence: Number(sequence ?? 0),
  };
}
