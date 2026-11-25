/**
 * Recurring check-in bets on the client: plain-word schedule text and the same
 * validation limits the relayer enforces (relayer/schedule.ts), so people see
 * problems before posting. Days: 0 = Sunday … 6 = Saturday.
 */
import type { BetSchedule, CheckinOccurrenceState, CheckinProgress } from "./relayer";

export const SCHEDULE_LIMITS = { maxSpanDays: 90, maxStartLeadDays: 60 } as const;

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** Picker order: the week starts on Monday. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── dates ────────────────────────────────────────────────────────────────────

export function parseDateKey(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

function dayNumber(key: { y: number; m: number; d: number }): number {
  return Math.round(Date.UTC(key.y, key.m - 1, key.d) / DAY_MS);
}

function keyFromDayNumber(n: number): string {
  const date = new Date(n * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addDaysToKey(key: string, days: number): string {
  const parsed = parseDateKey(key);
  return parsed ? keyFromDayNumber(dayNumber(parsed) + days) : key;
}

/** Calendar days from start to end, inclusive (0 when invalid or reversed). */
export function spanDays(startDate: string, endDate: string): number {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  if (!start || !end) return 0;
  return Math.max(0, dayNumber(end) - dayNumber(start) + 1);
}

/** Calendar dates in range that fall on one of `daysOfWeek`. */
export function occurrenceDates(daysOfWeek: number[], startDate: string, endDate: string): string[] {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate);
  if (!start || !end) return [];
  const days = new Set(daysOfWeek);
  const out: string[] = [];
  const first = dayNumber(start);
  const last = Math.min(dayNumber(end), first + SCHEDULE_LIMITS.maxSpanDays);
  for (let n = first; n <= last; n += 1) {
    if (days.has(new Date(n * DAY_MS).getUTCDay())) out.push(keyFromDayNumber(n));
  }
  return out;
}

export function countOccurrences(daysOfWeek: number[], startDate: string, endDate: string): number {
  return occurrenceDates(daysOfWeek, startDate, endDate).length;
}

// ── timezones ────────────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function wallParts(utcMs: number, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute"), ss: get("second") };
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const p = wallParts(utcMs, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(utcMs / 1000) * 1000;
}

/** Instant for a wall-clock time in `timeZone` (same rules as the relayer). */
export function zonedWallTimeToUtc(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const before = tzOffsetMs(guess - DAY_MS, timeZone);
  const after = tzOffsetMs(guess + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => guess - offset)
    .filter((t) => guess - tzOffsetMs(t, timeZone) === t)
    .sort((a, b) => a - b);
  return valid.length ? valid[0]! : guess - before;
}

/** Today's date ("YYYY-MM-DD") in `timeZone`. */
export function todayKey(timeZone: string, nowMs = Date.now()): string {
  const p = wallParts(nowMs, isValidTimeZone(timeZone) ? timeZone : "UTC");
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "Toronto (Eastern Standard Time)". */
export function timeZoneLabel(timeZone: string, nowMs = Date.now()): string {
  const city = (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
      .formatToParts(new Date(nowMs))
      .find((part) => part.type === "timeZoneName")?.value;
    return name ? `${city} (${name})` : city;
  } catch {
    return city;
  }
}

export function allTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length) return zones;
  } catch {
    // Older browsers: fall back to a short list.
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
}

// ── clock text ───────────────────────────────────────────────────────────────

export function parseClock(value: string | undefined, allowMidnightEnd = false): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (allowMidnightEnd && hh === 24 && mm === 0) return 1440;
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** "06:00" → "6 AM", "18:30" → "6:30 PM", "24:00" → "midnight". */
export function formatClockText(value: string): string {
  const minutes = parseClock(value, true);
  if (minutes === null) return value;
  if (minutes === 0 || minutes === 1440) return "midnight";
  if (minutes === 720) return "noon";
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${hh < 12 ? "AM" : "PM"}`;
}

/** "between 6 AM and 8 AM", or null for the whole day. */
export function formatWindow(schedule: Pick<BetSchedule, "windowStart" | "windowEnd">): string | null {
  const start = schedule.windowStart ?? "00:00";
  const end = schedule.windowEnd ?? "24:00";
  if ((parseClock(start) ?? 0) === 0 && (parseClock(end, true) ?? 1440) === 1440) return null;
  return `between ${formatClockText(start)} and ${formatClockText(end)}`;
}

// ── schedule text ────────────────────────────────────────────────────────────

/** "Every day", "Weekdays", "Weekends", "Mon, Wed, Fri". */
export function formatDays(daysOfWeek: number[]): string {
  const days = [...new Set(daysOfWeek)].filter((d) => d >= 0 && d <= 6);
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  if (set.size === 1) return `${WEEKDAY_LONG[days[0]!]}s`;
  return WEEKDAY_ORDER.filter((d) => set.has(d)).map((d) => WEEKDAY_SHORT[d]).join(", ");
}

/** "3 weeks", "10 days", "1 day". */
export function formatDuration(days: number): string {
  if (days >= 7 && days % 7 === 0) {
    const weeks = days / 7;
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** "Mon, Wed, Fri for 3 weeks". */
export function formatScheduleSummary(schedule: Pick<BetSchedule, "daysOfWeek" | "startDate" | "endDate">): string {
  const span = spanDays(schedule.startDate, schedule.endDate);
  if (span <= 1) return `On ${formatDateKey(schedule.startDate)}`;
  return `${formatDays(schedule.daysOfWeek)} for ${formatDuration(span)}`;
}

/** "Dec 3" (or "Dec 3, 2027" outside the current year). */
export function formatDateKey(key: string, nowMs = Date.now()): string {
  const parsed = parseDateKey(key);
  if (!parsed) return key;
  const date = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 12));
  const sameYear = parsed.y === new Date(nowMs).getFullYear();
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Mon Dec 3". */
export function formatDateKeyWithDay(key: string): string {
  const parsed = parseDateKey(key);
  if (!parsed) return key;
  const date = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 12));
  return `${WEEKDAY_SHORT[date.getUTCDay()]} ${formatDateKey(key)}`;
}

// ── draft validation ─────────────────────────────────────────────────────────

export interface ScheduleDraft {
  daysOfWeek: number[];
  startDate: string;
  endDate: string;
  timezone: string;
  /** null = the whole day. */
  window: { start: string; end: string } | null;
  /** null = every occurrence. */
  required: number | null;
}

export interface ScheduleErrors {
  days?: string;
  startDate?: string;
  endDate?: string;
  window?: string;
  timezone?: string;
  required?: string;
}

export interface ScheduleCheck {
  errors: ScheduleErrors;
  /** M: number of scheduled check-in days. */
  total: number;
  required: number;
}

export function draftToSchedule(draft: ScheduleDraft): BetSchedule {
  return {
    daysOfWeek: [...new Set(draft.daysOfWeek)].sort((a, b) => a - b),
    timezone: draft.timezone,
    startDate: draft.startDate,
    endDate: draft.endDate,
    ...(draft.window ? { windowStart: draft.window.start, windowEnd: draft.window.end } : {}),
  };
}

/** Same limits as relayer/schedule.ts validateScheduleInput, in plain words. */
export function checkScheduleDraft(draft: ScheduleDraft, nowMs = Date.now()): ScheduleCheck {
  const errors: ScheduleErrors = {};
  const tzOk = isValidTimeZone(draft.timezone);
  if (!tzOk) errors.timezone = "Pick a timezone.";
  if (draft.daysOfWeek.length === 0) errors.days = "Pick at least one day.";

  const start = parseDateKey(draft.startDate);
  const end = parseDateKey(draft.endDate);
  if (!start) errors.startDate = "Pick a start date.";
  if (!end) errors.endDate = "Pick an end date.";
  if (start && end) {
    const span = dayNumber(end) - dayNumber(start) + 1;
    if (span < 1) errors.endDate = "End on or after the start date.";
    else if (span > SCHEDULE_LIMITS.maxSpanDays) errors.endDate = `Keep it to ${SCHEDULE_LIMITS.maxSpanDays} days or fewer.`;
    if (tzOk) {
      const today = parseDateKey(todayKey(draft.timezone, nowMs))!;
      const lead = dayNumber(start) - dayNumber(today);
      if (lead > SCHEDULE_LIMITS.maxStartLeadDays) {
        errors.startDate = `Start within the next ${SCHEDULE_LIMITS.maxStartLeadDays} days.`;
      } else if (lead < 0) {
        errors.startDate = "Start today or later.";
      }
    }
  }

  let windowStart = 0;
  let windowEnd = 1440;
  if (draft.window) {
    const s = parseClock(draft.window.start);
    const e = parseClock(draft.window.end, true);
    if (s === null || e === null) errors.window = "Pick a start and end time.";
    else if (e <= s) errors.window = "The window has to end after it starts, on the same day.";
    else { windowStart = s; windowEnd = e; }
  }

  const dates = errors.endDate || errors.startDate ? [] : occurrenceDates(draft.daysOfWeek, draft.startDate, draft.endDate);
  const total = dates.length;
  if (!errors.days && !errors.startDate && !errors.endDate && total === 0) {
    errors.days = "None of those days fall between the start and end dates.";
  }
  if (total > 0 && tzOk && !errors.window) {
    const first = parseDateKey(dates[0]!)!;
    const firstEnd = zonedWallTimeToUtc(first.y, first.m, first.d, windowEnd, draft.timezone);
    if (firstEnd <= nowMs) {
      errors.startDate = dates.length > 1 || windowStart > 0
        ? "Today's window has already closed. Start tomorrow or pick a later time."
        : "That day is already over. Start later.";
    }
  }

  let required = total;
  if (draft.required !== null) {
    required = draft.required;
    if (total > 0 && (!Number.isInteger(required) || required < 1 || required > total)) {
      errors.required = `Pick between 1 and ${total}.`;
    }
  }
  return { errors, total, required: Math.min(Math.max(1, required), Math.max(1, total)) };
}

// ── occurrence + decision text ───────────────────────────────────────────────

export type OccurrenceKind = "done" | "missed" | "review" | "today" | "upcoming";

export function occurrenceKind(state: CheckinOccurrenceState): OccurrenceKind {
  switch (state) {
    case "approved":
    case "approved-by-default":
      return "done";
    case "submitted":
      return "review";
    case "open":
      return "today";
    case "upcoming":
      return "upcoming";
    default:
      return "missed";
  }
}

export function occurrenceStateText(state: CheckinOccurrenceState): string {
  switch (state) {
    case "approved": return "Done";
    case "approved-by-default": return "Done (counted at the deadline)";
    case "submitted": return "Under review";
    case "open": return "Today, not checked in yet";
    case "upcoming": return "Upcoming";
    case "missed": return "Missed";
    case "rejected": return "Rejected by witnesses";
    case "lapsed": return "Not counted: witnesses disagreed";
    case "unreviewed": return "Not counted: never reviewed";
  }
}

/** Why a check-in bet was (or will be) decided, in plain words. */
export function checkinDecisionText(progress: CheckinProgress, doerName: string): string | null {
  const { decision, approved, required, possible } = progress;
  if (decision.winner === "doer") {
    return `${doerName} kept it up: ${approved} of the ${required} needed check-ins approved.`;
  }
  if (decision.winner === "other") {
    return `${doerName} fell short: only ${possible} of the ${required} needed check-ins could still be approved.`;
  }
  if (decision.reason === "witnesses-silent") {
    return "Witnesses never reviewed some check-ins, so the no-verdict rule applies.";
  }
  return null;
}
