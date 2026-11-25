// relayer/stats.ts
//
// Pure per-user stats: record, win streaks, check-in streaks and head-to-head
// rivalries, computed from bets the viewer is already allowed to see (the route
// in relayer/features.ts does the access filtering). No I/O; see
// relayer/stats.check.ts.
//
// Conventions:
//  - A bet counts once it is decided: win/loss from `resolvedWinner` (or a legacy
//    vote quorum); "refund" = return fallback or a cancelled escrow; "forfeit" =
//    burn/charity fallback (both sides lose their stake). Unaccepted/expired
//    offers never count. Refunds and forfeits neither extend nor break win streaks.
//  - Bets are ordered by `resolvedAt` when present, else `createdAt`.
//  - Currency: `PTS` bets are tallied separately; anything else is SOL.
//  - Check-in streaks run over the user's occurrences (as doer) across every
//    recurring bet, in time order: approved occurrences extend the streak;
//    missed / rejected / mixed-review ones break it; still-open, under-review and
//    never-reviewed ones are skipped. Occurrences after a bet was decided are ignored.

import type { BetDoc, CheckinDoc } from "./db";
import { evaluateCheckins, scheduleOccurrences, verdictDeadline, type OccurrenceState } from "./schedule";

export type StatsCurrency = "SOL" | "PTS";
export type BetResult = "win" | "loss" | "refund" | "forfeit";

export interface CurrencyTotals {
  wins: number;
  losses: number;
  refunds: number;
  forfeits: number;
  /** Sum of the user's stakes on decided (win/loss/forfeit) bets. */
  staked: number;
  /** +stake per win, −stake per loss/forfeit (equal stakes on both sides). */
  net: number;
}

export interface HeadToHead {
  opponent: string;
  played: number;
  wins: number;
  losses: number;
  refunds: number;
  forfeits: number;
  active: number;
  lastResult: { result: BetResult; betId: string; at: number; currency: StatsCurrency } | null;
}

export interface UserStats {
  username: string;
  wins: number;
  losses: number;
  refunds: number;
  forfeits: number;
  active: number;
  pending: number;
  winRate: number | null;
  currentWinStreak: number;
  longestWinStreak: number;
  /** Signed: +n = n wins in a row most recently, −n = n losses in a row. */
  form: number;
  currentCheckinStreak: number;
  longestCheckinStreak: number;
  checkins: { approved: number; missed: number; total: number };
  byCurrency: Record<StatsCurrency, CurrencyTotals>;
  headToHead: HeadToHead[];
  recent: Array<{ betId: string; result: BetResult; opponent: string | null; at: number; currency: StatsCurrency; terms: string }>;
}

const lower = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

function acceptorName(bet: BetDoc): string | null {
  const name = bet.acceptedBy ?? bet.opponentUsername ?? bet.acceptor;
  return name && lower(name) !== "anyone" ? name : null;
}

/** Which side `username` is on, or null if not a party. */
export function sideOf(bet: BetDoc, username: string): "challenger" | "acceptor" | null {
  const key = lower(username);
  if (lower(bet.challenger) === key) return "challenger";
  if ([bet.acceptedBy, bet.opponentUsername, bet.acceptor].some((n) => lower(n) === key && key !== "anyone")) return "acceptor";
  return null;
}

/** Winner by explicit verdict or legacy vote quorum; none once a fallback is committed. */
export function decidedWinner(bet: BetDoc): "challenger" | "acceptor" | null {
  if (bet.status === "PENDING" || bet.fallbackApplied || bet.fallbackBlocked || bet.offerExpired) return null;
  if (bet.resolvedWinner) return bet.resolvedWinner;
  if (bet.status !== "COMPLETED" && bet.status !== "RESOLVED") return null;
  const votes = Object.values(bet.votesByVoter ?? {});
  const threshold = Math.max(1, Number(bet.witnesses) || 1);
  if (votes.filter((v) => v === "challenger").length >= threshold) return "challenger";
  if (votes.filter((v) => v === "acceptor").length >= threshold) return "acceptor";
  return null;
}

