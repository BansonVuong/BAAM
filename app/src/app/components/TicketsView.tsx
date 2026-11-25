import { useMemo, useState } from "react";
import type { Bet } from "../../lib/relayer";
import { betTimestamp, getVotesByVoter, isBetParticipant } from "../../lib/bets";
import { useBaamData } from "../data";
import { Button, EmptyState, ScreenTitle } from "./primitives";
import { BetTicket, bucketForBet, type TicketBucket } from "./ticket/BetTicket";
import { useBetActions } from "./ticket/useBetActions";
import { TicketSheet } from "./ticket/TicketSheet";

const SECTIONS: { bucket: TicketBucket; title: string; hint: string }[] = [
  { bucket: "needs-you", title: "Needs you", hint: "Accept a challenge or cast your vote." },
  { bucket: "offer", title: "Waiting for a taker", hint: "Posted, not accepted yet." },
  { bucket: "live", title: "In play", hint: "Both sides are in." },
  { bucket: "verdict", title: "Witnesses deciding", hint: "Votes are coming in." },
  { bucket: "done", title: "Settled", hint: "Paid, refunded or expired." },
];

const SETTLED_PREVIEW = 6;

/** Bets the viewer is on, can act on, or has voted on. */
export function useMyBets(): { bet: Bet; bucket: TicketBucket }[] {
  const { bets, user, betGroupIds, groups } = useBaamData();
  return useMemo(() => {
    const myGroupIds = new Set(groups.map((g) => g.id));
    return bets
      .map((bet) => ({ bet, bucket: bucketForBet(bet, user.username) }))
      .filter(({ bet, bucket }) => {
        if (bet.source === "imessage") return isBetParticipant(bet, user.username);
        if (isBetParticipant(bet, user.username)) return true;
        if (getVotesByVoter(bet)[user.username]) return true;
        if (bucket !== "needs-you") return false;
        const groupId = bet.groupId ?? betGroupIds[bet.id];
        return !groupId || myGroupIds.has(groupId);
      })
      .sort((a, b) => betTimestamp(b.bet) - betTimestamp(a.bet));
  }, [bets, user.username, betGroupIds, groups]);
}

export function TicketsView({
  onOpenBetChat,
  onGoToChats,
}: {
  onOpenBetChat: (groupId: string, betId: string) => void;
  onGoToChats: () => void;
}) {
  const { user, groups, betGroupIds, loaded, error } = useBaamData();
  const { handlers, dialogs } = useBetActions();
  const mine = useMyBets();
  const [showAllSettled, setShowAllSettled] = useState(false);
  const [sheetBetId, setSheetBetId] = useState<string | null>(null);
  const groupName = (bet: Bet) => {
    const id = bet.groupId ?? betGroupIds[bet.id];
    return id ? groups.find((g) => g.id === id)?.name : undefined;
  };
  const groupIdFor = (bet: Bet) => {
    const id = bet.groupId ?? betGroupIds[bet.id];
    return id && groups.some((g) => g.id === id) ? id : null;
  };
  const sheetBet = mine.find((entry) => entry.bet.id === sheetBetId)?.bet ?? null;

  return (
    <div className="max-w-[760px] px-4 py-5 lg:px-10 lg:py-8">
      <div className="hidden lg:block">
        <ScreenTitle>Tickets</ScreenTitle>
        <p className="mt-1 text-label text-ink-soft">Every bet you're in, by where it stands.</p>
      </div>

      {!loaded && <p className="py-6 text-label text-ink-soft">Loading your tickets…</p>}
      {loaded && error && mine.length === 0 && <p className="py-6 text-label text-danger" role="alert">{error}</p>}
      {loaded && !error && mine.length === 0 && (
        <EmptyState
          title="You're not in any bets yet."
          body="Open a chat and start one with New bet. Every bet you post, take or witness shows up here."
          action={<Button variant="primary" onClick={onGoToChats}>Go to chats</Button>}
        />
      )}

      {SECTIONS.map(({ bucket, title, hint }) => {
        const entries = mine.filter((entry) => entry.bucket === bucket);
        if (entries.length === 0) return null;
        const settled = bucket === "done";
        const shown = settled && !showAllSettled ? entries.slice(0, SETTLED_PREVIEW) : entries;
        return (
          <section key={bucket} className="mt-8 first-of-type:mt-6 lg:first-of-type:mt-8" aria-labelledby={`tickets-${bucket}`}>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 id={`tickets-${bucket}`} className="text-body font-bold">{title}</h2>
              <span className="text-label text-ink-soft">{entries.length}</span>
              <span className="ml-auto hidden text-meta text-ink-soft sm:inline">{hint}</span>
            </div>
            <ul className={settled ? "space-y-3" : "space-y-4"}>
              {shown.map(({ bet }) => {
                const groupId = groupIdFor(bet);
                return (
                  <li key={bet.id}>
                    <BetTicket
                      bet={bet}
                      viewer={user.username}
                      handlers={handlers}
                      variant={settled ? "compact" : "full"}
                      context={groupName(bet)}
                      onOpen={settled
                        ? () => setSheetBetId(bet.id)
                        : groupId ? () => onOpenBetChat(groupId, bet.id) : undefined}
                      openLabel={settled ? `Open bet: ${bet.terms}` : `Open in ${groupName(bet) ?? "chat"}: ${bet.terms}`}
                    />
                  </li>
                );
              })}
            </ul>
            {settled && entries.length > SETTLED_PREVIEW && (
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => setShowAllSettled((v) => !v)}>
                {showAllSettled ? "Show fewer" : `Show all ${entries.length}`}
              </Button>
            )}
          </section>
        );
      })}

      <TicketSheet
        bet={sheetBet}
        viewer={user.username}
        handlers={handlers}
        groupName={sheetBet ? groupName(sheetBet) : undefined}
        onOpenChat={sheetBet && groupIdFor(sheetBet)
          ? () => { const id = groupIdFor(sheetBet)!; setSheetBetId(null); onOpenBetChat(id, sheetBet.id); }
          : undefined}
        onClose={() => setSheetBetId(null)}
      />
      {dialogs}
    </div>
  );
}
