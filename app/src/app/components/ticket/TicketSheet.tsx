import type { Bet } from "../../../lib/relayer";
import { Button, Sheet } from "../primitives";
import { BetTicket, type BetActionHandlers } from "./BetTicket";

/** One ticket, full size, with its actions. Opened from compact tickets in rails and lists. */
export function TicketSheet({
  bet,
  viewer,
  handlers,
  groupName,
  onOpenChat,
  onClose,
}: {
  bet: Bet | null;
  viewer: string;
  handlers: BetActionHandlers;
  groupName?: string;
  onOpenChat?: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={Boolean(bet)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      size="md"
      title="Bet"
      description={groupName ? `In ${groupName}` : undefined}
      footer={onOpenChat ? (
        <Button variant="secondary" onClick={onOpenChat}>Open the chat</Button>
      ) : undefined}
    >
      {bet && (
        <div className="pt-1">
          <BetTicket bet={bet} viewer={viewer} handlers={handlers} />
        </div>
      )}
    </Sheet>
  );
}
