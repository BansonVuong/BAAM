// Plain assertion script for relayer/schedule.ts (no test framework):
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/schedule.check.ts
import assert from "assert";

import {
  currentOccurrence,
  decideCheckinStatus,
  evaluateCheckins,
  localDateKey,
  nextOccurrence,
  parseClock,
  parseDateKey,
  scheduleOccurrences,
  SCHEDULE_LIMITS,
  tzOffsetMs,
  validateScheduleInput,
  zonedWallTimeToUtc,
  type BetSchedule,
  type CheckinForEvaluation,
} from "./schedule";

const H = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── parsing ────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseDateKey("2026-02-28"), { y: 2026, m: 2, d: 28 });
assert.strictEqual(parseDateKey("2026-02-29"), null); // not a leap year
assert.deepStrictEqual(parseDateKey("2028-02-29"), { y: 2028, m: 2, d: 29 });
assert.strictEqual(parseDateKey("2026-13-01"), null);
assert.strictEqual(parseDateKey("26-1-1"), null);
assert.strictEqual(parseClock("05:30"), 330);
assert.strictEqual(parseClock("24:00"), null);
assert.strictEqual(parseClock("24:00", true), 1440);
assert.strictEqual(parseClock("23:60"), null);
assert.strictEqual(parseClock("5:30"), null);

// ── timezone conversion incl. DST ──────────────────────────────────────────────
// New York: EST (-5) in winter, EDT (-4) in summer.
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 1, 15, 5 * 60, "America/New_York")), "2026-01-15T10:00:00.000Z");
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 7, 15, 5 * 60, "America/New_York")), "2026-07-15T09:00:00.000Z");
// Spring forward 2026-03-08 02:00 → 03:00. 02:30 doesn't exist → maps past the gap (03:30 EDT).
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 3, 8, 150, "America/New_York")), "2026-03-08T07:30:00.000Z");
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 3, 8, 0, "America/New_York")), "2026-03-08T05:00:00.000Z");
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 3, 8, 1440, "America/New_York")), "2026-03-09T04:00:00.000Z");
// Fall back 2026-11-01 02:00 → 01:00. 01:30 happens twice → earlier (EDT) instant.
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 11, 1, 90, "America/New_York")), "2026-11-01T05:30:00.000Z");
// Southern hemisphere + half-hour + positive offsets.
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 1, 15, 6 * 60, "Australia/Sydney")), "2026-01-14T19:00:00.000Z"); // AEDT +11
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 7, 15, 6 * 60, "Australia/Sydney")), "2026-07-14T20:00:00.000Z"); // AEST +10
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 5, 1, 9 * 60, "Asia/Kolkata")), "2026-05-01T03:30:00.000Z");
assert.strictEqual(iso(zonedWallTimeToUtc(2026, 5, 1, 9 * 60, "UTC")), "2026-05-01T09:00:00.000Z");
assert.strictEqual(tzOffsetMs(Date.UTC(2026, 0, 15), "America/Los_Angeles"), -8 * H);
assert.strictEqual(localDateKey(Date.UTC(2026, 0, 15, 3), "America/Los_Angeles"), "2026-01-14");
assert.strictEqual(localDateKey(Date.UTC(2026, 0, 15, 3), "Asia/Tokyo"), "2026-01-15");

// ── occurrences ────────────────────────────────────────────────────────────────
// "Every 5am lift Mon–Fri", 05:00–06:30 New York, over the spring-forward week.
const lift: BetSchedule = {
  daysOfWeek: [1, 2, 3, 4, 5],
  timezone: "America/New_York",
  startDate: "2026-03-05", // Thu
  endDate: "2026-03-11", // Wed
  windowStart: "05:00",
  windowEnd: "06:30",
};
const liftOcc = scheduleOccurrences(lift);
assert.deepStrictEqual(liftOcc.map((o) => o.key), ["2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11"]);
assert.deepStrictEqual(liftOcc.map((o) => o.index), [0, 1, 2, 3, 4]);
assert.strictEqual(iso(liftOcc[0].start), "2026-03-05T10:00:00.000Z"); // EST
assert.strictEqual(iso(liftOcc[2].start), "2026-03-09T09:00:00.000Z"); // EDT after the switch
assert.ok(liftOcc.every((o) => o.end - o.start === 1.5 * H));
// Whole-day windows are 23h on spring-forward day, 25h on fall-back day.
const allDay = (startDate: string, endDate: string): BetSchedule => ({
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: "America/New_York", startDate, endDate,
});
assert.strictEqual(scheduleOccurrences(allDay("2026-03-08", "2026-03-08"))[0].end - scheduleOccurrences(allDay("2026-03-08", "2026-03-08"))[0].start, 23 * H);
const fallDay = scheduleOccurrences(allDay("2026-11-01", "2026-11-01"))[0];
assert.strictEqual(fallDay.end - fallDay.start, 25 * H);
// Consecutive whole days tile with no gaps/overlaps across DST.
const tiles = scheduleOccurrences(allDay("2026-10-30", "2026-11-03"));
for (let i = 1; i < tiles.length; i += 1) assert.strictEqual(tiles[i].start, tiles[i - 1].end);

