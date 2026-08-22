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

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 校验 tzid 是否是 Intl 认得的 IANA 时区名；不是则抛出可读错误而不是静默给出错误瞬间。 */
function assertIanaZone(tzid: string): void {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', `无法识别的时区：${tzid}`, {
      hint: '该事件引用的 TZID 既没有随附 VTIMEZONE 定义，也不是可识别的 IANA 时区名，无法确定准确时刻',
      cause,
    });
  }
}

/** 给定一个 UTC 瞬间，返回它在 tzid 时区下的挂钟字段。tzid 必须先通过 assertIanaZone 校验。 */
function wallClockInZone(date: Date, tzid: string): WallClockParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * 挂钟时刻（在 tzid 时区下）→ UTC 毫秒。两次迭代足以收敛，即使挂钟时刻落在 DST 切换附近：
 * 第一轮用挂钟数字本身当作粗略的 UTC 猜测，第二轮按猜测瞬间对应的时区偏移修正。
 */
function wallClockToUtcMillis(wall: WallClockParts, tzid: string): number {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const formatted = wallClockInZone(new Date(guess), tzid);
    const formattedAsUtc = Date.UTC(
      formatted.year,
      formatted.month - 1,
      formatted.day,
      formatted.hour,
      formatted.minute,
      formatted.second,
    );
    guess -= formattedAsUtc - target;
  }
  return guess;
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
 *
 * A third case looks identical to "genuinely floating" but isn't: a `DTSTART;TZID=X:...`
 * whose X has no matching VTIMEZONE in this object also resolves to `localTimezone` (see
 * `registerTimezones`), yet it very much has a stated timezone -- reading it as UTC
 * wall-clock would be confidently wrong (and internally contradictory with the `timezone`
 * field we also report). `tzid` is the *raw* TZID string read off the property
 * (independent of whether ical.js managed to resolve it); when present in this branch, it
 * means resolution failed, so we resolve the IANA definition ourselves instead of
 * defaulting to the floating reading.
 */
