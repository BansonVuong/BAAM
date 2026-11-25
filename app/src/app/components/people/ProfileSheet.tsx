import { useEffect, useState } from "react";
import { getUserStats, type BetResult, type CurrencyTotals, type HeadToHead, type UserStats } from "../../../lib/relayer";
import { formatAmount, formatSignedMoney, friendlyError, sameName } from "../../../lib/bets";
import { useBaamData } from "../../data";
import { Initials, InlineError, Sheet } from "../primitives";

const RESULT_WORD: Record<BetResult, string> = {
  win: "won",
  loss: "lost",
  refund: "refunded",
  forfeit: "nobody won",
};

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd>
        <span className="block text-[34px] font-extrabold leading-[34px] wdth-condensed tabular-nums">{value}</span>
        <span className="mt-1 block text-meta text-ink-soft" aria-hidden>{label}</span>
      </dd>
    </div>
  );
}

function streakText(current: number, longest: number, unit: string): string {
  if (current === 0 && longest === 0) return `No ${unit} streak yet`;
  return `${current} now, best ${longest}`;
}

function totalsLine(totals: CurrencyTotals, currency: "SOL" | "PTS"): string {
  const decided = totals.wins + totals.losses;
  const record = `${totals.wins}–${totals.losses}`;
  const net = formatSignedMoney(totals.net, currency);
  if (decided === 0 && totals.refunds === 0 && totals.forfeits === 0) return "No settled bets";
  const extra = totals.refunds > 0 ? `, ${totals.refunds} refunded` : "";
  return `${record}${extra}. Net ${net}, ${formatAmount(totals.staked, currency)} ${currency === "PTS" ? "pts" : "SOL"} staked.`;
}

function rivalryLine(row: HeadToHead): string {
  const last = row.lastResult ? `, last: ${RESULT_WORD[row.lastResult.result]}` : "";
  const active = row.active > 0 ? `, ${row.active} in play` : "";
  return `${row.wins}–${row.losses}${last}${active}`;
}

/** A person's record, streaks and head-to-head (GET /stats/:username). */
export function ProfileSheet() {
  const { user, profileName, closeProfile, openProfile, solEnabled } = useBaamData();
  const [stats, setStats] = useState<UserStats | null>(null);
  const [scope, setScope] = useState<"self" | "shared">("self");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!profileName) return;
    let alive = true;
    setStats(null);
    setError(null);
    setLoading(true);
    getUserStats(profileName)
      .then((result) => { if (alive) { setStats(result.stats); setScope(result.scope); } })
      .catch((err) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : "";
        setError(/not found/i.test(message)
          ? `There's no BAAM account called ${profileName}.`
          : friendlyError(err, "Couldn't load this record. Try again in a minute."));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [profileName]);

  const self = profileName ? sameName(profileName, user.username) : false;
  const name = stats?.username ?? profileName ?? "";
  const showSol = Boolean(stats && (solEnabled || stats.byCurrency.SOL.wins + stats.byCurrency.SOL.losses + stats.byCurrency.SOL.refunds > 0));

  return (
    <Sheet
      open={Boolean(profileName)}
      onOpenChange={(open) => { if (!open) closeProfile(); }}
      size="sm"
      title={self ? "Your record" : name}
      description={self ? user.username : scope === "shared" ? "Only bets you can both see count here." : undefined}
    >
      {loading && <p className="text-label text-ink-soft">Loading the record…</p>}
      {error && <InlineError>{error}</InlineError>}
      {stats && (
        <div>
          <div className="flex items-center gap-3">
            <Initials name={name} />
            <p className="text-label text-ink-soft">
              {stats.wins + stats.losses === 0
                ? "No settled bets yet."
                : `Won ${stats.wins} of ${stats.wins + stats.losses} decided ${stats.wins + stats.losses === 1 ? "bet" : "bets"}.`}
              {stats.active > 0 ? ` ${stats.active} in play.` : ""}
            </p>
          </div>

          <dl className="mt-5 grid grid-cols-3 gap-4">
            <Stat value={stats.wins} label="Won" />
            <Stat value={stats.losses} label="Lost" />
            <Stat value={stats.refunds + stats.forfeits} label="Refunded" />
          </dl>

          <dl className="mt-6 divide-y divide-rule rounded-2xl border border-rule">
            <div className="flex items-baseline justify-between gap-4 px-4 py-3">
              <dt className="text-label text-ink-soft">Win streak</dt>
              <dd className="text-right text-label font-medium">{streakText(stats.currentWinStreak, stats.longestWinStreak, "win")}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 px-4 py-3">
              <dt className="text-label text-ink-soft">Check-in streak</dt>
              <dd className="text-right text-label font-medium">
                {streakText(stats.currentCheckinStreak, stats.longestCheckinStreak, "check-in")}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 px-4 py-3">
              <dt className="text-label text-ink-soft">Points</dt>
              <dd className="text-right text-label font-medium">{totalsLine(stats.byCurrency.PTS, "PTS")}</dd>
            </div>
            {showSol && (
              <div className="flex items-baseline justify-between gap-4 px-4 py-3">
                <dt className="text-label text-ink-soft">SOL</dt>
                <dd className="text-right text-label font-medium">{totalsLine(stats.byCurrency.SOL, "SOL")}</dd>
              </div>
            )}
          </dl>

          <section className="mt-7" aria-labelledby="h2h-title">
            <h3 id="h2h-title" className="text-body font-bold">Head to head</h3>
            {stats.headToHead.length === 0 ? (
              <p className="mt-1 text-label text-ink-soft">
                {self ? "Once you've played someone, your record against them shows up here." : `No bets against anyone yet${scope === "shared" ? " that you can see" : ""}.`}
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-rule">
                {stats.headToHead.map((row) => (
                  <li key={row.opponent}>
                    <button
                      type="button"
                      onClick={() => openProfile(row.opponent)}
                      className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-baseline justify-between gap-4 rounded-lg px-2 py-2 text-left hover:bg-hover"
                    >
                      <span className="text-label font-semibold">
                        vs {sameName(row.opponent, user.username) ? "you" : row.opponent}
                      </span>
                      <span className="text-label tabular-nums">{rivalryLine(row)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {scope === "shared" && (
            <p className="mt-6 text-meta text-ink-soft">
              Counted from bets in chats you're both in, or that you were part of.
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