assert.strictEqual(currentOccurrence(liftOcc, liftOcc[1].start)?.key, "2026-03-06");
assert.strictEqual(currentOccurrence(liftOcc, liftOcc[1].end), null); // end is exclusive
assert.strictEqual(nextOccurrence(liftOcc, liftOcc[1].end)?.key, "2026-03-09");
assert.strictEqual(nextOccurrence(liftOcc, liftOcc[4].start), null);

// ── validation ─────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 2, 4, 12); // 2026-03-04 07:00 EST
const ok = validateScheduleInput({ schedule: lift }, NOW);
assert.ok(ok && !("error" in ok));
assert.strictEqual(ok.requiredCheckins, 5);
assert.strictEqual(ok.doer, "challenger");
assert.strictEqual(ok.resolveByDate, liftOcc[4].end + SCHEDULE_LIMITS.verdictGraceMs);
assert.strictEqual(ok.latestAcceptBy, liftOcc[0].end);
assert.strictEqual(validateScheduleInput({}, NOW), null);
const err = (input: Parameters<typeof validateScheduleInput>[0], now = NOW): string => {
  const r = validateScheduleInput(input, now);
  assert.ok(r && "error" in r, `expected an error for ${JSON.stringify(input)}`);
  return r.error;
};
assert.match(err({ schedule: { ...lift, timezone: "Mars/Olympus" } }), /timezone/);
assert.match(err({ schedule: { ...lift, daysOfWeek: [] } }), /daysOfWeek/);
assert.match(err({ schedule: { ...lift, daysOfWeek: [1, 1] } }), /repeat/);
assert.match(err({ schedule: { ...lift, daysOfWeek: [7] } }), /0–6/);
assert.match(err({ schedule: { ...lift, endDate: "2026-03-01" } }), /on or after/);
assert.match(err({ schedule: { ...lift, endDate: "2026-06-30" } }), /at most 90 days/);
assert.match(err({ schedule: { ...lift, startDate: "2026-06-01", endDate: "2026-06-05" } }), /within 60 days/);
assert.match(err({ schedule: { ...lift, windowStart: "07:00", windowEnd: "06:00" } }), /after/);
assert.match(err({ schedule: { ...lift, daysOfWeek: [0], startDate: "2026-03-09", endDate: "2026-03-13" } }), /no occurrences/);
assert.match(err({ schedule: lift }, liftOcc[0].end), /already ended/);
assert.match(err({ schedule: lift, requiredCheckins: 6 }), /1 to 5/);
assert.match(err({ schedule: lift, requiredCheckins: 2.5 }), /integer/);
assert.match(err({ schedule: lift, doer: "witness" }), /doer/);
const custom = validateScheduleInput({ schedule: lift, requiredCheckins: 3, doer: "acceptor" }, liftOcc[0].start + 1);
assert.ok(custom && !("error" in custom) && custom.requiredCheckins === 3 && custom.doer === "acceptor");
// Exactly 90 days is allowed; 7 days/week is allowed.
assert.ok(!("error" in (validateScheduleInput({ schedule: allDay("2026-03-05", "2026-06-02") }, NOW) ?? { error: "" })));

