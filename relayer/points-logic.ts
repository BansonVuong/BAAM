// relayer/points-logic.ts
//
// Pure decisions for points mode (play-money bets that never touch the chain).
// No I/O, so it can be exercised by a plain script (see relayer/points.check.ts).
// The Mongo-backed balance/ledger/escrow layer lives in relayer/points.ts.
//
// Points have no cash value: they cannot be bought, transferred, withdrawn, or
// converted to/from SOL. Nothing in this module (or points.ts) moves value
// between the two currencies.

import type { BetDoc } from "./db";
import { witnessCrankAction, type FallbackKind } from "./witness-fallback";

export type BetCurrency = "PTS" | "SOL";
export const BET_CURRENCY_VALUES: readonly BetCurrency[] = ["PTS", "SOL"];

export function isBetCurrency(value: unknown): value is BetCurrency {
  return value === "PTS" || value === "SOL";
}

/**
 * Parse BET_CURRENCIES (comma-separated, case-insensitive). Unknown entries are
 * ignored; an empty/invalid value falls back to points only. Order matters: the
 * first entry is the default for clients that omit `currency`.
 */
export function parseBetCurrencies(raw: string | undefined): BetCurrency[] {
  const source = raw === undefined || raw.trim() === "" ? "PTS,SOL" : raw;
  const out: BetCurrency[] = [];
  for (const part of source.split(",")) {
    const value = part.trim().toUpperCase();
    if (isBetCurrency(value) && !out.includes(value)) out.push(value);
  }
  return out.length ? out : ["PTS"];
}

export type CurrencyChoice = { currency: BetCurrency } | { error: string };

/** Resolve the currency a POST /bets request asked for against the allowed set. */
export function resolveBetCurrency(requested: unknown, allowed: readonly BetCurrency[]): CurrencyChoice {
  if (requested === undefined || requested === null || requested === "") {
    return { currency: allowed[0] ?? "PTS" };
  }
  const value = typeof requested === "string" ? requested.trim().toUpperCase() : "";
  if (!isBetCurrency(value)) return { error: "currency must be PTS or SOL" };
  if (!allowed.includes(value)) {
    return { error: `${value} bets are not available; use ${allowed.join(" or ")}` };
  }
  return { currency: value };
}

/** The currency a stored bet is denominated in (legacy docs are all SOL). */
export function betCurrencyOf(bet: Pick<BetDoc, "currency">): BetCurrency {
  return bet.currency === "PTS" ? "PTS" : "SOL";
}

export const POINTS_MAX_STAKE = 1_000_000_000;

/** Points stakes are whole numbers ≥ 1. Returns the integer stake or an error. */
export function parsePointsStake(raw: unknown): { stake: number } | { error: string } {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/.test(text)) return { error: "points stake must be a whole number of at least 1" };
  const stake = Number(text);
  if (!Number.isSafeInteger(stake) || stake < 1) {
    return { error: "points stake must be a whole number of at least 1" };
  }
  if (stake > POINTS_MAX_STAKE) return { error: `points stake must be at most ${POINTS_MAX_STAKE}` };
  return { stake };
}

/** YYYY-MM-DD in UTC — the top-up period key. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * How many points a daily top-up would grant: enough to bring `balance` back up
 * to `floor`, at most once per UTC day. 0 = nothing claimable.
 */
export function topupAmount(balance: number, floor: number, claimedToday: boolean): number {
  if (claimedToday || !(floor > 0)) return 0;
  const missing = Math.floor(floor) - Math.floor(balance);
  return missing > 0 ? missing : 0;
}

// ── idempotency keys ────────────────────────────────────────────────────────────
// Every balance movement has a deterministic key; the ledger has a unique index
// on it, so a crank retry or a duplicated request can never apply it twice.
// Settlement keys are per (betId, kind, user); holds also carry the accept attempt
// so a failed (and compensated) accept can be retried with fresh holds.

