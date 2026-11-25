// relayer/sports/settlement.ts
//
// Pure settlement rules for sports bets (no I/O — exercised by sports.check.ts).
// crankSportsBets (SOL escrow) and any points-mode settlement should both route
// a FinalResult through decideSportsSettlement() so they can never disagree.
//
// Rules:
//   1. Never act on a snapshot older than maxResultAgeMs.
//   2. If the bet recorded team ids at creation, the provider's event must still
//      have the same home/away teams — otherwise block for an operator.
//   3. final   → pay the winner (homeWon true/false) or refund both on a draw.
//                If the bet was accepted at/after the provider's actual kickoff
//                (game moved earlier), refund instead — the acceptor may have
//                known the result.
//                With a secondary provider configured, a final result is only
//                acted on once the secondary agrees; disagreement blocks the bet
//                (OPERATOR ACTION REQUIRED); no confirmation by the end of the
//                grace window also blocks.
//   4. postponed / cancelled → keep waiting until scheduledKickoff + graceMs, then
//                refund both. A postponed game that is replayed and goes final
//                inside the grace window settles normally; one re-dated beyond the
//                window (provider shows "scheduled" again) refunds once it closes.
//   5. pending / unknown / lookup error → wait. Bets the oracle can never settle
//                are recoverable on-chain via the permissionless refund_stale_bet.

import type { FinalResult } from "./types";

export interface ExpectedTeams {
  homeTeamId?: string | null;
  awayTeamId?: string | null;
}

export interface SettlementInput {
  nowMs: number;
  /** Kickoff recorded when the bet was created (on-chain start_time), unix ms. */
  scheduledKickoffMs: number;
  /** When the opponent accepted, unix ms (if known). */
  acceptedAtMs?: number | null;
  expected?: ExpectedTeams;
  primary: FinalResult;
  /** undefined = no secondary configured; null = secondary configured but no match found yet. */
  secondary?: FinalResult | null;
  graceMs: number;
  maxResultAgeMs: number;
}

export type SettlementAction =
  | { type: "wait"; reason: string }
  /** homeWon null = refund both sides. */
  | { type: "settle"; homeWon: boolean | null; reason: string }
  | { type: "block"; reason: string };

function outcomeLabel(homeWon: boolean | null): string {
  return homeWon === null ? "draw" : homeWon ? "home win" : "away win";
}

export function decideSportsSettlement(input: SettlementInput): SettlementAction {
  const { primary, nowMs } = input;
  const graceEndMs = input.scheduledKickoffMs + input.graceMs;

  if (primary.error) return { type: "wait", reason: `result lookup failed: ${primary.error}` };
  if (!Number.isFinite(primary.fetchedAtMs) || nowMs - primary.fetchedAtMs > input.maxResultAgeMs) {
    return { type: "wait", reason: "result snapshot is stale" };
  }

  const exp = input.expected;
  if (exp?.homeTeamId && exp?.awayTeamId && primary.homeTeamId && primary.awayTeamId) {
    if (exp.homeTeamId !== primary.homeTeamId || exp.awayTeamId !== primary.awayTeamId) {
      return {
        type: "block",
        reason: `teams changed since the bet was created (expected home ${exp.homeTeamId} / away ${exp.awayTeamId}, ` +
          `provider now reports ${primary.homeTeamId} / ${primary.awayTeamId})`,
      };
    }
  }

  switch (primary.status) {
    case "final": {
      if (!primary.isDraw && primary.homeWon === null) return { type: "wait", reason: "final without a winner or draw" };
      const homeWon = primary.isDraw ? null : primary.homeWon;
      if (
        typeof input.acceptedAtMs === "number" &&
        typeof primary.startTimeMs === "number" &&
        input.acceptedAtMs >= primary.startTimeMs
      ) {
        return { type: "settle", homeWon: null, reason: "accepted at or after the actual kickoff — refunding both sides" };
      }
      if (input.secondary !== undefined) {
        const sec = input.secondary;
        if (!sec || sec.error || sec.status !== "final") {
          if (nowMs < graceEndMs) return { type: "wait", reason: "waiting for the secondary provider to confirm" };
          return {
            type: "block",
            reason: `secondary provider could not confirm the result (${sec?.error ?? sec?.status ?? "no matching event"})`,
          };
        }
        if (nowMs - sec.fetchedAtMs > input.maxResultAgeMs) return { type: "wait", reason: "secondary snapshot is stale" };
        const secHomeWon = sec.isDraw ? null : sec.homeWon;
        if (!sec.isDraw && secHomeWon === null) return { type: "wait", reason: "secondary final without a winner" };
        if (secHomeWon !== homeWon) {
          return {
            type: "block",
            reason: `providers disagree: ${primary.provider} says ${outcomeLabel(homeWon)} ` +
              `(${primary.homeScore}-${primary.awayScore}), ${sec.provider} says ${outcomeLabel(secHomeWon)} ` +
              `(${sec.homeScore}-${sec.awayScore})`,
          };
        }
      }
      return {
        type: "settle",
        homeWon,
        reason: `final ${primary.homeScore}-${primary.awayScore} (${primary.providerStatus || primary.statusLabel}) → ${outcomeLabel(homeWon)}`,
      };
    }
    case "postponed":
    case "cancelled":
      if (nowMs < graceEndMs) return { type: "wait", reason: `${primary.status}; refund after the grace window` };
      return { type: "settle", homeWon: null, reason: `${primary.status} past the grace window — refunding both sides` };
    case "pending":
      // A postponed game the provider has re-dated shows up as "scheduled" again. If
      // the new date is beyond the grace window, treat it like a postponement.
      if (typeof primary.startTimeMs === "number" && primary.startTimeMs > graceEndMs && nowMs >= graceEndMs) {
        return { type: "settle", homeWon: null, reason: "rescheduled beyond the grace window — refunding both sides" };
      }
      return { type: "wait", reason: `not final yet (${primary.statusLabel})` };
    default:
      return { type: "wait", reason: `unrecognized provider status (${primary.providerStatus || primary.statusLabel})` };
  }
}

// ── cross-provider event matching ────────────────────────────────────────────

const STOP_WORDS = new Set(["fc", "cf", "afc", "sc", "ac", "cd", "ud", "sd", "rc", "fk", "the", "club", "de", "calcio"]);

export function normalizeTeamName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP_WORDS.has(t))
    .join(" ");
}

/** Loose team-name equality across providers ("Manchester United FC" ≈ "Manchester United"). */
export function teamNamesMatch(a: string, b: string): boolean {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

export interface EventRef {
  homeTeam: string;
  awayTeam: string;
  startTimeMs: number;
}

/** Pick the one candidate with the same home/away teams starting within `toleranceMs`. Ambiguity → null. */
export function matchEvent<T extends EventRef>(ref: EventRef, candidates: readonly T[], toleranceMs = 6 * 60 * 60 * 1000): T | null {
  const hits = candidates.filter(
    (c) =>
      Math.abs(c.startTimeMs - ref.startTimeMs) <= toleranceMs &&
      teamNamesMatch(c.homeTeam, ref.homeTeam) &&
      teamNamesMatch(c.awayTeam, ref.awayTeam),
  );
  return hits.length === 1 ? hits[0] : null;
}
