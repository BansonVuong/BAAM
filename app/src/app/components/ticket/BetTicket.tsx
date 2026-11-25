/** Maps a relayer Bet onto the Ticket component. No visuals live here. */
import type { Bet, BetVoteChoice } from "../../../lib/relayer";
import { explorerTxUrl } from "../../../lib/relayer";
import {
  betCurrency,
  canAcceptBet,
  canVoteOnBet,
  countVotes,
  formatDeadline,
  getVotesByVoter,
  isBetCompleted,
  isOfferPastDeadline,
  isOpenChallenge,
  opponentName,
  sameName,
  winnerName,
  witnessThreshold,
} from "../../../lib/bets";
import { Ticket, type TicketAction, type TicketLink, type TicketProps } from "./Ticket";

export interface BetActionHandlers {
  accept: (bet: Bet) => void;
  vote: (bet: Bet, choice: BetVoteChoice) => void;
  isAccepting: (betId: string) => boolean;
  isVoting: (betId: string) => boolean;
}

export const SPORT_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", nhl: "NHL", soccer: "Soccer",
};

type TicketModel = Omit<TicketProps, "variant" | "context" | "onOpen" | "highlighted" | "className">;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function fallbackLine(bet: Bet): string | null {
  if (bet.validation === "sports") return null;
  switch (bet.fallbackKind) {
    case "burn": return "No verdict by then: the pot is burned";
    case "charity": return `No verdict by then: the pot goes to ${bet.charityName ?? "charity"}`;
    case "return": return "No verdict by then: everyone gets their stake back";
    default: return null;
  }
}

function explorerLinks(bet: Bet): TicketLink[] {
  if (!bet.onChain) return [];
  const links: TicketLink[] = [];
  if (bet.createSig && bet.createSig === bet.acceptSig) {
    links.push({ label: "Escrow", href: explorerTxUrl(bet.createSig) });
  } else {
    if (bet.createSig) links.push({ label: "Stake", href: explorerTxUrl(bet.createSig) });
    if (bet.acceptSig) links.push({ label: "Match", href: explorerTxUrl(bet.acceptSig) });
  }
  if (bet.settleSig) links.push({ label: "Payout", href: explorerTxUrl(bet.settleSig) });
  return links;
}

