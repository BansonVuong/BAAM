// relayer/schedule.ts
//
// Pure schedule math for recurring ("check-in") witness bets: IANA-timezone wall
// clock conversion, occurrence windows, schedule validation, check-in review
// thresholds and the doer-wins / doer-loses decision. No I/O, so it is exercised
// by a plain script (see relayer/schedule.check.ts).
//
// Timezone model: every occurrence is a calendar date (YYYY-MM-DD) in the bet's
// timezone plus a wall-clock window [windowStart, windowEnd) on that date
// (default the whole day, 00:00–24:00). Windows are converted to absolute UTC
// instants once, so DST changes simply make a day's window 23h/25h long. A wall
// time inside a DST gap (e.g. 02:30 on spring-forward day) maps to the instant
// just after the gap (the same rule as Temporal's "compatible" disambiguation);
// an ambiguous wall time (fall-back) maps to its first (earlier) instant.

export interface BetSchedule {
  /** Days of the week the habit happens on, 0 = Sunday … 6 = Saturday. */
  daysOfWeek: number[];
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** First calendar date (inclusive) in `timezone`, "YYYY-MM-DD". */
  startDate: string;
  /** Last calendar date (inclusive) in `timezone`, "YYYY-MM-DD". */
  endDate: string;
  /** Daily window start "HH:MM" (default "00:00"). */
  windowStart?: string;
  /** Daily window end "HH:MM", exclusive; "24:00" = midnight (default). */
  windowEnd?: string;
}

export type CheckinDoer = "challenger" | "acceptor";

export interface Occurrence {
  /** Calendar date of the occurrence in the bet's timezone ("YYYY-MM-DD"); unique per bet. */
  key: string;
  /** 0-based position in the schedule. */
  index: number;
  /** Window start, unix ms (inclusive). */
  start: number;
  /** Window end, unix ms (exclusive). */
  end: number;
}