export const pointsKeys = {
  signupGrant: (userId: string) => `grant:signup:${userId}`,
  topup: (userId: string, day: string) => `topup:${userId}:${day}`,
  hold: (betId: string, attempt: string, userId: string) => `hold:${betId}:${attempt}:${userId}`,
  /** Compensation for a hold whose accept attempt failed or was abandoned. */
  release: (betId: string, attempt: string, userId: string) => `release:${betId}:${attempt}:${userId}`,
  payout: (betId: string, userId: string) => `payout:${betId}:${userId}`,
  refund: (betId: string, userId: string) => `refund:${betId}:${userId}`,
  burn: (betId: string, userId: string) => `burn:${betId}:${userId}`,
};

/** Hold attempt id used for the challenger's stake on a sports bet at creation. */
export const SPORTS_CREATE_ATTEMPT = "create";

// ── settlement ──────────────────────────────────────────────────────────────────

export type PointsOutcome =
  | { type: "winner"; winner: "challenger" | "acceptor" }
  /** Draw, unaccepted-at-kickoff, or "return" fallback: every held stake goes back. */
  | { type: "refund"; reason: string }
  /** "burn" fallback: held stakes are destroyed. */
  | { type: "burn"; reason: string };

export type PointsOp = {
  key: string;
  kind: "payout" | "refund" | "burn";
  userId: string;
  username: string;
  /** Change to the user's balance (burn = 0: the stake already left at hold time). */
  delta: number;
  /** Points involved (pot for payout, stake for refund/burn). */
  amount: number;
  reason: string;
};

export type PointsParty = { userId: string; username: string };

/**
 * Which ledger ops settle a points bet. `acceptor` is null when only the
 * challenger's stake is held (a sports offer nobody accepted before kickoff).
 * Throws on an outcome that cannot apply to the held stakes.
 */
export function planPointsSettlement(
  betId: string,
  stake: number,
  challenger: PointsParty,
  acceptor: PointsParty | null,
  outcome: PointsOutcome,
): PointsOp[] {
  const holders = acceptor ? [challenger, acceptor] : [challenger];
  switch (outcome.type) {
    case "winner": {
      if (!acceptor) throw new Error("cannot pay a winner on a bet with only one stake held");
      const winner = outcome.winner === "challenger" ? challenger : acceptor;
      const pot = stake * holders.length;
      return [{
        key: pointsKeys.payout(betId, winner.userId),
        kind: "payout",
        userId: winner.userId,
        username: winner.username,
        delta: pot,
        amount: pot,
        reason: `won bet ${betId}`,
      }];
    }
    case "refund":
      return holders.map((p) => ({
        key: pointsKeys.refund(betId, p.userId),
        kind: "refund" as const,
        userId: p.userId,
        username: p.username,
        delta: stake,
        amount: stake,
        reason: outcome.reason,
      }));
    case "burn":
      return holders.map((p) => ({
        key: pointsKeys.burn(betId, p.userId),
        kind: "burn" as const,
        userId: p.userId,
        username: p.username,
        delta: 0,
        amount: stake,
        reason: outcome.reason,
      }));
  }
}

/** Terminal pointsState for an outcome. */
export function finalPointsState(outcome: PointsOutcome): "settled" | "refunded" | "burned" {
  return outcome.type === "winner" ? "settled" : outcome.type === "refund" ? "refunded" : "burned";
}

// ── crank decisions ─────────────────────────────────────────────────────────────

export type PointsCrankAction =
  | { type: "none" }
  /** Settle with an outcome already decided (vote quorum / stored settlement / sports result). */
  | { type: "settle"; outcome: PointsOutcome }
  /** Resolve-by passed with no verdict: claim the precommitted fallback, then settle. */
  | { type: "claim-fallback"; fallback: Exclude<FallbackKind, "charity">; outcome: PointsOutcome }
  /** Held sports bet past settle time: look up the game result. */
  | { type: "check-sports-result" };

type PointsCrankFields = Pick<
  BetDoc,
  | "currency"
  | "validation"
  | "status"
  | "pointsState"
  | "pointsSettlement"
  | "resolvedWinner"
  | "resolveByDate"
  | "acceptByDate"
  | "fallbackKind"
  | "fallbackApplied"
  | "fallbackBlocked"
  | "startTime"
  | "settleAfter"
