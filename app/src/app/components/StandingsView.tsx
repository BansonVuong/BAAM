import { useEffect, useMemo, useState } from "react";
import {
  getLeaderboard,
  type Bet,
  type DiscordLeaderboardServer,
  type Player,
} from "../../lib/relayer";
import {
  betCurrency,
  betTimestamp,
  formatSignedMoney,
  getResolvedWinner,
  isBetCompleted,
  normalizeName,
  opponentName,
  parseStakeAmount,
  sameName,
} from "../../lib/bets";
import { cn } from "../../lib/cn";
import { useBaamData } from "../data";
import { Button, EmptyState, ScreenTitle, Segmented } from "./primitives";

const ALL = "__all__";
const DISCORD_PREFIX = "discord:";

interface Standing {
  key: string;
  name: string;
  wins: number;
  losses: number;
  net: number | null;
}

function standingsFromBets(bets: Bet[]): Standing[] {
  const byKey = new Map<string, Standing>();
  const ensure = (name: string): Standing | null => {
    const key = normalizeName(name);
    if (!key || key === "anyone") return null;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, name: name.trim().replace(/^@/, ""), wins: 0, losses: 0, net: 0 };
      byKey.set(key, entry);
    }
    return entry;
  };
  const settled = bets
    .filter((bet) => isBetCompleted(bet) && betCurrency(bet) === "SOL")
    .sort((a, b) => betTimestamp(a) - betTimestamp(b));
  for (const bet of settled) {
    const winner = getResolvedWinner(bet);
    const opponent = opponentName(bet);
    if (!winner || !opponent) continue;
    const winnerName = winner === "challenger" ? bet.challenger : opponent;
    const loserName = winner === "challenger" ? opponent : bet.challenger;
    const stake = parseStakeAmount(bet.stake);
    const w = ensure(winnerName);
    const l = ensure(loserName);
    if (w) { w.wins += 1; w.net = (w.net ?? 0) + stake; }
    if (l) { l.losses += 1; l.net = (l.net ?? 0) - stake; }
  }
  return [...byKey.values()].sort((a, b) =>
    (b.net ?? 0) - (a.net ?? 0) || b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name));
}

/** Older history only kept win/settled counts on the player record. */
function standingsFromPlayers(players: Player[]): Standing[] {
  return players
    .filter((player) => player.disputes > 0)
    .map((player) => ({
      key: normalizeName(player.github || player.name),
      name: player.github || player.name,
      wins: player.wins,
      losses: Math.max(0, player.disputes - player.wins),
      net: null,
    }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name));
}

