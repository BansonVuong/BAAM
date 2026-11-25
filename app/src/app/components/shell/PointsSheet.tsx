import { useEffect, useState } from "react";
import { claimPointsTopup } from "../../../lib/relayer";
import { friendlyError } from "../../../lib/bets";
import { describeLedgerEntry } from "../../../lib/ledger";
import { useBaamData } from "../../data";
import { Button, InlineError, Sheet } from "../primitives";

function when(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Points balance, held stakes, the daily top-up and recent history. */
export function PointsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { points, refreshPoints, setPoints, bets, groups, betGroupIds } = useBaamData();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setClaimed(null);
    setError(null);
    void refreshPoints();
  }, [open, refreshPoints]);

  async function claim(): Promise<void> {
    setClaiming(true);
    setError(null);
    try {
      const result = await claimPointsTopup();
      setPoints(result.points);
      setClaimed(result.claimed);
    } catch (err) {
      setError(friendlyError(err, "Couldn't top up right now. Try again."));
      void refreshPoints();
    } finally {
      setClaiming(false);
    }
  }

  const betInfo = (betId: string | null) => {
    if (!betId) return undefined;
    const bet = bets.find((b) => b.id === betId);
    const groupId = bet?.groupId ?? betGroupIds[betId];
    return { terms: bet?.terms, groupName: groupId ? groups.find((g) => g.id === groupId)?.name : undefined };
  };

  const resetTime = points
    ? new Date(points.topup.resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="sm" title="Points" description="Play money for bets with friends. Points can't be bought or cashed out.">
      {!points ? (
        <p className="text-label text-ink-soft">Loading your points…</p>
      ) : (
        <div>
          <p>
            <span className="text-stake font-extrabold wdth-condensed tabular-nums">{points.balance.toLocaleString()}</span>
            <span className="ml-2 text-label font-semibold">pts to spend</span>
          </p>
          <p className="mt-1 text-label text-ink-soft">
            {points.held > 0 ? `${points.held.toLocaleString()} pts held in open bets.` : "Nothing held in open bets."}
          </p>

          <div className="mt-5 rounded-2xl border border-rule p-4">
            {claimed !== null ? (
              <p className="text-label font-semibold" role="status">Topped up. +{claimed.toLocaleString()} pts added.</p>
            ) : points.topup.claimable ? (
              <>
                <p className="text-label">You're below {points.topup.floor.toLocaleString()} pts. Claim a free top-up once a day.</p>
                <Button variant="primary" className="mt-3" onClick={() => { void claim(); }} disabled={claiming}>
                  {claiming ? "Topping up…" : `Top up to ${points.topup.floor.toLocaleString()} pts`}
                </Button>
              </>
            ) : points.topup.claimedToday ? (
              <p className="text-label text-ink-soft">You've had today's top-up. The next one opens {resetTime}.</p>
            ) : (
              <p className="text-label text-ink-soft">
                If you drop below {points.topup.floor.toLocaleString()} pts, you can top back up once a day.
              </p>
            )}
            {error && <div className="mt-2"><InlineError>{error}</InlineError></div>}
          </div>

          <section className="mt-7" aria-labelledby="points-history">
            <h3 id="points-history" className="text-body font-bold">Recent</h3>
            {points.ledger.length === 0 ? (
              <p className="mt-1 text-label text-ink-soft">No points have moved yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-rule">
                {points.ledger.map((entry) => {
                  const line = describeLedgerEntry(entry, betInfo(entry.betId));
                  return (
                    <li key={entry.key} className="flex items-baseline justify-between gap-4 py-2.5">
                      <span className="min-w-0">
                        <span className="block text-label font-semibold">{line.title}</span>
                        <span className="block truncate text-meta text-ink-soft">
                          {line.detail ? `${line.detail}, ` : ""}{when(entry.createdAt)}
                        </span>
                      </span>
                      {line.amount && <span className="shrink-0 text-label font-semibold tabular-nums">{line.amount}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
