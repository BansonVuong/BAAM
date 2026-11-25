import { useEffect } from "react";
import type { Bet } from "../../../lib/relayer";
import { Button, Sheet } from "../primitives";
import { BetTicket, type BetActionHandlers } from "./BetTicket";
import { BetDetails } from "./BetDetails";

/** One ticket, full size, with its actions, proof gallery and check-in days. */
export function TicketSheet({
  bet,
  viewer,
  handlers,
  groupName,
  focus,
  onOpenChat,
  onChanged,
  onClose,
}: {
  bet: Bet | null;
  viewer: string;
  handlers: BetActionHandlers;
  groupName?: string;
  focus?: "review";
  onOpenChat?: () => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  // "Review check-in" jumps straight to the pending check-ins.
  useEffect(() => {
    if (!bet || focus !== "review") return;
    const timer = window.setTimeout(() => {
      document.getElementById("details-review")?.scrollIntoView({ block: "start" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [bet?.id, focus]);

  // Inside the sheet, the ticket's own "open details" links would reopen the same sheet.
  const inner: BetActionHandlers = { ...handlers, openDetails: undefined };

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
          <BetTicket bet={bet} viewer={viewer} handlers={inner} />
          <BetDetails bet={bet} viewer={viewer} onChanged={onChanged} onOpenPerson={handlers.openPerson} />
        </div>
      )}
    </Sheet>
  );
}