function toIsoString(time: ICAL.Time, tzid?: string): string {
  if (time.isDate) {
    const year = String(time.year).padStart(4, '0');
    const month = String(time.month).padStart(2, '0');
    const day = String(time.day).padStart(2, '0');
    return `${year}-${month}-${day}T00:00:00.000Z`;
  }
  if (time.zone !== ICAL.Timezone.localTimezone) {
    return time.toJSDate().toISOString();
  }
  if (tzid) {
    assertIanaZone(tzid);
    const millis = wallClockToUtcMillis(
      { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second },
      tzid,
    );
    return new Date(millis).toISOString();
  }
  const year = String(time.year).padStart(4, '0');
  const month = String(time.month).padStart(2, '0');
  const day = String(time.day).padStart(2, '0');
  const hour = String(time.hour).padStart(2, '0');
  const minute = String(time.minute).padStart(2, '0');
  const second = String(time.second).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
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
  const masterTzid = timezoneOf(master);

  if (!options.expandRecurring || !event.isRecurring()) {
    return [
      {
        ...template,
        start: toIsoString(event.startDate, masterTzid),
        end: toIsoString(event.endDate, masterTzid),
      },
    ];
  }

  // The comparison instant for range clipping must be derived the same way as the
  // emitted `start` (via toIsoString), not via the raw `toJSDate()`: for an all-day or
  // floating occurrence those two disagree by up to the host's UTC offset, so an
  // occurrence could be included/excluded on one machine and not another while its
  // reported `start` stayed the same.
  const rangeStart = options.rangeStart ?? new Date(toIsoString(event.startDate, masterTzid));
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
    // `next` is always driven by the master's own recurrence pattern (RFC 5545: RRULE/
    // EXDATE/RDATE share DTSTART's zone), regardless of whether this particular instant
    // ends up relating to an override -- so it's always read in the master's tzid.
    const startsAt = new Date(toIsoString(next, masterTzid));
    // Termination stays driven by the occurrence's *start* passing rangeEnd: expansion
    // walks forward chronologically by start time, so once a start is past rangeEnd no
    // later occurrence (whose start is even later) could still overlap the window.
    if (rangeEnd && startsAt >= rangeEnd) break;

    const details = event.getOccurrenceDetails(next);
    // A RECURRENCE-ID override supplies its own VEVENT with its own title, location,
    // description, url, alarms and attendees -- only the master's occurrence should
    // fall back to the series template. `event_id`/`series_id` stay pinned to the
    // master's regardless, so every occurrence of one series still shares one id.
    const isOverride = details.item.component !== master;
    // An override's own DTSTART/DTEND may carry a different (or no) TZID than the
    // master's, so its start/end must be read in *its own* tzid, not the master's.
    const occurrenceTzid = isOverride ? timezoneOf(details.item.component) : masterTzid;
    const endsAt = new Date(toIsoString(details.endDate, occurrenceTzid));
    // Inclusion is overlap-based (RFC 4791 time-range semantics), not start-only: an
    // occurrence belongs in the result when its end is after rangeStart AND its start is
    // before rangeEnd (already guaranteed by the break above). A start-only test would
    // wrongly exclude an occurrence that begins before the window but runs into it (an
    // overnight/multi-day occurrence) -- exactly the class of object the CalDAV server's
    // own overlap-based time-range query would have returned to us.
    if (endsAt > rangeStart) {
      const fields = isOverride ? baseEvent(details.item.component, ref) : template;
      occurrences.push({
        ...fields,
        event_id: template.event_id,
        series_id: template.series_id,
        // RECURRENCE-ID is anchored to the master's DTSTART zone by definition (RFC 5545
        // §3.8.4.4), regardless of which zone the override's own DTSTART now uses.
        recurrence_id: toIsoString(details.recurrenceId, masterTzid),
        start: toIsoString(details.startDate, occurrenceTzid),
        end: toIsoString(details.endDate, occurrenceTzid),
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

interface ApplyPatchOptions {
  /**
   * Whether patch.recurrence may write RRULE onto this component. Overrides
   * (VEVENTs carrying RECURRENCE-ID) must never carry their own RRULE, so
   * `upsertOverride` always passes `false` here regardless of what its caller's
   * patch happens to contain -- the caller may innocently be forwarding the
   * series' own recurrence rule as part of a "full desired state" input.
   */
  allowRecurrence?: boolean;
}

/**
 * 把 patch 中给出的字段原地写入一个 VEVENT 组件，未给出的字段保持不动。
 * 这是 applyEventPatch（整条序列）与 upsertOverride（单次覆盖）共用的唯一
 * 实现——两处都必须保留调用方数据模型未覆盖的属性（ATTENDEE、ORGANIZER、
 * CATEGORIES、STATUS、X-APPLE-* 等），按模型重建会把它们静默删掉，而这是
 * 写在用户真实日历上的。不在此处处理 SEQUENCE / DTSTAMP，那由调用方按各自
 * 的语义（整条序列递增 vs. 新建覆盖重置为 0）决定。
 */
function applyPatchToVevent(
  vevent: ICAL.Component,
  patch: Partial<EventInput>,
  options: ApplyPatchOptions = {},
): void {
  const allowRecurrence = options.allowRecurrence ?? true;
  const allDay =
    patch.all_day ??
    (vevent.getFirstProperty('dtstart')?.getFirstValue() as ICAL.Time | undefined)?.isDate === true;

  const setValue = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    vevent.removeAllProperties(name);
    vevent.addPropertyWithValue(name, value);
  };

  setValue('summary', patch.title);
  setValue('location', patch.location);
  setValue('description', patch.description);
  setValue('url', patch.url);

  if (patch.start !== undefined) {
    vevent.removeAllProperties('dtstart');
    vevent.addPropertyWithValue('dtstart', toIcalTime(patch.start, allDay));
  }
  if (patch.end !== undefined) {
    vevent.removeAllProperties('dtend');
    vevent.addPropertyWithValue('dtend', toIcalTime(patch.end, allDay));
  }
  if (allowRecurrence && patch.recurrence !== undefined) {
    vevent.removeAllProperties('rrule');
    vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(recurrenceToString(patch.recurrence)));
  }
  if (patch.alarms !== undefined) {
    for (const existing of vevent.getAllSubcomponents('valarm')) {
      vevent.removeSubcomponent(existing);
    }
    for (const alarm of patch.alarms) {
      const valarm = new ICAL.Component(['valarm', [], []]);
      valarm.addPropertyWithValue('action', alarm.action === 'email' ? 'EMAIL' : 'DISPLAY');
      valarm.addPropertyWithValue('description', patch.title ?? String(vevent.getFirstPropertyValue('summary') ?? ''));
      valarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Math.abs(alarm.minutes_before) * 60));
      vevent.addSubcomponent(valarm);
    }
  }
}