export function StandingsView({ onOpenGroup, onGoToChats }: {
  onOpenGroup: (groupId: string) => void;
  onGoToChats: () => void;
}) {
  const { user, groups, bets, betGroupIds, loaded } = useBaamData();
  const [scope, setScope] = useState<string>(ALL);
  const [players, setPlayers] = useState<Player[]>([]);
  const [discordServers, setDiscordServers] = useState<DiscordLeaderboardServer[]>([]);
  const [discordBets, setDiscordBets] = useState<Bet[]>([]);

  const discordGuildId = scope.startsWith(DISCORD_PREFIX) ? scope.slice(DISCORD_PREFIX.length) : undefined;

  useEffect(() => {
    let alive = true;
    const load = () => {
      getLeaderboard(discordGuildId)
        .then((result) => {
          if (!alive) return;
          setPlayers(result.players);
          setDiscordServers(result.discordServers);
          setDiscordBets(result.bets ?? []);
        })
        .catch(() => {});
    };
    load();
    const interval = window.setInterval(load, 10_000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [discordGuildId]);

  useEffect(() => {
    const valid = scope === ALL
      || groups.some((g) => g.id === scope)
      || discordServers.some((s) => `${DISCORD_PREFIX}${s.id}` === scope);
    if (!valid && loaded) setScope(ALL);
  }, [scope, groups, discordServers, loaded]);

  const group = groups.find((g) => g.id === scope) ?? null;
  const scopeName = group?.name
    ?? discordServers.find((s) => `${DISCORD_PREFIX}${s.id}` === scope)?.name
    ?? null;

  const scopedBets = useMemo(() => {
    if (discordGuildId) return discordBets;
    if (scope === ALL) return bets.filter((bet) => bet.source !== "imessage");
    return bets.filter((bet) => (bet.groupId ?? betGroupIds[bet.id]) === scope);
  }, [scope, discordGuildId, discordBets, bets, betGroupIds]);

  const standings = useMemo(() => {
    const fromBets = standingsFromBets(scopedBets);
    if (fromBets.length > 0 || group) return fromBets;
    return standingsFromPlayers(players);
  }, [scopedBets, players, group]);

  const unranked = useMemo(() => {
    if (!group?.memberUsernames) return [];
    const ranked = new Set(standings.map((s) => s.key));
    return group.memberUsernames.filter((name) => !ranked.has(normalizeName(name)));
  }, [group, standings]);

  const scopeOptions = [
    { value: ALL, label: "All bets" },
    ...discordServers.map((server) => ({ value: `${DISCORD_PREFIX}${server.id}`, label: server.name })),
    ...groups.map((g) => ({ value: g.id, label: g.name })),
  ];

  return (
    <div className="max-w-[760px] px-4 py-5 lg:px-10 lg:py-8">
      <div className="hidden lg:block">
        <ScreenTitle>Standings</ScreenTitle>
        <p className="mt-1 text-label text-ink-soft">Ranked by net winnings from settled bets.</p>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:mt-6 lg:px-0">
        <Segmented
          label="Show standings for"
          value={scope}
          onChange={setScope}
          size="sm"
          options={scopeOptions}
          className="flex-nowrap lg:flex-wrap"
        />
      </div>

      {standings.length === 0 ? (
        <EmptyState
          title={scopeName ? `No settled bets in ${scopeName} yet.` : "No settled bets yet."}
          body="Standings fill in as bets settle. Start one in a chat with New bet."
          action={group
            ? <Button variant="primary" onClick={() => onOpenGroup(group.id)}>Open {group.name}</Button>
            : <Button variant="primary" onClick={onGoToChats}>Go to chats</Button>}
        />
      ) : (
        <ol className="mt-5 overflow-hidden rounded-[20px] bg-paper" aria-label="Standings">
          {standings.map((entry, index) => {
            const you = sameName(entry.name, user.username);
            const settledCount = entry.wins + entry.losses;
            const rate = settledCount > 0 ? Math.round((entry.wins / settledCount) * 100) : 0;
            return (
              <li
                key={entry.key}
                className={cn(
                  "grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-rule px-4 py-3 last:border-b-0 sm:grid-cols-[52px_minmax(0,1fr)_120px_120px] sm:px-5",
                  you && "bg-ink/[0.045]",
                )}
              >
                <span className="text-[28px] font-extrabold leading-none wdth-condensed tabular-nums">{index + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-label font-semibold">
                    {entry.name}{you && <span className="font-normal text-ink-soft"> (you)</span>}
                  </span>
                  <span className="block text-meta text-ink-soft sm:hidden">
                    {entry.wins} won, {entry.losses} lost
                  </span>
                </span>
                <span className="hidden text-label sm:block">
                  {entry.wins}–{entry.losses}
                  <span className="ml-2 text-meta text-ink-soft">{rate}%</span>
                </span>
                <span className="text-right text-label font-semibold tabular-nums">
                  {entry.net === null ? "—" : formatSignedMoney(entry.net, "SOL")}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {standings.length > 0 && unranked.length > 0 && (
        <p className="mt-4 text-label text-ink-soft">
          Not ranked yet: {unranked.map((name) => (sameName(name, user.username) ? "you" : name)).join(", ")}.
        </p>
      )}
    </div>
  );
}
