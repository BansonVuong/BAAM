/**
 * Pure bet-state helpers shared by every view. These mirror the relayer's
 * rules (see relayer/index.ts) so the UI can predict outcomes optimistically.
 */
import type { Bet, BetVoteChoice } from "./relayer";

export function normalizeName(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/^@/, "").toLowerCase();
}

export function sameName(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeName(a);
  return Boolean(left) && left === normalizeName(b);
}

export function toInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "NA";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

export function getVotesByVoter(bet: Bet): Record<string, BetVoteChoice> {
  return bet.votesByVoter ?? {};
}

export function countVotes(bet: Bet): { challenger: number; acceptor: number; total: number } {
  let challenger = 0;
  let acceptor = 0;
  for (const vote of Object.values(getVotesByVoter(bet))) {
    if (vote === "challenger") challenger += 1;
    if (vote === "acceptor") acceptor += 1;
  }
  return { challenger, acceptor, total: challenger + acceptor };
}

export function witnessThreshold(bet: Bet): number {
  return Math.max(1, Number(bet.witnesses) || 1);
}

/** True when the bet ended without a verdict (fallback ran, is blocked, or offer expired). */
export function hasNoVerdictOutcome(bet: Bet): boolean {
  return Boolean(bet.fallbackApplied || bet.fallbackBlocked || bet.offerExpired);
}

export function getResolvedWinner(bet: Bet): BetVoteChoice | undefined {
  if (bet.status === "PENDING") return undefined;
  // No-verdict outcomes (fallback/expiry) are final; late votes never make a winner.
  if (hasNoVerdictOutcome(bet)) return undefined;
  if (bet.resolvedWinner) return bet.resolvedWinner;
  const votes = countVotes(bet);
  const threshold = witnessThreshold(bet);
  if (votes.challenger >= threshold) return "challenger";
  if (votes.acceptor >= threshold) return "acceptor";
  return undefined;
}

export function isBetCompleted(bet: Bet): boolean {
  return bet.status === "COMPLETED"
    || bet.status === "RESOLVED"
    || Boolean(getResolvedWinner(bet))
    || hasNoVerdictOutcome(bet);
}

export function isBetParticipant(bet: Bet, username: string): boolean {
  if (!normalizeName(username)) return false;
  return [bet.challenger, bet.acceptor, bet.acceptedBy, bet.opponentUsername]
    .some((name) => typeof name === "string" && sameName(name, username));
}

export function isOpenChallenge(bet: Bet): boolean {
  return normalizeName(bet.acceptor) === "anyone";
}

/** The person on the other side of the challenger, once known. */
export function opponentName(bet: Bet): string | null {
  const accepted = bet.acceptedBy?.trim() || bet.opponentUsername?.trim();
  if (accepted) return accepted;
  if (!isOpenChallenge(bet)) return bet.acceptor;
  return null;
}

export function winnerName(bet: Bet): string | null {
  const winner = getResolvedWinner(bet);
  if (!winner) return null;
  if (winner === "challenger") return bet.challenger;
  return opponentName(bet) ?? bet.acceptor;
}

/** Earliest accept deadline for a pending witness bet (accept-by, else resolve-by). */
export function acceptDeadline(bet: Bet): number | null {
  return [bet.acceptByDate, bet.resolveByDate]
    .filter((v): v is number => typeof v === "number")
    .reduce<number | null>((min, v) => (min === null || v < min ? v : min), null);
}

export function isOfferPastDeadline(bet: Bet, now = Date.now()): boolean {
  if (bet.status !== "PENDING" || bet.validation === "sports") return false;
  const deadline = acceptDeadline(bet);
  return deadline !== null && now >= deadline;
}

export function canAcceptBet(bet: Bet, viewer: string, now = Date.now()): boolean {
  if (bet.status !== "PENDING" || bet.offerExpired) return false;
  if (isOfferPastDeadline(bet, now)) return false;
  if (sameName(bet.challenger, viewer)) return false;
  return isOpenChallenge(bet) || sameName(bet.acceptor, viewer);
}