function refreshDtstamp(vevent: ICAL.Component): void {
  vevent.removeAllProperties('dtstamp');
  vevent.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
}

/** 序列的整体补丁语义：SEQUENCE 递增。 */
function bumpSequence(vevent: ICAL.Component): void {
  const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
  vevent.removeAllProperties('sequence');
  vevent.addPropertyWithValue('sequence', String(sequence + 1));
}

/** 新建覆盖事件的语义：SEQUENCE 从 0 起算。 */
function resetSequence(vevent: ICAL.Component): void {
  vevent.removeAllProperties('sequence');
  vevent.addPropertyWithValue('sequence', '0');
}

/**
 * 在既有 VEVENT 上原地施加补丁，只改动 patch 指定的属性。
 * 与 buildCalendarObject 的区别是刻意的：更新既有事件时，任何我们的数据模型
 * 未覆盖的属性（ATTENDEE、ORGANIZER、CATEGORIES、STATUS、X-APPLE-* 等）
 * 都必须原样保留——按模型重建会把它们静默删掉，而这是写在用户真实日历上的。
 */
export function applyEventPatch(icsText: string, patch: Partial<EventInput>): string {
  const root = parseRoot(icsText);
  registerTimezones(root);

  const vevent = root
    .getAllSubcomponents('vevent')
    .find((c) => !c.hasProperty('recurrence-id'));
  if (!vevent) {
    throw new AppError('UPSTREAM_ERROR', '日历数据中没有可识别的事件');
  }

  applyPatchToVevent(vevent, patch);
  bumpSequence(vevent);
  refreshDtstamp(vevent);

  return root.toString();
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

function findMaster(root: ICAL.Component): ICAL.Component {
  const master = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
  if (!master) throw new AppError('UPSTREAM_ERROR', '日历数据中没有可识别的重复事件');
  return master;
}

// `.toJSDate()` alone is wrong for a DATE-valued or unresolved-TZID `a` (see the big
// comment on `toIsoString`) -- routing through the same function `addExdate`/
// `upsertOverride` use to *emit* instants keeps "is this the same occurrence" consistent
// with "what does this occurrence's start actually read as" for every value type.
function sameInstant(a: ICAL.Time, isoTime: string): boolean {
  return toIsoString(a) === new Date(isoTime).toISOString();
}

interface AnchoredTime {
  time: ICAL.Time;
  /** Set only when the value must carry an explicit TZID parameter when written out. */
  tzid?: string;
}

/**
 * RFC 5545 §3.8.4.4: RECURRENCE-ID (and by the same logic, EXDATE) must match the
 * value type of the series' own DTSTART -- an all-day (VALUE=DATE) master needs a
 * VALUE=DATE exclusion/override marker, a TZID'd master needs the same TZID. Get this
 * wrong and ical.js (and any other RFC-conformant client) never relates the marker to
 * the recurrence pattern at all: `relateException`/`getOccurrenceDetails` match by
 * comparing the value's own representation, not just its absolute instant.
 */
function anchorToMaster(master: ICAL.Component, isoTime: string): AnchoredTime {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    throw new AppError('INVALID_INPUT', `时间格式不正确：${isoTime}`, {
      hint: '请使用 ISO 8601 格式，例如 2026-09-10T14:00:00+08:00',
    });
  }

  const dtstartValue = master.getFirstProperty('dtstart')?.getFirstValue() as ICAL.Time | undefined;
  if (dtstartValue?.isDate) {
    const utc = ICAL.Time.fromJSDate(date, true);
    return { time: ICAL.Time.fromData({ year: utc.year, month: utc.month, day: utc.day, isDate: true }) };
  }

  const tzid = timezoneOf(master);
  if (!tzid) {
    return { time: ICAL.Time.fromJSDate(date, true) };
  }

  const zone = ICAL.TimezoneService.get(tzid);
  if (zone) {
    return { time: ICAL.Time.fromJSDate(date, true).convertToZone(zone), tzid };
  }
  // No VTIMEZONE registered for this TZID -- fall back to its IANA definition, same as
  // the read path in `toIsoString` (throws if `tzid` isn't a recognisable IANA zone).
  assertIanaZone(tzid);
  return { time: ICAL.Time.fromData(wallClockInZone(date, tzid)), tzid };
}

