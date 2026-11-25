import { useCallback, useEffect, useState } from "react";
import { getScoreboard, type ScoreboardGame, type SportKind } from "../../../lib/relayer";
import { cn } from "../../../lib/cn";
import { Button, Segmented } from "../primitives";

export const SPORTS: SportKind[] = ["nba", "nfl", "nhl", "soccer"];
export const LEAGUE_LABELS: Record<SportKind, string> = {
  nba: "NBA", nfl: "NFL", nhl: "NHL", soccer: "Soccer",
};

export interface ScoreboardState {
  games: ScoreboardGame[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

/** Loads the upcoming board for a league; failures surface as a plain retryable state. */
export function useScoreboard(sport: SportKind, enabled = true): ScoreboardState {
  const [games, setGames] = useState<ScoreboardGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    setFailed(false);
    setGames([]);
    getScoreboard(sport)
      .then((res) => { if (alive) setGames(res.games); })
      .catch(() => { if (alive) setFailed(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sport, enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { games, loading, failed, retry };
}

export function kickoffLabel(game: ScoreboardGame): string {
  if (game.isFinal) return "Final";
  const ms = game.startTimeMs ?? (game.startTime ? Date.parse(game.startTime) : NaN);
  if (!Number.isFinite(ms)) return game.status || "Time to be announced";
  const date = new Date(ms);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === date.toDateString();
  if (sameDay) return `Today ${time}`;
  if (tomorrow) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

export function LeaguePicker({ value, onChange }: { value: SportKind; onChange: (sport: SportKind) => void }) {
  return (
    <Segmented
      label="League"
      value={value}
      onChange={onChange}
      size="sm"
      options={SPORTS.map((sport) => ({ value: sport, label: LEAGUE_LABELS[sport] }))}
    />
  );
}

export function GameList({
  sport,
  board,
  selectedGameId,
  onSelect,
  className,
}: {
  sport: SportKind;
  board: ScoreboardState;
  selectedGameId: string | null;
  onSelect: (game: ScoreboardGame) => void;
  className?: string;
}) {
  if (board.loading) {
    return <p className={cn("rounded-2xl border border-rule p-4 text-label text-ink-soft", className)}>Loading {LEAGUE_LABELS[sport]} games…</p>;
  }
  if (board.failed) {
    return (
      <div className={cn("rounded-2xl border border-rule p-4", className)} role="alert">
        <p className="text-label font-semibold">Couldn't load games right now.</p>
        <p className="mt-0.5 text-label text-ink-soft">The scores provider isn't answering. Try again in a minute.</p>
        <Button size="sm" className="mt-3" onClick={board.retry}>Try again</Button>
      </div>
    );
  }
  if (board.games.length === 0) {
    return (
      <div className={cn("rounded-2xl border border-rule p-4", className)}>
        <p className="text-label font-semibold">No {LEAGUE_LABELS[sport]} games coming up.</p>
        <p className="mt-0.5 text-label text-ink-soft">Bets open in the day before kickoff. Try another league.</p>
      </div>
    );
  }
  return (
    <ul role="listbox" aria-label={`${LEAGUE_LABELS[sport]} games`} className={cn("divide-y divide-rule rounded-2xl border border-rule", className)}>
      {board.games.map((game) => {
        const selected = game.gameId === selectedGameId;
        return (
          <li key={game.gameId} role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={selected}
              disabled={game.isFinal}
              onClick={() => onSelect(game)}
              className={cn(
                "flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl",
                selected ? "bg-ink text-paper" : "hover:bg-hover",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-label font-semibold">{game.awayTeam} at {game.homeTeam}</span>
                <span className={cn("block text-meta", selected ? "text-paper/75" : "text-ink-soft")}>{kickoffLabel(game)}</span>
              </span>
              {selected && <span className="shrink-0 text-meta font-semibold">Picked</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SidePicker({
  game,
  backsHome,
  onChange,
}: {
  game: ScoreboardGame;
  backsHome: boolean;
  onChange: (backsHome: boolean) => void;
}) {
  return (
    <Segmented
      label="Your side"
      value={backsHome ? "home" : "away"}
      onChange={(value) => onChange(value === "home")}
      options={[
        { value: "away", label: <span>{game.awayTeam} <span className="font-normal opacity-75">away</span></span> },
        { value: "home", label: <span>{game.homeTeam} <span className="font-normal opacity-75">home</span></span> },
      ]}
    />
  );
}
