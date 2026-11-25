// Plain assertion script for relayer/stats.ts (no test framework):
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/stats.check.ts
import assert from "assert";

import type { BetDoc, CheckinDoc } from "./db";
import { betCurrency, computeUserStats, resultFor, sideOf } from "./stats";
import { scheduleOccurrences, type BetSchedule } from "./schedule";

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const bet = (extra: Partial<BetDoc>): BetDoc => {
  seq += 1;
  return {
    id: `bet-${T0 + seq * DAY}-${seq}`,
    createdAt: T0 + seq * DAY,
    type: "PERSONAL",
    challenger: "jordan",
    acceptor: "sam",
    acceptedBy: "sam",
    terms: "some witness bet",
    stake: "1",
    currency: "SOL",
    status: "COMPLETED",
    witnesses: 1,
    minBettors: 2,
    groupSize: 3,
    ...extra,
  };
};

// ── per-bet results ────────────────────────────────────────────────────────────
assert.strictEqual(sideOf(bet({}), "Jordan"), "challenger");
assert.strictEqual(sideOf(bet({}), "SAM"), "acceptor");
assert.strictEqual(sideOf(bet({}), "alex"), null);
assert.strictEqual(sideOf(bet({ acceptor: "anyone", acceptedBy: undefined }), "anyone"), null);
assert.strictEqual(resultFor(bet({ resolvedWinner: "challenger" }), "jordan"), "win");
assert.strictEqual(resultFor(bet({ resolvedWinner: "challenger" }), "sam"), "loss");
assert.strictEqual(resultFor(bet({ votesByVoter: { w: "acceptor" } }), "sam"), "win"); // legacy quorum
assert.strictEqual(resultFor(bet({ status: "ACTIVE" }), "sam"), null);
assert.strictEqual(resultFor(bet({ status: "PENDING", acceptedBy: undefined }), "jordan"), null);
assert.strictEqual(resultFor(bet({ fallbackApplied: "return", resolvedWinner: "challenger" }), "jordan"), "refund");
assert.strictEqual(resultFor(bet({ fallbackApplied: "burn" }), "jordan"), "forfeit");
assert.strictEqual(resultFor(bet({ fallbackBlocked: true }), "jordan"), null);
assert.strictEqual(resultFor(bet({ offerExpired: true }), "jordan"), null);
assert.strictEqual(resultFor(bet({ onChainState: "cancelled", acceptedBy: undefined, acceptor: "anyone" }), "jordan"), null);
assert.strictEqual(betCurrency({ currency: "PTS" }), "PTS");
assert.strictEqual(betCurrency({ currency: undefined as unknown as string }), "SOL");

// ── record, streaks, currency, head-to-head ────────────────────────────────────
seq = 0;
const history: BetDoc[] = [
  bet({ resolvedWinner: "challenger" }),                                  // W vs sam
  bet({ resolvedWinner: "challenger", stake: "2" }),                      // W vs sam
  bet({ resolvedWinner: "acceptor", acceptor: "alex", acceptedBy: "alex" }), // L vs alex
  bet({ fallbackApplied: "return" }),                                     // refund vs sam (no streak effect)
  bet({ resolvedWinner: "challenger", currency: "PTS", stake: "50" }),     // W vs sam (PTS)
  bet({ challenger: "alex", acceptor: "jordan", acceptedBy: "jordan", resolvedWinner: "acceptor", currency: "PTS", stake: "25" }), // W vs alex
  bet({ resolvedWinner: "challenger", challenger: "sam", acceptor: "alex", acceptedBy: "alex" }), // not jordan's
  bet({ status: "ACTIVE" }),                                              // active vs sam
  bet({ status: "PENDING", acceptor: "anyone", acceptedBy: undefined }),  // open offer
  bet({ offerExpired: true, status: "COMPLETED", acceptor: "riley", acceptedBy: undefined }), // ignored
];
const s = computeUserStats("jordan", history, new Map(), T0 + 100 * DAY);
assert.strictEqual(s.wins, 4);
assert.strictEqual(s.losses, 1);
assert.strictEqual(s.refunds, 1);
assert.strictEqual(s.active, 1);
assert.strictEqual(s.pending, 1);
assert.strictEqual(s.winRate, 0.8);
assert.strictEqual(s.longestWinStreak, 2);
assert.strictEqual(s.currentWinStreak, 2); // L, (refund skipped), W, W
assert.strictEqual(s.form, 2);
assert.deepStrictEqual(s.byCurrency.SOL, { wins: 2, losses: 1, refunds: 1, forfeits: 0, staked: 4, net: 2 });
assert.deepStrictEqual(s.byCurrency.PTS, { wins: 2, losses: 0, refunds: 0, forfeits: 0, staked: 75, net: 75 });
assert.deepStrictEqual(s.headToHead.map((h) => [h.opponent, h.played, h.wins, h.losses, h.refunds, h.active]), [
  ["sam", 4, 3, 0, 1, 1],
  ["alex", 2, 1, 1, 0, 0],
]);
assert.strictEqual(s.headToHead[0].lastResult?.result, "win");
assert.strictEqual(s.headToHead[0].lastResult?.currency, "PTS");
assert.strictEqual(s.recent[0].result, "win");
assert.strictEqual(s.recent.length, 6);
// sam: L, L, (refund), L(PTS), W (vs alex) → form +1, current streak 1, longest 1.
const samStats = computeUserStats("sam", history, new Map(), T0 + 100 * DAY);
assert.deepStrictEqual([samStats.wins, samStats.losses, samStats.form, samStats.currentWinStreak], [1, 3, 1, 1]);
// alex: W (vs jordan), L (vs jordan), L (vs sam) → losing form −2, no current win streak.
const alexStats = computeUserStats("alex", history, new Map(), T0 + 100 * DAY);
assert.deepStrictEqual([alexStats.wins, alexStats.losses, alexStats.form, alexStats.currentWinStreak, alexStats.longestWinStreak], [1, 2, -2, 0, 1]);

