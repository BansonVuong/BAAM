/**
 * Dev-only: every Ticket state from fixtures, at /?preview=tickets.
 * Imported lazily behind import.meta.env.DEV, so it never ships to production.
 */
import { useState } from "react";
import type { Bet } from "../../../lib/relayer";
import { Button } from "../primitives";
import { BetTicket, type BetActionHandlers } from "../ticket/BetTicket";
import { Ticket } from "../ticket/Ticket";
import type { Theme } from "../shell/AccountMenu";

const VIEWER = "maya";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const base: Bet = {
  id: "fx",
  type: "PERSONAL",
  challenger: "jordan",
  acceptor: "maya",
  terms: "Jordan makes every 5am lift Mon–Fri",
  stake: "0.25",
  currency: "SOL",
  status: "PENDING",
  witnesses: 2,
  minBettors: 2,
  groupSize: 4,
  resolveByDate: now + 4 * DAY,
  fallbackKind: "return",
};

const sig = "5h3Kq9xHkS2bQ8YVzE3sVJq7d1q7G4f3x2Wm6pZ1oT8yRk9N4cLb2uA7eD5vF6gH";

const FIXTURES: { title: string; bet: Bet }[] = [
  { title: "Offer addressed to you", bet: { ...base, id: "fx-offer-you", acceptByDate: now + 2 * DAY } },
  { title: "Open challenge", bet: { ...base, id: "fx-offer-open", challenger: "theo", acceptor: "anyone", terms: "Theo finishes the half marathon under 2 hours", stake: "1.5" } },
  { title: "Your offer, waiting", bet: { ...base, id: "fx-offer-mine", challenger: "maya", acceptor: "priya", terms: "No phone after 11pm for a week", fallbackKind: "charity", charityName: "City Food Bank" } },
  { title: "In play (you're in it)", bet: { ...base, id: "fx-live", status: "ACTIVE", acceptedBy: "maya", onChain: true, onChainState: "locked", createSig: sig, acceptSig: sig } },
  { title: "Witness: vote needed", bet: { ...base, id: "fx-vote", status: "ACTIVE", challenger: "priya", acceptor: "theo", acceptedBy: "theo", terms: "Priya reads 3 books this month" } },
  { title: "Witnesses deciding (you voted)", bet: { ...base, id: "fx-voted", status: "ACTIVE", challenger: "priya", acceptor: "theo", acceptedBy: "theo", terms: "Priya reads 3 books this month", votesByVoter: { maya: "challenger" } } },
  { title: "Witnesses split", bet: { ...base, id: "fx-split", status: "ACTIVE", challenger: "priya", acceptor: "theo", acceptedBy: "theo", witnesses: 3, terms: "Theo cooks dinner every night", votesByVoter: { jordan: "challenger", sam: "acceptor" } } },
  { title: "Sports, in play", bet: { ...base, id: "fx-sports", type: "DEV", validation: "sports", sport: "nba", status: "ACTIVE", homeTeam: "Lakers", awayTeam: "Celtics", challengerBacksHome: true, acceptedBy: "maya", terms: "NBA", stake: "0.5", onChain: true, onChainState: "locked", createSig: sig, acceptSig: sig.slice(0, -3) + "abc" } },
  { title: "Paying out", bet: { ...base, id: "fx-paying", status: "COMPLETED", resolvedWinner: "challenger", acceptedBy: "maya", onChain: true, onChainState: "locked" } },
  { title: "Paid (stamp)", bet: { ...base, id: "fx-paid", status: "COMPLETED", resolvedWinner: "acceptor", acceptedBy: "maya", onChain: true, onChainState: "settled", createSig: sig, acceptSig: sig, settleSig: sig.slice(0, -2) + "zz" } },
  { title: "Won (off-chain)", bet: { ...base, id: "fx-won", status: "COMPLETED", resolvedWinner: "challenger", acceptedBy: "maya" } },
  { title: "Refunded: no verdict", bet: { ...base, id: "fx-refund", status: "ACTIVE", acceptedBy: "maya", fallbackApplied: "return", onChain: true, onChainState: "settled" } },
  { title: "Refund pending", bet: { ...base, id: "fx-refund-pending", status: "ACTIVE", acceptedBy: "maya", fallbackApplied: "return", onChain: true, onChainState: "locked" } },
  { title: "Donated", bet: { ...base, id: "fx-donated", status: "ACTIVE", acceptedBy: "maya", fallbackKind: "charity", charityName: "City Food Bank", fallbackApplied: "charity", onChain: true, onChainState: "settled" } },
  { title: "Burned", bet: { ...base, id: "fx-burned", status: "ACTIVE", acceptedBy: "maya", fallbackKind: "burn", fallbackApplied: "burn" } },
  { title: "Fallback blocked", bet: { ...base, id: "fx-blocked", status: "ACTIVE", acceptedBy: "maya", fallbackKind: "burn", fallbackBlocked: true, onChain: true, onChainState: "locked" } },
  { title: "Expired offer", bet: { ...base, id: "fx-expired", offerExpired: true } },
  { title: "Sports refund (nobody took it)", bet: { ...base, id: "fx-cancel", type: "DEV", validation: "sports", sport: "nfl", homeTeam: "Chiefs", awayTeam: "Bills", challengerBacksHome: false, acceptor: "anyone", onChain: true, onChainState: "cancelled" } },
  { title: "Points (no explorer)", bet: { ...base, id: "fx-pts", currency: "PTS", stake: "500", status: "ACTIVE", acceptedBy: "maya", terms: "Maya beats Jordan at chess on Sunday" } },
];