export const SCHEDULE_LIMITS = {
  /** Max calendar span from startDate to endDate, inclusive. */
  maxSpanDays: 90,
  /** Max days ahead of today (in the bet's timezone) that a schedule may start. */
  maxStartLeadDays: 60,
  /** Time after the last occurrence window for witnesses to finish reviewing. */
  verdictGraceMs: 48 * 60 * 60 * 1000,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── timezone primitives ─────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface WallParts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

function wallParts(utcMs: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute"), ss: get("second") };
}

/** UTC offset (ms, local − UTC) of `timeZone` at instant `utcMs`. */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const p = wallParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Absolute instant for a wall-clock time in `timeZone`. `minutes` may be 1440
 * (= next day 00:00). DST gap → just after the gap; DST overlap → earlier instant.
 */
export function zonedWallTimeToUtc(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const before = tzOffsetMs(guess - DAY_MS, timeZone);
  const after = tzOffsetMs(guess + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => guess - offset)
    .filter((t) => guess - tzOffsetMs(t, timeZone) === t)
    .sort((a, b) => a - b);
  return valid.length ? valid[0] : guess - before;
}

/** Calendar date ("YYYY-MM-DD") of instant `utcMs` in `timeZone`. */
export function localDateKey(utcMs: number, timeZone: string): string {
  const p = wallParts(utcMs, timeZone);
  return formatDateKey(p.y, p.m, p.d);
}

// ── parsing helpers ─────────────────────────────────────────────────────────────

function formatDateKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Parse a real calendar date "YYYY-MM-DD"; null when malformed or impossible (e.g. 02-30). */
export function parseDateKey(value: unknown): { y: number; m: number; d: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Minutes since midnight for "HH:MM" (00:00–23:59, plus "24:00" when allowed). */
export function parseClock(value: unknown, allowMidnightEnd = false): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (allowMidnightEnd && hh === 24 && mm === 0) return 1440;
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

function dayNumber(key: { y: number; m: number; d: number }): number {
  return Math.round(Date.UTC(key.y, key.m - 1, key.d) / DAY_MS);
}

// ── occurrences ─────────────────────────────────────────────────────────────────

/** All occurrence windows of a (previously validated) schedule, in order. */
export function scheduleOccurrences(schedule: BetSchedule): Occurrence[] {
  const start = parseDateKey(schedule.startDate);
  const end = parseDateKey(schedule.endDate);
  const winStart = parseClock(schedule.windowStart ?? "00:00");
  const winEnd = parseClock(schedule.windowEnd ?? "24:00", true);
  if (!start || !end || winStart === null || winEnd === null) return [];
  const days = new Set(schedule.daysOfWeek);
  const out: Occurrence[] = [];
  const first = dayNumber(start);
  const last = dayNumber(end);
  for (let n = first; n <= last && n - first < SCHEDULE_LIMITS.maxSpanDays + 1; n += 1) {
    const date = new Date(n * DAY_MS);
    if (!days.has(date.getUTCDay())) continue;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    out.push({
      key: formatDateKey(y, m, d),
      index: out.length,
      start: zonedWallTimeToUtc(y, m, d, winStart, schedule.timezone),
      end: zonedWallTimeToUtc(y, m, d, winEnd, schedule.timezone),
    });
  }
  return out;
}

/** The occurrence whose window contains `nowMs`, if any. */
export function currentOccurrence(occurrences: Occurrence[], nowMs: number): Occurrence | null {
  return occurrences.find((o) => o.start <= nowMs && nowMs < o.end) ?? null;
}

/** The next occurrence whose window has not started yet, if any. */
export function nextOccurrence(occurrences: Occurrence[], nowMs: number): Occurrence | null {
  return occurrences.find((o) => o.start > nowMs) ?? null;
}

/** Verdict deadline (resolve-by date): end of the last window + the review grace. */
export function verdictDeadline(occurrences: Occurrence[]): number | null {
  const last = occurrences[occurrences.length - 1];
  return last ? last.end + SCHEDULE_LIMITS.verdictGraceMs : null;
}

// ── validation ──────────────────────────────────────────────────────────────────

export interface ValidatedSchedule {
  schedule: BetSchedule;
  occurrences: Occurrence[];
  requiredCheckins: number;
  doer: CheckinDoer;
  /** resolveByDate for the bet (overrides any client value). */
  resolveByDate: number;
  /** Latest allowed accept-by date: the end of the first occurrence window. */
  latestAcceptBy: number;
}

/**
 * Validate the schedule fields of a POST /bets body. Returns null when no
 * schedule was supplied (a plain witness bet).
 */
export function validateScheduleInput(
  input: { schedule?: unknown; requiredCheckins?: unknown; doer?: unknown },
  nowMs: number,
): ValidatedSchedule | { error: string } | null {
  if (input.schedule === undefined || input.schedule === null) return null;
  const raw = input.schedule as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "schedule must be an object" };

  if (!isValidTimeZone(raw.timezone)) return { error: "schedule.timezone must be a valid IANA timezone (e.g. America/New_York)" };
  const timezone = raw.timezone;

  if (!Array.isArray(raw.daysOfWeek) || raw.daysOfWeek.length === 0) {
    return { error: "schedule.daysOfWeek must list 1–7 days (0 = Sunday … 6 = Saturday)" };
  }
  const days = raw.daysOfWeek;
  if (!days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
    return { error: "schedule.daysOfWeek entries must be integers 0–6 (0 = Sunday)" };
  }
  const daysOfWeek = [...new Set(days as number[])].sort((a, b) => a - b);
  if (daysOfWeek.length !== days.length) return { error: "schedule.daysOfWeek must not repeat a day" };

  const start = parseDateKey(raw.startDate);
  const end = parseDateKey(raw.endDate);
  if (!start || !end) return { error: "schedule.startDate and schedule.endDate must be YYYY-MM-DD dates" };
  const span = dayNumber(end) - dayNumber(start) + 1;
  if (span < 1) return { error: "schedule.endDate must be on or after schedule.startDate" };
  if (span > SCHEDULE_LIMITS.maxSpanDays) {
    return { error: `schedules can span at most ${SCHEDULE_LIMITS.maxSpanDays} days` };
  }
  const today = parseDateKey(localDateKey(nowMs, timezone))!;
  if (dayNumber(start) - dayNumber(today) > SCHEDULE_LIMITS.maxStartLeadDays) {
    return { error: `schedules must start within ${SCHEDULE_LIMITS.maxStartLeadDays} days` };
  }

  const windowStart = raw.windowStart === undefined ? undefined : raw.windowStart;
  const windowEnd = raw.windowEnd === undefined ? undefined : raw.windowEnd;
  const winStart = parseClock(windowStart ?? "00:00");
  const winEnd = parseClock(windowEnd ?? "24:00", true);
  if (winStart === null) return { error: "schedule.windowStart must be HH:MM (00:00–23:59)" };
  if (winEnd === null) return { error: "schedule.windowEnd must be HH:MM (00:01–24:00)" };
  if (winEnd <= winStart) return { error: "schedule.windowEnd must be after schedule.windowStart (same day)" };

  const schedule: BetSchedule = {
    daysOfWeek,
    timezone,
    startDate: raw.startDate as string,
    endDate: raw.endDate as string,
    ...(windowStart !== undefined ? { windowStart: windowStart as string } : {}),
    ...(windowEnd !== undefined ? { windowEnd: windowEnd as string } : {}),
  };
  const occurrences = scheduleOccurrences(schedule);
  if (occurrences.length === 0) return { error: "schedule has no occurrences (no listed weekday falls in the date range)" };
  if (occurrences[0].end <= nowMs) {
    return { error: "the schedule's first check-in window has already ended; start it later" };
  }

  let requiredCheckins = occurrences.length;
  if (input.requiredCheckins !== undefined && input.requiredCheckins !== null) {
    const n = input.requiredCheckins;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > occurrences.length) {
      return { error: `requiredCheckins must be an integer from 1 to ${occurrences.length} (the number of occurrences)` };
    }
    requiredCheckins = n as number;
  }

  let doer: CheckinDoer = "challenger";
  if (input.doer !== undefined && input.doer !== null) {
    if (input.doer !== "challenger" && input.doer !== "acceptor") return { error: "doer must be challenger or acceptor" };
    doer = input.doer;
  }

  return {
    schedule,
    occurrences,
    requiredCheckins,
    doer,
    resolveByDate: verdictDeadline(occurrences)!,
    latestAcceptBy: occurrences[0].end,
  };
}