/** Final result for `username`, or null while undecided / not applicable. */
export function resultFor(bet: BetDoc, username: string): BetResult | null {
  const side = sideOf(bet, username);
  if (!side || bet.offerExpired || bet.status === "PENDING") return null;
  if (bet.onChainState === "cancelled") {
    // A cancelled escrow that was never matched was never a bet.
    return bet.acceptedBy || bet.opponentUsername ? "refund" : null;
  }
  if (bet.fallbackApplied === "return") return "refund";
  if (bet.fallbackApplied === "burn" || bet.fallbackApplied === "charity") return "forfeit";
  if (bet.fallbackBlocked) return null; // operator decides; not final
  const winner = decidedWinner(bet);
  if (!winner) return null;
  return winner === side ? "win" : "loss";
}

export function betCurrency(bet: Pick<BetDoc, "currency">): StatsCurrency {
  return String(bet.currency ?? "").toUpperCase() === "PTS" ? "PTS" : "SOL";
}

function betTime(bet: BetDoc): number {
  if (typeof bet.resolvedAt === "number") return bet.resolvedAt;
  if (typeof bet.createdAt === "number") return bet.createdAt;
  const match = /^bet-(\d+)-/.exec(bet.id);
  return match ? Number(match[1]) : 0;
}

function stakeAmount(bet: BetDoc): number {
  const n = Number(bet.stake);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function emptyTotals(): CurrencyTotals {
  return { wins: 0, losses: 0, refunds: 0, forfeits: 0, staked: 0, net: 0 };
}

function streaks(sequence: boolean[]): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  for (const ok of sequence) {
    run = ok ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { current: run, longest };
}

const CHECKIN_STREAK_EFFECT: Record<OccurrenceState, boolean | null> = {
  approved: true,
  "approved-by-default": true,
  missed: false,
  rejected: false,
  lapsed: false,
  // The doer checked in but witnesses never looked: don't hold it against them.
  unreviewed: null,
  upcoming: null,
  open: null,
  submitted: null,
};

/** Approved (true) / failed (false) occurrences where `username` is the doer, time-ordered. */
export function checkinSequence(
  username: string,
  betDocs: BetDoc[],
  checkinsByBet: Map<string, CheckinDoc[]>,
  nowMs: number,
): Array<{ at: number; ok: boolean; betId: string; key: string }> {
  const out: Array<{ at: number; ok: boolean; betId: string; key: string }> = [];
  for (const bet of betDocs) {
    if (!bet.schedule || bet.status === "PENDING" || bet.offerExpired) continue;
    const doerSide = bet.doer ?? "challenger";
    if (sideOf(bet, username) !== doerSide) continue;
    const occurrences = scheduleOccurrences(bet.schedule);
    const deadline = bet.resolveByDate ?? verdictDeadline(occurrences) ?? 0;
    const docs = checkinsByBet.get(bet.id) ?? [];
    const decidedAt = bet.status === "ACTIVE" ? null : bet.resolvedAt ?? bet.fallbackAppliedAt ?? null;
    // Judge the schedule as of the decision (or now): later windows are moot.
    const evaluation = evaluateCheckins(occurrences, docs, bet.requiredCheckins ?? occurrences.length, deadline, decidedAt ?? nowMs);
    for (const occ of evaluation.occurrences) {
      const effect = CHECKIN_STREAK_EFFECT[occ.state];
      if (effect === null) continue;
      if (decidedAt !== null && occ.start >= decidedAt && !occ.checkinId) continue;
      out.push({ at: occ.start, ok: effect, betId: bet.id, key: occ.key });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.betId.localeCompare(b.betId));
}

export function computeUserStats(
  username: string,
  betDocs: BetDoc[],
  checkinsByBet: Map<string, CheckinDoc[]>,
  nowMs: number,
): UserStats {
  const byCurrency: Record<StatsCurrency, CurrencyTotals> = { SOL: emptyTotals(), PTS: emptyTotals() };
  const h2h = new Map<string, HeadToHead>();
  const decided: Array<{ bet: BetDoc; result: BetResult; opponent: string | null; at: number }> = [];
  let active = 0;
  let pending = 0;

  const mine = betDocs.filter((bet) => sideOf(bet, username) !== null);
  for (const bet of mine) {
    const side = sideOf(bet, username)!;
    const opponent = side === "challenger" ? acceptorName(bet) : bet.challenger;
    const rival = opponent ? (() => {
      const key = lower(opponent);
      const entry = h2h.get(key) ?? {
        opponent, played: 0, wins: 0, losses: 0, refunds: 0, forfeits: 0, active: 0, lastResult: null,
      };
      h2h.set(key, entry);
      return entry;
    })() : null;

    const result = resultFor(bet, username);
    if (!result) {
      if (bet.offerExpired) continue;
      if (bet.status === "PENDING") pending += 1;
      else if (bet.status === "ACTIVE" || bet.fallbackBlocked) {
        active += 1;
        if (rival) rival.active += 1;
      }
      continue;
    }
    const at = betTime(bet);
    const currency = betCurrency(bet);
    const totals = byCurrency[currency];
    const stake = stakeAmount(bet);
    decided.push({ bet, result, opponent, at });
    if (result === "win") { totals.wins += 1; totals.staked += stake; totals.net += stake; }
    if (result === "loss") { totals.losses += 1; totals.staked += stake; totals.net -= stake; }
    if (result === "refund") totals.refunds += 1;
    if (result === "forfeit") { totals.forfeits += 1; totals.staked += stake; totals.net -= stake; }
    if (rival) {
      rival.played += 1;
      if (result === "win") rival.wins += 1;
      if (result === "loss") rival.losses += 1;
      if (result === "refund") rival.refunds += 1;
      if (result === "forfeit") rival.forfeits += 1;
      if (!rival.lastResult || at >= rival.lastResult.at) {
        rival.lastResult = { result, betId: bet.id, at, currency };
      }
    }
  }

  decided.sort((a, b) => a.at - b.at || a.bet.id.localeCompare(b.bet.id));
  const winLoss = decided.filter((d) => d.result === "win" || d.result === "loss");
  const winStreaks = streaks(winLoss.map((d) => d.result === "win"));
  let form = 0;
  for (let i = winLoss.length - 1; i >= 0; i -= 1) {
    const won = winLoss[i].result === "win";
    if (form === 0) form = won ? 1 : -1;
    else if (won === (form > 0)) form += won ? 1 : -1;
    else break;
  }

  const sequence = checkinSequence(username, mine, checkinsByBet, nowMs);
  const checkinStreaks = streaks(sequence.map((s) => s.ok));
  const wins = byCurrency.SOL.wins + byCurrency.PTS.wins;
  const losses = byCurrency.SOL.losses + byCurrency.PTS.losses;

  // Round currency sums to avoid float noise (SOL has 9 decimals).
  for (const totals of Object.values(byCurrency)) {
    totals.staked = Math.round(totals.staked * 1e9) / 1e9;
    totals.net = Math.round(totals.net * 1e9) / 1e9;
  }

  return {
    username,
    wins,
    losses,
    refunds: byCurrency.SOL.refunds + byCurrency.PTS.refunds,
    forfeits: byCurrency.SOL.forfeits + byCurrency.PTS.forfeits,
    active,
    pending,
    winRate: wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 1000 : null,
    currentWinStreak: winStreaks.current,
    longestWinStreak: winStreaks.longest,
    form,
    currentCheckinStreak: checkinStreaks.current,
    longestCheckinStreak: checkinStreaks.longest,
    checkins: {
      approved: sequence.filter((s) => s.ok).length,
      missed: sequence.filter((s) => !s.ok).length,
      total: sequence.length,
    },
    byCurrency,
    headToHead: [...h2h.values()]
      .filter((r) => r.played > 0 || r.active > 0)
      .sort((a, b) => (
        b.played - a.played
        || (b.lastResult?.at ?? 0) - (a.lastResult?.at ?? 0)
        || a.opponent.localeCompare(b.opponent)
      )),
    recent: decided.slice(-10).reverse().map((d) => ({
      betId: d.bet.id,
      result: d.result,
      opponent: d.opponent,
      at: d.at,
      currency: betCurrency(d.bet),
      terms: d.bet.terms,
    })),
  };
}
