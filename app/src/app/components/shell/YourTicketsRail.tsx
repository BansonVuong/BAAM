import { useBaamData } from "../../data";
import { BetTicket } from "../ticket/BetTicket";
import { useMyBets } from "../TicketsView";

const ORDER = { "needs-you": 0, verdict: 1, live: 2, offer: 3, done: 4 } as const;

/** Desktop right rail beside the chat: your unsettled tickets, most urgent first. */
export function YourTicketsRail({ onSeeAll }: { onSeeAll: () => void }) {
  const { user, groups, betGroupIds, openDetails } = useBaamData();
  const open = useMyBets()
    .filter((entry) => entry.bucket !== "done")
    .sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket]);
  const groupNameFor = (betId: string, groupId?: string) => {
    const id = groupId ?? betGroupIds[betId];
    return id ? groups.find((g) => g.id === id)?.name : undefined;
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper" aria-labelledby="rail-tickets">
      <div className="flex items-baseline justify-between px-5 pb-3 pt-5">
        <h2 id="rail-tickets" className="text-body font-bold">Your tickets</h2>
        <button type="button" onClick={onSeeAll} className="min-h-11 rounded-md px-1 text-label font-semibold underline underline-offset-4">
          See all
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {open.length === 0 ? (
          <p className="text-label text-ink-soft">No open bets. Start one with New bet.</p>
        ) : (
          [
            { title: "Needs you", entries: open.filter((entry) => entry.bucket === "needs-you") },
            { title: "Open", entries: open.filter((entry) => entry.bucket !== "needs-you") },
          ].filter((section) => section.entries.length > 0).map((section, index, all) => (
            <section key={section.title} className={index > 0 ? "mt-6" : undefined}>
              {all.length > 1 && <h3 className="mb-2 text-meta font-semibold text-ink-soft">{section.title}</h3>}
              <ul className="space-y-3">
                {section.entries.map(({ bet }) => (
                  <li key={bet.id}>
                    <BetTicket
                      bet={bet}
                      viewer={user.username}
                      variant="compact"
                      context={groupNameFor(bet.id, bet.groupId)}
                      onOpen={() => openDetails(bet.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