// ── check-in reviews + outcome ──────────────────────────────────────────────────

export type CheckinStatus = "pending" | "approved" | "rejected";

export interface CheckinReview { reviewer: string; approve: boolean; at: number }

/** First side to reach `threshold` decides a check-in; otherwise it stays pending. */
export function decideCheckinStatus(reviews: CheckinReview[], threshold: number): CheckinStatus {
  const need = Math.max(1, Math.floor(threshold) || 1);
  let approvals = 0;
  let rejections = 0;
  for (const review of [...reviews].sort((a, b) => a.at - b.at)) {
    if (review.approve) approvals += 1;
    else rejections += 1;
    if (approvals >= need) return "approved";
    if (rejections >= need) return "rejected";
  }
  return "pending";
}

export interface CheckinForEvaluation {
  id?: string;
  occurrenceKey: string;
  status: CheckinStatus;
  reviews: CheckinReview[];
}

export type OccurrenceState =
  /** Window not open yet. */
  | "upcoming"
  /** Window open now, no check-in yet. */
  | "open"
  /** Checked in; witnesses still reviewing. */
  | "submitted"
  | "approved"
  | "rejected"
  /** Window closed with no check-in. */
  | "missed"
  /** Verdict deadline passed with ≥1 approval and no rejections: counted as approved. */
  | "approved-by-default"
  /** Verdict deadline passed with mixed reviews: not counted. */
  | "lapsed"
  /** Verdict deadline passed with zero reviews: witnesses never looked at it. */
  | "unreviewed";

