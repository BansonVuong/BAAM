// Plain assertion script for relayer/witness-fallback.ts (no test framework):
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/witness-fallback.check.ts
import assert from "assert";

import type { BetDoc } from "./db";
import { fallbackLabel, isWitnessOfferExpired, witnessAcceptDeadline, witnessCrankAction } from "./witness-fallback";

const T = 1_700_000_000_000;
const locked = (extra: Partial<BetDoc> = {}): Partial<BetDoc> => ({
  status: "ACTIVE",
  onChainState: "locked",
  resolveByDate: T,
  fallbackKind: "return",
  ...extra,
});
const act = (doc: Partial<BetDoc>, now: number) => witnessCrankAction(doc as BetDoc, now);

// Before the deadline with no verdict: nothing to do.
assert.deepStrictEqual(act(locked(), T - 1), { type: "none" });
// Quorum wins whenever it lands before the fallback claim, even after the deadline.
assert.deepStrictEqual(act(locked({ resolvedWinner: "acceptor" }), T - 1), { type: "settle-winner", winner: "acceptor" });
assert.deepStrictEqual(act(locked({ resolvedWinner: "challenger" }), T + 1), { type: "settle-winner", winner: "challenger" });
// Deadline passed, no verdict: legacy return → refund; legacy burn/charity → blocked.
assert.deepStrictEqual(act(locked(), T), { type: "apply-fallback", fallback: "return", alreadyClaimed: false });
assert.deepStrictEqual(act(locked({ fallbackKind: undefined }), T), { type: "apply-fallback", fallback: "return", alreadyClaimed: false });
assert.strictEqual(act(locked({ fallbackKind: "burn" }), T).type, "block-fallback");
assert.strictEqual(act(locked({ fallbackKind: "charity", onChainKind: "sports" }), T).type, "block-fallback");
// Social escrow runs every fallback kind on-chain.
for (const k of ["return", "burn", "charity"] as const) {
  assert.deepStrictEqual(
    act(locked({ fallbackKind: k, onChainKind: "social" }), T),
    { type: "apply-fallback", fallback: k, alreadyClaimed: false },
  );
}
// A claimed fallback outranks a racing late vote, and is retried until settled.
assert.deepStrictEqual(
  act(locked({ fallbackApplied: "return", resolvedWinner: "challenger", status: "COMPLETED" }), T + 5),
  { type: "apply-fallback", fallback: "return", alreadyClaimed: true },
);
// Blocked fallbacks are left for an operator; settled/open/sports/no-deadline docs are ignored.
assert.deepStrictEqual(act(locked({ fallbackKind: "burn", fallbackBlocked: true, resolvedWinner: "acceptor" }), T), { type: "none" });
assert.deepStrictEqual(act(locked({ onChainState: "settled" }), T), { type: "none" });
assert.deepStrictEqual(act(locked({ onChainState: "open" }), T), { type: "none" });
assert.deepStrictEqual(act(locked({ validation: "sports" }), T), { type: "none" });
assert.deepStrictEqual(act(locked({ resolveByDate: undefined }), T * 2), { type: "none" });

// Offer expiry: min(acceptBy, resolveBy); indefinite acceptBy still bounded by resolveBy.
assert.strictEqual(witnessAcceptDeadline({ acceptByDate: null, resolveByDate: T }), T);
assert.strictEqual(witnessAcceptDeadline({ acceptByDate: T - 10, resolveByDate: T }), T - 10);
assert.strictEqual(witnessAcceptDeadline({}), null);
const pending = (extra: Partial<BetDoc>) => ({ status: "PENDING", ...extra } as BetDoc);
assert.strictEqual(isWitnessOfferExpired(pending({ acceptByDate: T - 10, resolveByDate: T }), T - 11), false);
assert.strictEqual(isWitnessOfferExpired(pending({ acceptByDate: T - 10, resolveByDate: T }), T - 10), true);
assert.strictEqual(isWitnessOfferExpired(pending({ acceptByDate: null, resolveByDate: T }), T), true);
assert.strictEqual(isWitnessOfferExpired(pending({}), T * 2), false); // legacy doc: indefinite
assert.strictEqual(isWitnessOfferExpired(pending({ validation: "sports", resolveByDate: T }), T), false);
assert.strictEqual(isWitnessOfferExpired({ status: "ACTIVE", resolveByDate: T } as BetDoc, T), false);

// Labels.
assert.strictEqual(fallbackLabel({ fallbackApplied: "return", onChainState: "settled" }), "Refunded — no verdict by deadline");
assert.strictEqual(fallbackLabel({ fallbackApplied: "return", onChainState: "locked" }), "Refund pending — no verdict by deadline");
assert.match(fallbackLabel({ fallbackBlocked: true, fallbackKind: "burn" }) ?? "", /operator/);
assert.strictEqual(fallbackLabel({}), null);

console.log("witness-fallback checks passed");