>;

/** Map a fallback kind to the points outcome. Charity is rejected at creation; treat legacy as return. */
export function fallbackOutcome(kind: FallbackKind | undefined): PointsOutcome {
  return kind === "burn"
    ? { type: "burn", reason: "no verdict by resolve-by date (burn fallback)" }
    : { type: "refund", reason: "no verdict by resolve-by date (return fallback)" };
}

/**
 * What the points crank should do with a points bet at `nowMs`. Witness bets reuse
 * witnessCrankAction (a points escrow behaves like a SocialBet: every fallback runs,
 * and a claimed fallback outranks a racing late vote).
 */
export function pointsCrankAction(doc: PointsCrankFields, nowMs: number): PointsCrankAction {
  if (doc.currency !== "PTS") return { type: "none" };
  if (doc.pointsState !== "open" && doc.pointsState !== "held") return { type: "none" };
  // A recorded decision is final — finish applying it (crash/retry recovery).
  if (doc.pointsSettlement) return { type: "settle", outcome: doc.pointsSettlement };

  if (doc.validation === "sports") {
    if (doc.pointsState === "open") {
      // Must be accepted before kickoff; nobody did → refund the challenger.
      if (typeof doc.startTime === "number" && nowMs >= doc.startTime * 1000) {
        return { type: "settle", outcome: { type: "refund", reason: "not accepted before kickoff" } };
      }
      return { type: "none" };
    }
    const settleAt = typeof doc.settleAfter === "number" ? doc.settleAfter : doc.startTime;
    if (typeof settleAt !== "number" || nowMs < settleAt * 1000) return { type: "none" };
    return { type: "check-sports-result" };
  }

  // Witness bets only hold stakes once both sides are in.
  if (doc.pointsState !== "held") return { type: "none" };
  const action = witnessCrankAction(
    { ...doc, onChainState: "locked", onChainKind: "social" },
    nowMs,
  );
  switch (action.type) {
    case "settle-winner":
      return { type: "settle", outcome: { type: "winner", winner: action.winner } };
    case "apply-fallback": {
      const outcome = fallbackOutcome(action.fallback);
      if (action.alreadyClaimed) return { type: "settle", outcome };
      return { type: "claim-fallback", fallback: action.fallback === "burn" ? "burn" : "return", outcome };
    }
    default:
      return { type: "none" };
  }
}

/** Outcome for a held points sports bet from a final game result. */
export function sportsPointsOutcome(
  challengerBacksHome: boolean | undefined,
  homeWon: boolean | null,
): PointsOutcome {
  if (homeWon === null) return { type: "refund", reason: "game ended in a draw" };
  const challengerWon = (challengerBacksHome ?? true) === homeWon;
  return { type: "winner", winner: challengerWon ? "challenger" : "acceptor" };
}

/** Human label for a points bet's escrow state (cards / logs). */
export function pointsStateLabel(doc: Pick<BetDoc, "pointsState" | "pointsSettlement" | "fallbackApplied">): string {
  switch (doc.pointsState) {
    case "open": return "POINTS HELD · awaiting match";
    case "held":
      return doc.pointsSettlement || doc.fallbackApplied ? "POINTS · settling" : "POINTS LOCKED";
    case "settled": return "POINTS PAID OUT";
    case "refunded": return doc.fallbackApplied ? "POINTS REFUNDED · no verdict by deadline" : "POINTS REFUNDED";
    case "burned": return "POINTS BURNED · no verdict by deadline";
    default: return "POINTS · nothing held yet";
  }
}

/**
 * A doc shaped so the SOL-oriented fallbackLabel() reports a points bet correctly
 * (it treats onChainState "settled" as "done").
 */
export function asFallbackLabelDoc<T extends Pick<BetDoc, "currency" | "pointsState" | "onChainState">>(doc: T): T {
  if (doc.currency !== "PTS") return doc;
  const done = doc.pointsState === "settled" || doc.pointsState === "refunded" || doc.pointsState === "burned";
  return { ...doc, onChainState: done ? "settled" : "locked" };
}
