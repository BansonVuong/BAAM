// relayer/witness-fallback.ts
//
// Pure decisions for witness (peer-judged) bets: what the crank should do with an
// escrowed bet at time T, and whether an unaccepted offer has expired. No I/O, so
// it can be exercised by a plain script (see relayer/witness-fallback.check.ts).

import type { BetDoc } from "./db";

export type FallbackKind = NonNullable<BetDoc["fallbackKind"]>;

export type WitnessCrankAction =
  | { type: "none" }
  /** Quorum picked a side: pay the winner. */
  | { type: "settle-winner"; winner: "challenger" | "acceptor" }
  /**
   * Run the precommitted fallback on-chain. `alreadyClaimed` = the Mongo doc is
   * already committed to it (a previous attempt's tx failed or wasn't recorded),
   * so retry the on-chain call without re-claiming.
   */
  | { type: "apply-fallback"; fallback: FallbackKind; alreadyClaimed: boolean }
  /** Legacy SportsBet with burn/charity: can't route funds to a third party. */
  | { type: "block-fallback"; fallback: Exclude<FallbackKind, "return">; reason: string };

type WitnessDocFields = Pick<
  BetDoc,
  | "validation"
  | "status"
  | "onChainState"
  | "onChainKind"
  | "resolvedWinner"
  | "resolveByDate"
  | "acceptByDate"
  | "fallbackKind"
  | "fallbackApplied"
  | "fallbackBlocked"
>;

export const LEGACY_FALLBACK_BLOCKED_REASON =
  "legacy SportsBet escrow can only pay the two participants; burn/charity fallback needs an operator";

/**
 * What the crank should do with a locked, escrowed witness bet at `nowMs`.
 * Precedence: a committed fallback beats a (late, racing) resolvedWinner, so once
 * the crank has claimed the fallback no vote can flip the payout.
 */
export function witnessCrankAction(doc: WitnessDocFields, nowMs: number): WitnessCrankAction {
  if (doc.validation === "sports") return { type: "none" };
  if (doc.onChainState !== "locked") return { type: "none" };
  if (doc.fallbackBlocked) return { type: "none" }; // operator's call now
  if (doc.fallbackApplied) {
    return { type: "apply-fallback", fallback: doc.fallbackApplied, alreadyClaimed: true };
  }
  if (doc.resolvedWinner) return { type: "settle-winner", winner: doc.resolvedWinner };
  if (typeof doc.resolveByDate !== "number" || nowMs < doc.resolveByDate) return { type: "none" };

  const fallback: FallbackKind = doc.fallbackKind ?? "return";
  const kind = doc.onChainKind ?? "sports";
  if (kind === "social" || fallback === "return") {
    return { type: "apply-fallback", fallback, alreadyClaimed: false };
  }
  return { type: "block-fallback", fallback, reason: LEGACY_FALLBACK_BLOCKED_REASON };
}

/**
 * Effective accept deadline for a witness offer (unix ms), or null if indefinite.
 * An offer can never be accepted after its resolve-by date, even with an
 * indefinite accept-by date.
 */
export function witnessAcceptDeadline(doc: Pick<BetDoc, "acceptByDate" | "resolveByDate">): number | null {
  const deadlines = [doc.acceptByDate, doc.resolveByDate].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  return deadlines.length ? Math.min(...deadlines) : null;
}

/** True when an unaccepted (PENDING) witness offer can no longer be accepted. */
export function isWitnessOfferExpired(
  doc: Pick<BetDoc, "validation" | "status" | "acceptByDate" | "resolveByDate" | "offerExpired">,
  nowMs: number,
): boolean {
  if (doc.validation === "sports") return false;
  if (doc.offerExpired) return true;
  if (doc.status !== "PENDING") return false;
  const deadline = witnessAcceptDeadline(doc);
  return deadline !== null && nowMs >= deadline;
}

/** Short human label for a fallback outcome (used by API cards and logs). */
export function fallbackLabel(doc: Pick<BetDoc, "fallbackApplied" | "fallbackBlocked" | "fallbackKind" | "charityName" | "onChainState">): string | null {
  if (doc.fallbackBlocked) {
    return `No verdict by deadline — ${doc.fallbackKind ?? "fallback"} pending operator review (funds still escrowed)`;
  }
  if (!doc.fallbackApplied) return null;
  const done = doc.onChainState === "settled";
  switch (doc.fallbackApplied) {
    case "return": return done ? "Refunded — no verdict by deadline" : "Refund pending — no verdict by deadline";
    case "burn": return done ? "Burned — no verdict by deadline" : "Burn pending — no verdict by deadline";
    case "charity": {
      const to = doc.charityName ? ` to ${doc.charityName}` : " to charity";
      return done ? `Donated${to} — no verdict by deadline` : `Donation${to} pending — no verdict by deadline`;
    }
  }
}