// ── check-in streaks ───────────────────────────────────────────────────────────
const sched = (startDate: string, endDate: string): BetSchedule => ({
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC", startDate, endDate,
});
const s1 = sched("2026-02-01", "2026-02-05"); // 5 days
const occ1 = scheduleOccurrences(s1);
const ci = (betId: string, key: string, status: CheckinDoc["status"], reviews: CheckinDoc["reviews"] = []): CheckinDoc => ({
  id: `ci-${betId}-${key}`, betId, occurrenceKey: key, occurrenceStart: 0, occurrenceEnd: 0, doer: "jordan",
  submittedAt: 0, proofIds: [], reviews, status, rev: 0,
});
const habitA = bet({ id: "habit-a", schedule: s1, requiredCheckins: 5, status: "ACTIVE", resolvedWinner: undefined, resolveByDate: occ1[4].end + 2 * DAY });
const s2 = sched("2026-02-10", "2026-02-13"); // 4 days, acceptor is the doer
const occ2 = scheduleOccurrences(s2);
const habitB = bet({
  id: "habit-b", schedule: s2, doer: "acceptor", challenger: "sam", acceptor: "jordan", acceptedBy: "jordan",
  requiredCheckins: 2, resolveByDate: occ2[3].end + 2 * DAY, status: "COMPLETED", resolvedWinner: "acceptor",
  resolvedAt: occ2[1].end,
});
const checkinMap = new Map<string, CheckinDoc[]>([
  ["habit-a", [
    ci("habit-a", "2026-02-01", "approved"),
    ci("habit-a", "2026-02-02", "approved"),
    // 02-03 missed
    ci("habit-a", "2026-02-04", "approved"),
    ci("habit-a", "2026-02-05", "pending"), // still under review → skipped
  ]],
  ["habit-b", [ci("habit-b", "2026-02-10", "approved"), ci("habit-b", "2026-02-11", "approved")]],
]);
const now = occ1[4].end + DAY; // after A's last window, before its deadline
const cs = computeUserStats("jordan", [habitA, habitB], checkinMap, now);
// Sequence: A1 ✓ A2 ✓ A3 ✗ A4 ✓ (A5 pending skipped) B1 ✓ B2 ✓ (B3/B4 after the decision → ignored)
assert.strictEqual(cs.longestCheckinStreak, 3);
assert.strictEqual(cs.currentCheckinStreak, 3);
assert.deepStrictEqual(cs.checkins, { approved: 5, missed: 1, total: 6 });
// habit B was a win for jordan (acceptor side, doer kept the streak).
assert.strictEqual(cs.wins, 1);
// Sam is not the doer anywhere → no check-in streak.
assert.strictEqual(computeUserStats("sam", [habitA, habitB], checkinMap, now).checkins.total, 0);

console.log("stats checks passed");