/** `addPropertyWithValue` does not itself add a TZID parameter from `time.zone`. */
function addAnchoredProperty(component: ICAL.Component, name: string, anchored: AnchoredTime): void {
  const property = component.addPropertyWithValue(name, anchored.time);
  if (anchored.tzid) property.setParameter('tzid', anchored.tzid);
}

/** 从重复序列中排除单次发生；若该次发生已有覆盖组件（RECURRENCE-ID），一并移除，
 *  否则客户端各自独立渲染覆盖组件时，"已删除"的那次发生仍会出现（见 I2）。 */
export function addExdate(icsText: string, recurrenceId: string): string {
  const root = parseRoot(icsText);
  registerTimezones(root);
  const master = findMaster(root);

  const already = master
    .getAllProperties('exdate')
    .some((p) => sameInstant(p.getFirstValue() as ICAL.Time, recurrenceId));

  const orphan = findOverride(root, recurrenceId);
  if (orphan) root.removeSubcomponent(orphan);

  if (!already) {
    addAnchoredProperty(master, 'exdate', anchorToMaster(master, recurrenceId));
  }

  return root.toString();
}

function findOverride(root: ICAL.Component, recurrenceId: string): ICAL.Component | undefined {
  return root.getAllSubcomponents('vevent').find((candidate) => {
    const rid = candidate.getFirstPropertyValue('recurrence-id');
    return rid !== null && sameInstant(rid as ICAL.Time, recurrenceId);
  });
}

/**
 * 新增或替换某次发生的覆盖事件（RECURRENCE-ID）。
 *
 * 已存在覆盖事件时，原地对它施加补丁（与 applyEventPatch 相同做法），而不是
 * 删除重建——否则该覆盖事件自身携带的、我们数据模型未覆盖的属性会被静默丢弃。
 *
 * 新建覆盖事件时，通过 jCal 序列化往返克隆 master VEVENT 而非逐字段手工拷贝
 * ——手工拷贝正是属性被遗漏的方式——这样 ATTENDEE / ORGANIZER / CATEGORIES 等
 * 才能完整地带到覆盖事件上（这仍然是同一次会议、同样的与会人）。克隆后必须
 * 去掉 RRULE / EXDATE / RDATE：覆盖事件本身不能再定义或参与重复规则，留着
 * 会产生一个非法的 iCal 对象。
 */
export function upsertOverride(icsText: string, recurrenceId: string, input: EventInput): string {
  const root = parseRoot(icsText);
  registerTimezones(root);
  const master = findMaster(root);

  const existingOverride = findOverride(root, recurrenceId);
  if (existingOverride) {
    applyPatchToVevent(existingOverride, input, { allowRecurrence: false });
    bumpSequence(existingOverride);
    refreshDtstamp(existingOverride);
    return root.toString();
  }

  const override = new ICAL.Component(JSON.parse(JSON.stringify(master.jCal)) as unknown[]);
  override.removeAllProperties('rrule');
  override.removeAllProperties('exdate');
  override.removeAllProperties('rdate');
  addAnchoredProperty(override, 'recurrence-id', anchorToMaster(master, recurrenceId));
  resetSequence(override);
  refreshDtstamp(override);
  applyPatchToVevent(override, input, { allowRecurrence: false });

  root.addSubcomponent(override);
  return root.toString();
}
