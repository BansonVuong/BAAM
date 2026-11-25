import { useCallback, useMemo, useState, type ReactNode } from "react";
import { acceptBet, voteBet, type Bet, type BetVoteChoice } from "../../../lib/relayer";
import {
  applyVoteToBet,
  formatMoney,
  betCurrency,
  friendlyError,
  getVotesByVoter,
  isBetCompleted,
  isBetParticipant,
  opponentName,
} from "../../../lib/bets";
import { useBaamData } from "../../data";
import { Button, InlineError, Sheet } from "../primitives";
import type { BetActionHandlers } from "./BetTicket";

type Pending =
  | { kind: "accept"; bet: Bet }
  | { kind: "vote"; bet: Bet; choice: BetVoteChoice; name: string; isChange: boolean };

/**
 * Accept and vote flows with their confirmation sheets. Every view that shows
 * actionable tickets uses this so the flows behave the same everywhere.
 */
export function useBetActions(): { handlers: BetActionHandlers; dialogs: ReactNode } {
  const { user, upsertBet, refresh, refreshPoints, bets, openDetails, openProofSheet, openProfile } = useBaamData();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<Record<string, boolean>>({});
  const [voting, setVoting] = useState<Record<string, boolean>>({});

  const handlers = useMemo<BetActionHandlers>(() => ({
    accept: (bet) => {
      setError(null);
      setPending({ kind: "accept", bet });
    },
    vote: (bet, choice) => {
      if (isBetCompleted(bet) || bet.status !== "ACTIVE") return;
      if (isBetParticipant(bet, user.username)) return;
      const previous = getVotesByVoter(bet)[user.username];
      const name = choice === "challenger" ? bet.challenger : opponentName(bet) ?? bet.acceptor;
      setError(null);
      setPending({ kind: "vote", bet, choice, name, isChange: Boolean(previous && previous !== choice) });
    },
    isAccepting: (betId) => Boolean(accepting[betId]),
    isVoting: (betId) => Boolean(voting[betId]),
    addProof: (bet) => openProofSheet(bet.id, "proof"),
    checkIn: (bet) => openProofSheet(bet.id, "checkin"),
    openDetails: (bet, focus) => openDetails(bet.id, focus),
    openPerson: openProfile,
  }), [accepting, voting, user.username, openDetails, openProofSheet, openProfile]);

  const close = useCallback(() => {
    if (busy) return;
    setPending(null);
    setError(null);
  }, [busy]);

  async function confirm(): Promise<void> {
    if (!pending) return;
    const betId = pending.bet.id;
    setBusy(true);
    setError(null);
    if (pending.kind === "accept") {
      setAccepting((prev) => ({ ...prev, [betId]: true }));
      try {
        const { bet } = await acceptBet(betId);
        upsertBet(bet);
        setPending(null);
        void refresh();
        void refreshPoints();
      } catch (err) {
        setError(friendlyError(err, "Couldn't accept this bet. Try again."));
      } finally {
        setBusy(false);
        setAccepting((prev) => { const next = { ...prev }; delete next[betId]; return next; });
      }
      return;
    }

    const current = bets.find((bet) => bet.id === betId) ?? pending.bet;
    if (isBetCompleted(current)) {
      setBusy(false);
      setPending(null);
      return;
    }
    upsertBet(applyVoteToBet(current, user.username, pending.choice));
    setVoting((prev) => ({ ...prev, [betId]: true }));
    try {
      const { bet } = await voteBet({ betId, votedFor: pending.choice });
      upsertBet(bet);
      setPending(null);
    } catch (err) {
      upsertBet(current);
      setError(friendlyError(err, "Couldn't send your vote. Try again."));
    } finally {
      setBusy(false);
      setVoting((prev) => { const next = { ...prev }; delete next[betId]; return next; });
    }
  }

  let dialogs: ReactNode = null;
  if (pending?.kind === "accept") {
    const { bet } = pending;
    const money = formatMoney(bet.stake.replace(/\s*(sol|pts)\s*$/i, ""), betCurrency(bet));
    dialogs = (
      <Sheet
        open
        onOpenChange={(open) => { if (!open) close(); }}
        dismissible={!busy}
        size="sm"
        title="Accept this bet?"
        description={`You're taking ${bet.challenger}'s bet and putting in ${money}. It's held until the bet settles.`}
        footer={(
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => { void confirm(); }} disabled={busy}>
              {busy ? "Accepting…" : `Accept for ${money}`}
            </Button>
          </>
        )}
      >
        <p className="text-body font-semibold">{bet.terms}</p>
        {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      </Sheet>
    );
  } else if (pending?.kind === "vote") {
    dialogs = (
      <Sheet
        open
        onOpenChange={(open) => { if (!open) close(); }}
        dismissible={!busy}
        size="sm"
        title={pending.isChange ? "Change your vote?" : `Vote ${pending.name}?`}
        description={`Your vote goes to ${pending.name}. Once enough witnesses agree, the bet settles and the winner is paid.`}
        footer={(
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => { void confirm(); }} disabled={busy}>
              {busy ? "Voting…" : `Vote ${pending.name}`}
            </Button>
          </>
        )}
      >
        <p className="text-body font-semibold">{pending.bet.terms}</p>
        {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      </Sheet>
    );
  }

  return { handlers, dialogs };
}