export interface OccurrenceView extends Occurrence {
  state: OccurrenceState;
  checkinId?: string;
}

export type CheckinDecision =
  | { winner: "doer"; reason: string }
  | { winner: "other"; reason: string }
  | { winner: null; reason: "in-progress" | "witnesses-silent" };

export interface CheckinEvaluation {
  occurrences: OccurrenceView[];
  required: number;
  total: number;
  /** Occurrences counted as approved (incl. approved-by-default after the deadline). */
  approved: number;
  /** Max approvals still achievable (= approved once nothing is open/pending). */
  possible: number;
  decision: CheckinDecision;
}

const COUNTED: ReadonlySet<OccurrenceState> = new Set(["approved", "approved-by-default"]);
const STILL_POSSIBLE: ReadonlySet<OccurrenceState> = new Set(["upcoming", "open", "submitted"]);

/**
 * Decide a check-in bet at `nowMs`.
 *  - Doer wins as soon as `required` occurrences are approved.
 *  - Other side wins as soon as that becomes impossible (rejections + missed windows).
 *  - At the verdict deadline, an unreviewed check-in counts as approved iff it has
 *    ≥1 approval and no rejections; mixed reviews don't count. If the doer would
 *    only lose because witnesses never reviewed some check-ins at all, nothing is
 *    decided ("witnesses-silent") and the bet's precommitted fallback applies.
 */
export function evaluateCheckins(
  occurrences: Occurrence[],
  checkins: CheckinForEvaluation[],
  required: number,
  deadlineMs: number,
  nowMs: number,
): CheckinEvaluation {
  const byKey = new Map(checkins.map((c) => [c.occurrenceKey, c]));
  const pastDeadline = nowMs >= deadlineMs;
  const views: OccurrenceView[] = occurrences.map((occ) => {
    const checkin = byKey.get(occ.key);
    let state: OccurrenceState;
    if (checkin) {
      if (checkin.status === "approved") state = "approved";
      else if (checkin.status === "rejected") state = "rejected";
      else if (!pastDeadline) state = "submitted";
      else {
        const approvals = checkin.reviews.filter((r) => r.approve).length;
        const rejections = checkin.reviews.length - approvals;
        state = approvals >= 1 && rejections === 0
          ? "approved-by-default"
          : checkin.reviews.length === 0 ? "unreviewed" : "lapsed";
      }
    } else if (nowMs >= occ.end) state = "missed";
    else if (nowMs >= occ.start) state = "open";
    else state = "upcoming";
    return { ...occ, state, ...(checkin?.id ? { checkinId: checkin.id } : {}) };
  });

  const need = Math.min(Math.max(1, Math.floor(required) || 1), Math.max(1, occurrences.length));
  const approved = views.filter((v) => COUNTED.has(v.state)).length;
  const possible = approved + views.filter((v) => STILL_POSSIBLE.has(v.state)).length;
  const silent = views.filter((v) => v.state === "unreviewed").length;

  let decision: CheckinDecision;
  if (approved >= need) {
    decision = { winner: "doer", reason: `${approved}/${need} required check-ins approved` };
  } else if (possible >= need) {
    decision = { winner: null, reason: "in-progress" };
  } else if (silent > 0 && approved + silent >= need) {
    decision = { winner: null, reason: "witnesses-silent" };
  } else {
    decision = {
      winner: "other",
      reason: `only ${possible} of the ${need} required check-ins can still be approved`,
    };
  }
  return { occurrences: views, required: need, total: occurrences.length, approved, possible, decision };
}