export function canVoteOnBet(bet: Bet, viewer: string, now = Date.now()): boolean {
  if (bet.validation === "sports") return false;
  if (bet.status !== "ACTIVE" || isBetCompleted(bet)) return false;
  if (isBetParticipant(bet, viewer)) return false;
  if (bet.onChain && bet.currency === "SOL" && bet.onChainState !== "locked") return false;
  if (typeof bet.resolveByDate === "number" && now >= bet.resolveByDate) return false;
  return true;
}

export function applyVoteToBet(bet: Bet, voter: string, votedFor: BetVoteChoice): Bet {
  if (isBetCompleted(bet) || bet.status !== "ACTIVE") return bet;
  const nextBet: Bet = {
    ...bet,
    votesByVoter: { ...getVotesByVoter(bet), [voter]: votedFor },
  };
  const winner = getResolvedWinner(nextBet);
  return { ...nextBet, status: winner ? "COMPLETED" : bet.status, resolvedWinner: winner };
}

export function betTimestamp(bet: Bet): number {
  if (typeof bet.createdAt === "number" && Number.isFinite(bet.createdAt)) return bet.createdAt;
  if (typeof bet.acceptedAt === "number" && Number.isFinite(bet.acceptedAt)) return bet.acceptedAt;
  const match = /^bet-(\d+)-/.exec(bet.id);
  const parsed = match?.[1] ? Number(match[1]) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseStakeAmount(stake: string): number {
  const amount = Number.parseFloat(stake.replace(/[^\d.-]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

export type TicketCurrency = "SOL" | "PTS";

export function betCurrency(bet: Bet): TicketCurrency {
  const value = bet.currency.trim().toUpperCase();
  return value === "PTS" || value === "POINTS" ? "PTS" : "SOL";
}

/** "0.25 SOL", "500 pts". */
export function formatMoney(amount: string | number, currency: TicketCurrency): string {
  const text = typeof amount === "number" ? formatAmount(amount, currency) : amount.trim();
  return currency === "PTS" ? `${text} pts` : `${text} SOL`;
}

export function formatAmount(value: number, currency: TicketCurrency): string {
  if (currency === "PTS") return Math.round(value).toLocaleString();
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function formatSignedMoney(value: number, currency: TicketCurrency): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatMoney(formatAmount(Math.abs(value), currency), currency)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Short, friendly deadline: "today 5 PM", "Fri", "Dec 3". */
export function formatDeadline(timestampMs: number, now = Date.now()): string {
  const date = new Date(timestampMs);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayOffset = Math.floor((timestampMs - startOfToday) / DAY_MS);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dayOffset === 0) return `today ${time}`;
  if (dayOffset === 1) return `tomorrow ${time}`;
  if (dayOffset > 1 && dayOffset < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

const MIN_REAL_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

export function formatClock(timestampMs: number | undefined, fallback: string): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs < MIN_REAL_TIMESTAMP_MS) {
    return fallback;
  }
  return new Date(timestampMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Chat-list style time: clock for today, weekday this week, else short date. */
export function formatListTime(timestampMs: number | undefined, fallback: string, now = Date.now()): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs < MIN_REAL_TIMESTAMP_MS) {
    return fallback;
  }
  const age = now - timestampMs;
  if (age < DAY_MS && new Date(timestampMs).getDate() === new Date(now).getDate()) {
    return formatClock(timestampMs, fallback);
  }
  if (age < 6 * DAY_MS) return new Date(timestampMs).toLocaleDateString([], { weekday: "short" });
  return new Date(timestampMs).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Strip transport noise from relayer error messages so people see a plain sentence. */
export function friendlyError(err: unknown, fallback = "Something went wrong. Try again."): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;
  if (/timed out/i.test(raw)) return "BAAM took too long to answer. Check your connection and try again.";
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "Couldn't reach BAAM. Check your connection and try again.";
  }
  if (/^relayer \d+$/.test(raw)) return fallback;
  const funds = /insufficient SOL: requires ([\d.]+) SOL, available ([\d.]+) SOL/i.exec(raw);
  if (funds) {
    return `Not enough SOL in the wallet. This needs ${Number(funds[1])} SOL (stake plus fees) and there's ${Number(funds[2])} SOL. Add SOL, then try again.`;
  }
  const cleaned = raw.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).replace(/([^.!?])$/, "$1.");
}
