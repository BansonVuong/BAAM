/**
 * Dev-only: every Ticket state from fixtures, at /?preview=tickets.
 * Imported lazily behind import.meta.env.DEV, so it never ships to production.
 */
import { useState } from "react";
import type { Bet, CheckinOccurrenceState, CheckinProgress, ProofSummary } from "../../../lib/relayer";
import { Button } from "../primitives";
import { BetTicket, type BetActionHandlers } from "../ticket/BetTicket";
import { Ticket } from "../ticket/Ticket";
import { BetDetails } from "../ticket/BetDetails";
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

// A tiny inline "photo" so the proof thumbnail renders without a server.
const PROOF_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="#9FE7C4"/>'
  + '<circle cx="88" cy="26" r="12" fill="#FFD84D"/><path d="M0 90 L38 44 L62 70 L84 52 L120 90Z" fill="#1A1D35"/></svg>',
)}`;

function proofFixture(uploader: string, caption: string, checkinId: string | null = null): ProofSummary {
  return {
    id: `proof-${uploader}-${caption.length}`,
    uploader,
    createdAt: now - 3 * 60 * 60 * 1000,
    checkinId,
    caption,
    link: null,
    image: { url: PROOF_IMAGE, contentType: "image/svg+xml", bytes: 300 },
  };
}

const habitSchedule = {
  daysOfWeek: [1, 3, 5],
  timezone: "America/New_York",
  startDate: new Date(now - 7 * DAY).toISOString().slice(0, 10),
  endDate: new Date(now + 6 * DAY).toISOString().slice(0, 10),
  windowStart: "05:00",
  windowEnd: "08:00",
};

function progressFixture(doer: string, states: CheckinOccurrenceState[]): CheckinProgress {
  const occurrences = states.map((state, index) => {
    const start = now + (index - states.indexOf("open")) * 2 * DAY - 60 * 60 * 1000;
    const date = new Date(start);
    return {
      key: date.toISOString().slice(0, 10),
      start,
      end: start + 3 * 60 * 60 * 1000,
      state,
      checkinId: state === "submitted" ? "chk-1" : null,
    };
  });
  const approved = states.filter((s) => s === "approved").length;
  const open = occurrences.find((o) => o.state === "open") ?? null;
  return {
    schedule: habitSchedule,
    doer: "challenger",
    doerUsername: doer,
    required: 5,
    total: states.length,
    approved,
    possible: approved + states.filter((s) => s === "open" || s === "upcoming" || s === "submitted").length,
    submitted: states.filter((s) => s !== "upcoming" && s !== "open" && s !== "missed").length,
    pendingReview: states.filter((s) => s === "submitted").length,
    verdictDeadline: now + 8 * DAY,
    currentWindow: open ? { key: open.key, start: open.start, end: open.end } : null,
    nextWindow: occurrences.find((o) => o.state === "upcoming") ?? null,
    occurrences,
    decision: { winner: null, reason: "in-progress" },
    verdictReason: null,
  };
}

const habitBase: Bet = {
  ...base,
  currency: "PTS",
  stake: "300",
  status: "ACTIVE",
  acceptedBy: "maya",
  terms: "Jordan is at the gym by 8am Mon, Wed, Fri",
  schedule: habitSchedule,
  requiredCheckins: 5,
  doer: "challenger",
  resolveByDate: now + 8 * DAY,
};

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
  { title: "Points offer to you", bet: { ...base, id: "fx-pts-offer", currency: "PTS", stake: "250", terms: "Jordan runs a sub-25 5K by Saturday" } },
  { title: "Points: paying out", bet: { ...base, id: "fx-pts-paying", currency: "PTS", stake: "500", status: "COMPLETED", resolvedWinner: "acceptor", acceptedBy: "maya", pointsState: "held" } as Bet },
  { title: "Points: paid (stamp)", bet: { ...base, id: "fx-pts-paid", currency: "PTS", stake: "500", status: "COMPLETED", resolvedWinner: "acceptor", acceptedBy: "maya", pointsState: "settled" } as Bet },
  { title: "Points: refunded, no verdict", bet: { ...base, id: "fx-pts-refund", currency: "PTS", stake: "300", status: "ACTIVE", acceptedBy: "maya", fallbackApplied: "return", pointsState: "refunded" } as Bet },
  { title: "Proof attached (you can add more)", bet: { ...base, id: "fx-proof", currency: "PTS", stake: "400", status: "ACTIVE", acceptedBy: "maya", terms: "Maya hits 10,000 steps every day this week", proofCount: 2, proofs: [proofFixture("maya", "Sunday's walk, 11,240 steps")], viewerActions: { canAddProof: true, canCheckin: false, canReview: false, canVote: false } } },
  { title: "Habit: preview before posting", bet: { ...habitBase, id: "fx-habit-pending", status: "PENDING", acceptedBy: undefined } },
  { title: "Habit: your turn to check in", bet: { ...habitBase, id: "fx-habit-you", challenger: "maya", acceptor: "jordan", acceptedBy: "jordan", checkinProgress: progressFixture("maya", ["approved", "approved", "missed", "open", "upcoming", "upcoming"]), viewerActions: { canAddProof: true, canCheckin: true, canReview: false, canVote: false } } },
  { title: "Habit: review a check-in (witness)", bet: { ...habitBase, id: "fx-habit-review", challenger: "priya", acceptor: "theo", acceptedBy: "theo", terms: "Priya meditates 10 minutes every morning", checkinProgress: progressFixture("priya", ["approved", "approved", "submitted", "upcoming", "upcoming", "upcoming"]), proofCount: 1, proofs: [proofFixture("priya", "Morning sit, 10:04", "chk-1")], viewerActions: { canAddProof: false, canCheckin: false, canReview: true, canVote: false } } },
  { title: "Habit: kept it up (stamp)", bet: { ...habitBase, id: "fx-habit-won", status: "COMPLETED", resolvedWinner: "challenger", pointsState: "settled", checkinProgress: { ...progressFixture("jordan", ["approved", "approved", "approved", "approved", "approved", "missed"]), decision: { winner: "doer", reason: "5/5 required check-ins approved" } } } as Bet },
];

const noopHandlers: BetActionHandlers = {
  accept: () => {},
  vote: () => {},
  isAccepting: () => false,
  isVoting: () => false,
  addProof: () => {},
  checkIn: () => {},
  openDetails: () => {},
  openPerson: () => {},
};

const DETAILS_FIXTURES = FIXTURES.filter(({ bet }) => bet.id === "fx-habit-review" || bet.id === "fx-habit-you");

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
              <p className="mb-2 text-meta text-ink-soft">Slots: check-in progress + proof thumbnail</p>
              <Ticket
                stock="verdict"
                terms="Jordan makes every 5am lift Mon–Fri"
                stake="500"
                currency="PTS"
                parties="jordan vs maya"
                details={["Weekdays for 1 week, between 5 AM and 6 AM"]}
                checkIn={{ done: 3, total: 5, openLabel: "See days", onOpen: () => {} }}
                proof={{ label: "2 proofs", thumbnailUrl: PROOF_IMAGE, thumbnailAlt: "Proof from jordan", onOpen: () => {} }}
                status="Jordan checked in. Witnesses are reviewing."
                actions={[{ label: "Add proof" }]}
              />
            </div>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="mb-3 text-body font-bold">Full ticket sheet contents</h2>
          <div className="grid gap-x-6 gap-y-8 md:grid-cols-2">
            {DETAILS_FIXTURES.map(({ title, bet }) => (
              <div key={bet.id} className="max-w-[520px] rounded-[20px] bg-paper p-5">
                <p className="mb-2 text-meta text-ink-soft">{title}</p>
                <BetTicket bet={bet} viewer={VIEWER} handlers={{ ...noopHandlers, openDetails: undefined }} />
                <BetDetails
                  bet={{
                    ...bet,
                    checkins: bet.id === "fx-habit-review"
                      ? [{
                          id: "chk-1", occurrenceKey: bet.checkinProgress!.occurrences[2]!.key,
                          occurrenceStart: now - DAY, occurrenceEnd: now - DAY + 3 * 60 * 60 * 1000,
                          doer: "priya", submittedAt: now - DAY + 60 * 60 * 1000, caption: "Morning sit, 10:04",
                          proofIds: [bet.proofs![0]!.id], status: "pending",
                          reviews: [{ reviewer: "sam", approve: true, at: now - 2 * 60 * 60 * 1000 }],
                          approvals: 1, rejections: 0, decidedAt: null,
                        }]
                      : [],
                  }}
                  viewer={VIEWER}
                  onChanged={() => {}}
                />
              </div>
            ))}
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
