import { useBaamData } from "../../data";
import { TicketSheet } from "../ticket/TicketSheet";
import { ProofSheet } from "../ticket/ProofSheet";
import { useBetActions } from "../ticket/useBetActions";

/**
 * App-wide sheets opened from any ticket: the full ticket (proof gallery, day
 * strip, check-in reviews) and the Add proof / Check in picker.
 */
export function BetOverlays({ onOpenBetChat, openChatId }: {
  onOpenBetChat: (groupId: string, betId: string) => void;
  /** The chat on screen right now; "Open the chat" is hidden for its bets. */
  openChatId: string | null;
}) {
  const {
    user, bets, groups, betGroupIds, details, closeDetails, proofTarget, closeProofSheet, refresh, refreshPoints,
  } = useBaamData();
  const { handlers, dialogs } = useBetActions();

  const detailsBet = details ? bets.find((bet) => bet.id === details.betId) ?? null : null;
  const proofBet = proofTarget ? bets.find((bet) => bet.id === proofTarget.betId) ?? null : null;
  const groupIdFor = (betId: string, groupId?: string) => {
    const id = groupId ?? betGroupIds[betId];
    return id && groups.some((g) => g.id === id) ? id : null;
  };
  const chatId = detailsBet ? groupIdFor(detailsBet.id, detailsBet.groupId) : null;
  const groupName = chatId ? groups.find((g) => g.id === chatId)?.name : undefined;

  return (
    <>
      <TicketSheet
        bet={detailsBet}
        viewer={user.username}
        handlers={handlers}
        groupName={groupName}
        focus={details?.focus}
        onOpenChat={detailsBet && chatId && chatId !== openChatId
          ? () => { closeDetails(); onOpenBetChat(chatId, detailsBet.id); }
          : undefined}
        onChanged={() => { void refresh(); void refreshPoints(); }}
        onClose={closeDetails}
      />
      <ProofSheet
        bet={proofBet}
        mode={proofTarget?.mode ?? "proof"}
        onClose={closeProofSheet}
        onDone={() => { closeProofSheet(); void refresh(); }}
      />
      {dialogs}
    </>
  );
}