/** Turns a bet into everything a Ticket needs, in plain words, from the viewer's side. */
export function describeBet(
  bet: Bet,
  viewer: string,
  handlers?: BetActionHandlers,
  now = Date.now(),
): TicketModel {
  const who = (name: string) => (sameName(name, viewer) ? "you" : name);
  const isSports = bet.validation === "sports";
  const currency = betCurrency(bet);
  const stake = bet.stake.replace(/\s*(sol|pts|points)\s*$/i, "").trim();
  const opponent = opponentName(bet);
  const challenger = who(bet.challenger);
  const links = explorerLinks(bet);

  // Terms + parties
  let terms = bet.terms;
  let parties = `${challenger} vs ${opponent ? who(opponent) : "anyone"}`;
  if (isSports && bet.homeTeam && bet.awayTeam) {
    terms = `${bet.awayTeam} at ${bet.homeTeam}`;
    const backsHome = bet.challengerBacksHome ?? true;
    const mine = backsHome ? bet.homeTeam : bet.awayTeam;
    const theirs = backsHome ? bet.awayTeam : bet.homeTeam;
    const verb = (name: string) => (name === "you" ? "back" : "backs");
    parties = `${challenger} ${verb(challenger)} ${mine}`
      + (opponent ? `, ${who(opponent)} ${who(opponent) === "you" ? "have" : "has"} ${theirs}` : "");
  }

  // Details
  const details: string[] = [];
  if (isSports) {
    details.push(`${SPORT_LABELS[bet.sport ?? ""] ?? "Sports"}: the final score decides`);
  } else {
    const witnesses = witnessThreshold(bet);
    details.push(typeof bet.resolveByDate === "number"
      ? `${plural(witnesses, "witness", "witnesses")}, decide by ${formatDeadline(bet.resolveByDate, now)}`
      : `${plural(witnesses, "witness", "witnesses")} decide`);
    if (bet.status === "PENDING" && typeof bet.acceptByDate === "number") {
      details.push(`Accept by ${formatDeadline(bet.acceptByDate, now)}`);
    }
    if (!isBetCompleted(bet)) {
      const fallback = fallbackLine(bet);
      if (fallback) details.push(fallback);
    }
  }

  const base = { id: bet.id, terms, stake, currency, parties, details, links } as const;

  // ── Terminal and no-verdict states ────────────────────────────────────────
  if (bet.offerExpired || isOfferPastDeadline(bet, now)) {
    return {
      ...base, stock: "done", status: "Expired: nobody accepted",
      stamp: { text: "Expired", tone: "neutral" }, settledFrom: "offer",
    };
  }
  if (bet.fallbackBlocked) {
    const kind = bet.fallbackKind === "charity" ? "donation" : bet.fallbackKind === "burn" ? "burn" : "refund";
    return {
      ...base, stock: "done",
      status: `No verdict by the deadline. The ${kind} is waiting on an operator; stakes are still held.`,
    };
  }
  if (bet.fallbackApplied) {
    const settled = !bet.onChain || bet.onChainState === "settled";
    const charity = bet.charityName ?? "charity";
    if (!settled) {
      const pending = bet.fallbackApplied === "burn"
        ? "Burning the pot"
        : bet.fallbackApplied === "charity" ? `Sending the pot to ${charity}` : "Refunding stakes";
      return { ...base, stock: "done", status: `${pending}: no verdict by the deadline` };
    }
    const done = bet.fallbackApplied === "burn"
      ? { stamp: "Burned", status: "Burned: no verdict by the deadline" }
      : bet.fallbackApplied === "charity"
        ? { stamp: "Donated", status: `Donated to ${charity}: no verdict by the deadline` }
        : { stamp: "Refunded", status: "Refunded: no verdict by the deadline" };
    return {
      ...base, stock: "done", status: done.status,
      stamp: { text: done.stamp, tone: "neutral" }, settledFrom: "verdict",
    };
  }

  const winner = winnerName(bet);
  if (winner) {
    const name = who(winner);
    if (bet.onChain && bet.onChainState !== "settled") {
      return { ...base, stock: "verdict", status: `${name === "you" ? "You" : name} won. Paying out now.` };
    }
    return {
      ...base,
      stock: "done",
      status: bet.onChain ? `Paid to ${name}` : `${name === "you" ? "You" : name} won`,
      stamp: { text: bet.onChain ? `Paid to ${name}` : `${name} won`, tone: "win" },
      settledFrom: isSports ? "live" : "verdict",
    };
  }
  if (bet.onChainState === "cancelled") {
    return {
      ...base, stock: "done",
      status: isSports ? "Refunded: nobody took it before kickoff" : "Refunded",
      stamp: { text: "Refunded", tone: "neutral" }, settledFrom: "offer",
    };
  }
  if (bet.status === "COMPLETED" || bet.status === "RESOLVED") {
    return {
      ...base, stock: "done", status: "Settled with no winner",
      stamp: { text: "Void", tone: "neutral" }, settledFrom: "verdict",
    };
  }

  // ── Open offer ────────────────────────────────────────────────────────────
  if (bet.status === "PENDING") {
    const open = isOpenChallenge(bet);
    const accepting = handlers?.isAccepting(bet.id) ?? false;
    const acceptable = canAcceptBet(bet, viewer, now);
    let status: string;
    if (acceptable) {
      status = open ? "Open challenge: anyone here can take it" : "Waiting for you to accept";
    } else {
      status = open ? "Open challenge: waiting for a taker" : `Waiting for ${who(bet.acceptor)} to accept`;
    }
    if (isSports && acceptable) status = `${status}, before kickoff`;
    const actions: TicketAction[] = acceptable && handlers
      ? [{ label: "Accept", emphasis: "primary", onClick: () => handlers.accept(bet) }]
      : [];
    return { ...base, stock: "offer", status, actions, busyLabel: accepting ? "Accepting…" : null };
  }

  // ── In play / witnesses deciding ──────────────────────────────────────────
  if (isSports) {
    return { ...base, stock: "live", status: "In play: settles from the final score" };
  }
  if (bet.onChain && bet.currency === "SOL" && bet.onChainState !== "locked") {
    return { ...base, stock: "live", status: "Locking both stakes" };
  }
  if (typeof bet.resolveByDate === "number" && now >= bet.resolveByDate) {
    return { ...base, stock: "verdict", status: "Deadline passed: settling now" };
  }

  const votes = countVotes(bet);
  const threshold = witnessThreshold(bet);
  let status: string;
  if (votes.total === 0) {
    status = "In play";
  } else if (votes.challenger === 0 || votes.acceptor === 0) {
    status = `Witnesses deciding: ${Math.max(votes.challenger, votes.acceptor)} of ${threshold} votes`;
  } else {
    status = `Witnesses deciding: ${votes.challenger} to ${votes.acceptor}, ${threshold} needed`;
  }

  const actions: TicketAction[] = [];
  if (handlers && canVoteOnBet(bet, viewer, now)) {
    if (votes.total === 0) status = "In play: you're a witness";
    const mine = getVotesByVoter(bet)[viewer];
    const voting = handlers.isVoting(bet.id);
    const sides: { choice: BetVoteChoice; name: string }[] = [
      { choice: "challenger", name: bet.challenger },
      { choice: "acceptor", name: opponent ?? bet.acceptor },
    ];
    for (const side of sides) {
      const pressed = mine === side.choice;
      actions.push({
        label: pressed ? `Voted ${side.name}` : mine ? `Change to ${side.name}` : `Vote ${side.name}`,
        emphasis: mine ? "plain" : "primary",
        pressed,
        disabled: voting || pressed,
        onClick: () => handlers.vote(bet, side.choice),
      });
    }
    return {
      ...base,
      stock: votes.total === 0 ? "live" : "verdict",
      status,
      actions,
      busyLabel: voting ? "Sending your vote…" : null,
    };
  }

  return { ...base, stock: votes.total === 0 ? "live" : "verdict", status };
}

export function BetTicket({
  bet,
  viewer,
  handlers,
  variant = "full",
  context,
  onOpen,
  openLabel,
  highlighted,
  className,
}: {
  bet: Bet;
  viewer: string;
  handlers?: BetActionHandlers;
  variant?: "full" | "compact";
  context?: string;
  onOpen?: () => void;
  openLabel?: string;
  highlighted?: boolean;
  className?: string;
}) {
  const model = describeBet(bet, viewer, handlers);
  return (
    <Ticket
      {...model}
      variant={variant}
      context={context}
      onOpen={onOpen}
      openLabel={openLabel}
      highlighted={highlighted}
      className={className}
    />
  );
}

/** Which group heading a bet belongs under in lists. */
export type TicketBucket = "needs-you" | "offer" | "live" | "verdict" | "done";

export function bucketForBet(bet: Bet, viewer: string, now = Date.now()): TicketBucket {
  if (canAcceptBet(bet, viewer, now)) return "needs-you";
  if (canVoteOnBet(bet, viewer, now) && !getVotesByVoter(bet)[viewer]) return "needs-you";
  const stock = describeBet(bet, viewer, undefined, now).stock;
  return stock;
}