// ── check-in review threshold ──────────────────────────────────────────────────
const r = (reviewer: string, approve: boolean, at: number) => ({ reviewer, approve, at });
assert.strictEqual(decideCheckinStatus([], 1), "pending");
assert.strictEqual(decideCheckinStatus([r("a", true, 1)], 1), "approved");
assert.strictEqual(decideCheckinStatus([r("a", false, 1)], 1), "rejected");
assert.strictEqual(decideCheckinStatus([r("a", true, 1), r("b", false, 2)], 2), "pending");
// First side to reach the threshold wins, in review order.
assert.strictEqual(decideCheckinStatus([r("b", false, 2), r("a", false, 1), r("c", true, 3), r("d", true, 4)], 2), "rejected");
assert.strictEqual(decideCheckinStatus([r("a", true, 1), r("b", true, 2), r("c", false, 3), r("d", false, 4)], 2), "approved");

// ── outcome decisions ──────────────────────────────────────────────────────────
const deadline = ok.resolveByDate;
const ci = (key: string, status: CheckinForEvaluation["status"], reviews: CheckinForEvaluation["reviews"] = []): CheckinForEvaluation => ({
  id: `ci-${key}`, occurrenceKey: key, status, reviews,
});
const evalAt = (checkins: CheckinForEvaluation[], now: number, required = 5) =>
  evaluateCheckins(liftOcc, checkins, required, deadline, now);

// Before anything happens: in progress, all upcoming.
let e = evalAt([], NOW);
assert.deepStrictEqual(e.decision, { winner: null, reason: "in-progress" });
assert.ok(e.occurrences.every((o) => o.state === "upcoming"));
assert.strictEqual(e.possible, 5);
// Window open; then missed once it closes.
assert.strictEqual(evalAt([], liftOcc[0].start).occurrences[0].state, "open");
e = evalAt([], liftOcc[0].end);
assert.strictEqual(e.occurrences[0].state, "missed");
// Required 5/5 and one missed → impossible → other side wins immediately.
assert.strictEqual(e.decision.winner, "other");
// Required 4/5: one miss still possible.
assert.strictEqual(evalAt([], liftOcc[0].end, 4).decision.winner, null);
// Doer wins as soon as the required count is approved, even with windows left.
const approvedKeys = liftOcc.slice(0, 3).map((o) => ci(o.key, "approved"));
e = evalAt(approvedKeys, liftOcc[2].end, 3);
assert.strictEqual(e.decision.winner, "doer");
assert.strictEqual(e.approved, 3);
// Rejections count against the doer.
e = evalAt([ci(liftOcc[0].key, "rejected"), ci(liftOcc[1].key, "rejected")], liftOcc[1].end, 4);
assert.strictEqual(e.decision.winner, "other");
assert.strictEqual(e.possible, 3);
// Submitted (pending) check-ins keep the bet open before the deadline.
const allIn = liftOcc.map((o) => ci(o.key, "pending"));
e = evalAt(allIn, liftOcc[4].end + 1);
assert.deepStrictEqual(e.decision, { winner: null, reason: "in-progress" });
assert.ok(e.occurrences.every((o) => o.state === "submitted"));
// At the deadline: ≥1 approval & no rejections → counted.
const leaning = liftOcc.map((o) => ci(o.key, "pending", [r("w1", true, 1)]));
e = evalAt(leaning, deadline);
assert.ok(e.occurrences.every((o) => o.state === "approved-by-default"));
assert.strictEqual(e.decision.winner, "doer");
// Mixed reviews at the deadline → not counted → doer loses.
const mixed = liftOcc.map((o, i) => ci(o.key, "pending", i === 0 ? [r("w1", true, 1), r("w2", false, 2)] : [r("w1", true, 1)]));
e = evalAt(mixed, deadline);
assert.strictEqual(e.occurrences[0].state, "lapsed");
assert.strictEqual(e.decision.winner, "other");
// Witnesses never reviewed: the doer's loss would come purely from silence → no verdict (fallback).
e = evalAt(allIn, deadline);
assert.ok(e.occurrences.every((o) => o.state === "unreviewed"));
assert.deepStrictEqual(e.decision, { winner: null, reason: "witnesses-silent" });
// …but if the doer would lose even counting every ignored check-in, the other side wins.
e = evalAt([ci(liftOcc[0].key, "pending")], deadline, 2);
assert.strictEqual(e.decision.winner, "other");
// Required is clamped to the number of occurrences.
assert.strictEqual(evalAt([], NOW, 99).required, 5);

console.log("schedule checks passed");