const noopHandlers: BetActionHandlers = {
  accept: () => {},
  vote: () => {},
  isAccepting: () => false,
  isVoting: () => false,
};

export default function TicketPreview({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const [run, setRun] = useState(0);
  const [settled, setSettled] = useState(false);

  return (
    <main className="min-h-dvh bg-counter px-4 py-8 lg:px-10">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title font-bold wdth-title">Ticket states</h1>
          <span className="text-meta text-ink-soft">Dev preview. Viewer is {VIEWER}.</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => setRun((n) => n + 1)}>Replay stamps</Button>
            <Button size="sm" onClick={onToggleTheme}>{theme === "dark" ? "Light mode" : "Dark mode"}</Button>
          </div>
        </div>

        <section className="mt-8">
          <h2 className="mb-3 text-body font-bold">Settles while visible</h2>
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-full max-w-[520px]">
              <BetTicket
                key={`live-${run}`}
                bet={settled
                  ? { ...base, id: `fx-transition-${run}`, status: "COMPLETED", resolvedWinner: "challenger", acceptedBy: "maya", votesByVoter: { a: "challenger", b: "challenger" } }
                  : { ...base, id: `fx-transition-${run}`, status: "ACTIVE", acceptedBy: "maya", votesByVoter: { a: "challenger" } }}
                viewer={VIEWER}
                handlers={noopHandlers}
              />
            </div>
            <Button size="sm" onClick={() => setSettled((s) => !s)}>{settled ? "Reset" : "Settle it"}</Button>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="mb-3 text-body font-bold">Full</h2>
          <div className="grid gap-x-6 gap-y-8 md:grid-cols-2">
            {FIXTURES.map(({ title, bet }) => (
              <div key={bet.id} className="max-w-[520px]">
                <p className="mb-2 text-meta text-ink-soft">{title}</p>
                <BetTicket bet={{ ...bet, id: `${bet.id}-${run}` }} viewer={VIEWER} handlers={noopHandlers} context="Gym rats" />
              </div>
            ))}
            <div className="max-w-[520px]">
              <p className="mb-2 text-meta text-ink-soft">Slots: check-in progress + proof (upcoming)</p>
              <Ticket
                stock="verdict"
                terms="Jordan makes every 5am lift Mon–Fri"
                stake="500"
                currency="PTS"
                parties="jordan vs maya"
                details={["2 witnesses, decide by Fri"]}
                checkIn={{ done: 3, total: 5 }}
                proof={{ label: "View Thursday's proof", href: "#" }}
                status="Witnesses deciding: 1 of 2 votes"
                actions={[{ label: "Add proof", emphasis: "primary" }, { label: "Vote jordan" }]}
              />
            </div>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="mb-3 text-body font-bold">Compact</h2>
          <div className="grid max-w-[700px] gap-3 sm:grid-cols-2">
            {FIXTURES.map(({ bet }) => (
              <BetTicket key={bet.id} bet={{ ...bet, id: `${bet.id}-c-${run}` }} viewer={VIEWER} variant="compact" context="Gym rats" onOpen={() => {}} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
