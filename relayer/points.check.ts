// Plain assertion script for relayer/points-logic.ts (no test framework, no DB):
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/points.check.ts
import assert from "assert";

import type { BetDoc } from "./db";
import {
  asFallbackLabelDoc,
  betCurrencyOf,
  finalPointsState,
  parseBetCurrencies,
  parsePointsStake,
  planPointsSettlement,
  pointsCrankAction,
  pointsKeys,
  resolveBetCurrency,
  sportsPointsOutcome,
  topupAmount,
  utcDayKey,
} from "./points-logic";
import { fallbackLabel } from "./witness-fallback";

// ── currencies ──
assert.deepStrictEqual(parseBetCurrencies(undefined), ["PTS", "SOL"]);
assert.deepStrictEqual(parseBetCurrencies(""), ["PTS", "SOL"]);
assert.deepStrictEqual(parseBetCurrencies("PTS"), ["PTS"]);
assert.deepStrictEqual(parseBetCurrencies(" sol , pts ,sol"), ["SOL", "PTS"]);
assert.deepStrictEqual(parseBetCurrencies("BTC"), ["PTS"]); // nothing valid → points only
assert.deepStrictEqual(resolveBetCurrency(undefined, ["PTS", "SOL"]), { currency: "PTS" });
assert.deepStrictEqual(resolveBetCurrency(undefined, ["SOL", "PTS"]), { currency: "SOL" });
assert.deepStrictEqual(resolveBetCurrency("sol", ["PTS", "SOL"]), { currency: "SOL" });
assert.ok("error" in resolveBetCurrency("SOL", ["PTS"]));
assert.ok("error" in resolveBetCurrency("USD", ["PTS", "SOL"]));
assert.strictEqual(betCurrencyOf({ currency: "PTS" }), "PTS");
assert.strictEqual(betCurrencyOf({ currency: "SOL" }), "SOL");
assert.strictEqual(betCurrencyOf({ currency: undefined as unknown as string }), "SOL"); // legacy

// ── stakes ──
assert.deepStrictEqual(parsePointsStake("50"), { stake: 50 });
assert.deepStrictEqual(parsePointsStake(7), { stake: 7 });
for (const bad of ["0", "-1", "1.5", "0.1", "", "abc", "1e3", 2.5, null, "99999999999999999999"]) {
  assert.ok("error" in parsePointsStake(bad), `stake ${String(bad)} should be rejected`);
}

// ── top-ups ──
assert.strictEqual(topupAmount(40, 100, false), 60);
assert.strictEqual(topupAmount(0, 100, false), 100);
assert.strictEqual(topupAmount(100, 100, false), 0);
assert.strictEqual(topupAmount(500, 100, false), 0);
assert.strictEqual(topupAmount(40, 100, true), 0); // once per UTC day
assert.strictEqual(topupAmount(40, 0, false), 0); // disabled
assert.strictEqual(utcDayKey(Date.UTC(2026, 10, 25, 23, 59)), "2026-11-25");
assert.strictEqual(utcDayKey(Date.UTC(2026, 10, 26, 0, 0)), "2026-11-26");

// ── settlement plans ──
const ch = { userId: "u-c", username: "carol" };
const ac = { userId: "u-a", username: "alice" };
const win = planPointsSettlement("bet-1", 50, ch, ac, { type: "winner", winner: "acceptor" });
assert.deepStrictEqual(win.map((o) => [o.key, o.kind, o.delta]), [[pointsKeys.payout("bet-1", "u-a"), "payout", 100]]);
const refund = planPointsSettlement("bet-1", 50, ch, ac, { type: "refund", reason: "draw" });
assert.deepStrictEqual(refund.map((o) => [o.userId, o.kind, o.delta]), [["u-c", "refund", 50], ["u-a", "refund", 50]]);
const burn = planPointsSettlement("bet-1", 50, ch, ac, { type: "burn", reason: "x" });
assert.deepStrictEqual(burn.map((o) => [o.kind, o.delta, o.amount]), [["burn", 0, 50], ["burn", 0, 50]]);
const lone = planPointsSettlement("bet-1", 50, ch, null, { type: "refund", reason: "kickoff" });
assert.deepStrictEqual(lone.map((o) => [o.userId, o.delta]), [["u-c", 50]]);
assert.throws(() => planPointsSettlement("bet-1", 50, ch, null, { type: "winner", winner: "challenger" }));
// Conservation: holds (2 × stake) always equal what settlement returns + burns.
for (const plan of [win, refund, burn]) {
  assert.strictEqual(plan.reduce((s, o) => s + (o.kind === "burn" ? o.amount : o.delta), 0), 100);
}
// Keys are unique per (bet, kind, user) so retries collide instead of double-paying.
assert.notStrictEqual(pointsKeys.refund("bet-1", "u-a"), pointsKeys.refund("bet-1", "u-c"));
assert.notStrictEqual(pointsKeys.hold("bet-1", "a1", "u-a"), pointsKeys.hold("bet-1", "a2", "u-a"));
assert.strictEqual(finalPointsState({ type: "winner", winner: "challenger" }), "settled");
assert.strictEqual(finalPointsState({ type: "refund", reason: "" }), "refunded");
assert.strictEqual(finalPointsState({ type: "burn", reason: "" }), "burned");

// ── crank decisions ──
const T = 1_700_000_000_000;
const held = (extra: Partial<BetDoc> = {}) =>
  ({ currency: "PTS", status: "ACTIVE", pointsState: "held", resolveByDate: T, fallbackKind: "return", ...extra }) as BetDoc;
const act = (doc: BetDoc, now: number) => pointsCrankAction(doc, now);

assert.deepStrictEqual(act(held(), T - 1), { type: "none" });
assert.deepStrictEqual(act(held({ resolvedWinner: "acceptor", status: "COMPLETED" }), T - 1), {
  type: "settle",
  outcome: { type: "winner", winner: "acceptor" },
});
assert.deepStrictEqual(act(held(), T), {
  type: "claim-fallback",
  fallback: "return",
  outcome: { type: "refund", reason: "no verdict by resolve-by date (return fallback)" },
});
assert.deepStrictEqual(act(held({ fallbackKind: "burn" }), T).type, "claim-fallback");
assert.deepStrictEqual((act(held({ fallbackKind: "burn" }), T) as { outcome: { type: string } }).outcome.type, "burn");
// A claimed fallback outranks a racing late vote.
assert.deepStrictEqual(act(held({ fallbackApplied: "burn", resolvedWinner: "challenger" }), T + 5), {
  type: "settle",
  outcome: { type: "burn", reason: "no verdict by resolve-by date (burn fallback)" },
});
// A recorded settlement is final and retried as-is.
assert.deepStrictEqual(act(held({ pointsSettlement: { type: "refund", reason: "r" }, resolvedWinner: "acceptor" }), T), {
  type: "settle",
  outcome: { type: "refund", reason: "r" },
});
// Not points / nothing held / terminal → ignore.
assert.deepStrictEqual(act(held({ currency: "SOL" }), T), { type: "none" });
assert.deepStrictEqual(act(held({ pointsState: undefined }), T), { type: "none" });
assert.deepStrictEqual(act(held({ pointsState: "settled", resolvedWinner: "acceptor" }), T), { type: "none" });
assert.deepStrictEqual(act(held({ pointsState: "open" }), T), { type: "none" }); // witness bets never sit "open"

// Sports: unaccepted at kickoff → refund challenger; held after settle time → check result.
const sports = (extra: Partial<BetDoc>) =>
  ({ currency: "PTS", validation: "sports", startTime: T / 1000, settleAfter: T / 1000 + 60, ...extra }) as BetDoc;
assert.deepStrictEqual(act(sports({ pointsState: "open", status: "PENDING" }), T - 1), { type: "none" });
assert.deepStrictEqual(act(sports({ pointsState: "open", status: "PENDING" }), T), {
  type: "settle",
  outcome: { type: "refund", reason: "not accepted before kickoff" },
});
assert.deepStrictEqual(act(sports({ pointsState: "held", status: "ACTIVE" }), T + 59_000), { type: "none" });
assert.deepStrictEqual(act(sports({ pointsState: "held", status: "ACTIVE" }), T + 60_000), { type: "check-sports-result" });
assert.deepStrictEqual(sportsPointsOutcome(true, true), { type: "winner", winner: "challenger" });
assert.deepStrictEqual(sportsPointsOutcome(true, false), { type: "winner", winner: "acceptor" });
assert.deepStrictEqual(sportsPointsOutcome(false, false), { type: "winner", winner: "challenger" });
assert.deepStrictEqual(sportsPointsOutcome(undefined, null).type, "refund");

// Labels: fallbackLabel reports a finished points refund as done, a pending one as pending.
assert.strictEqual(
  fallbackLabel(asFallbackLabelDoc({ currency: "PTS", pointsState: "refunded", fallbackApplied: "return" } as BetDoc)),
  "Refunded — no verdict by deadline",
);
assert.strictEqual(
  fallbackLabel(asFallbackLabelDoc({ currency: "PTS", pointsState: "held", fallbackApplied: "return" } as BetDoc)),
  "Refund pending — no verdict by deadline",
);

console.log("points checks passed");
