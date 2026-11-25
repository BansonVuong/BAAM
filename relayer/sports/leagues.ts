// relayer/sports/leagues.ts
//
// League registry shared by every provider. Aliases are what clients send in
// `/scoreboard?sport=soccer&league=<alias>` and what bets store as `sportsLeague`.

import type { Sport } from "./types";

export interface LeagueInfo {
  alias: string;
  sport: Sport;
  name: string;
  /** ESPN path segment under /sports/ (e.g. "basketball/nba", "soccer/eng.1"). */
  espnPath: string;
  /** TheSportsDB numeric league id. */
  sportsDbId: string;
}

export const LEAGUES: Record<string, LeagueInfo> = {
  nba: { alias: "nba", sport: "nba", name: "NBA", espnPath: "basketball/nba", sportsDbId: "4387" },
  nfl: { alias: "nfl", sport: "nfl", name: "NFL", espnPath: "football/nfl", sportsDbId: "4391" },
  nhl: { alias: "nhl", sport: "nhl", name: "NHL", espnPath: "hockey/nhl", sportsDbId: "4380" },
  epl: { alias: "epl", sport: "soccer", name: "Premier League", espnPath: "soccer/eng.1", sportsDbId: "4328" },
  laliga: { alias: "laliga", sport: "soccer", name: "LaLiga", espnPath: "soccer/esp.1", sportsDbId: "4335" },
  seriea: { alias: "seriea", sport: "soccer", name: "Serie A", espnPath: "soccer/ita.1", sportsDbId: "4332" },
  bundesliga: { alias: "bundesliga", sport: "soccer", name: "Bundesliga", espnPath: "soccer/ger.1", sportsDbId: "4331" },
  ligue1: { alias: "ligue1", sport: "soccer", name: "Ligue 1", espnPath: "soccer/fra.1", sportsDbId: "4334" },
  mls: { alias: "mls", sport: "soccer", name: "MLS", espnPath: "soccer/usa.1", sportsDbId: "4346" },
  ucl: { alias: "ucl", sport: "soccer", name: "Champions League", espnPath: "soccer/uefa.champions", sportsDbId: "4480" },
  worldcup: { alias: "worldcup", sport: "soccer", name: "FIFA World Cup", espnPath: "soccer/fifa.world", sportsDbId: "4429" },
};

/** Soccer league aliases accepted by /scoreboard (alias → ESPN slug). Kept for callers of the old scraper API. */
export const SOCCER_LEAGUES: Record<string, string> = Object.fromEntries(
  Object.values(LEAGUES)
    .filter((l) => l.sport === "soccer")
    .map((l) => [l.alias, l.espnPath.slice("soccer/".length)]),
);

const DEFAULT_SOCCER_LEAGUES = ["epl", "laliga", "seriea", "bundesliga", "ligue1", "mls", "ucl"];

/** Soccer leagues shown when no `league` is requested (SPORTS_SOCCER_LEAGUES, comma-separated aliases). */
export function defaultSoccerLeagues(): string[] {
  const raw = process.env.SPORTS_SOCCER_LEAGUES;
  const parsed = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((alias) => LEAGUES[alias]?.sport === "soccer");
  return parsed.length > 0 ? Array.from(new Set(parsed)) : DEFAULT_SOCCER_LEAGUES;
}

/**
 * Resolve a requested league to aliases to fetch. Non-soccer sports have exactly
 * one league. For soccer, accepts an alias ("epl"), an ESPN slug ("eng.1") or a
 * TheSportsDB id ("4328"); unknown/omitted → the default set.
 */
export function resolveLeagues(sport: Sport, league?: string | null): string[] {
  if (sport !== "soccer") return [sport];
  const wanted = league?.trim().toLowerCase();
  if (!wanted) return defaultSoccerLeagues();
  const match = findLeague(sport, wanted);
  return match ? [match.alias] : defaultSoccerLeagues();
}

/** Look up a league by alias, ESPN slug or TheSportsDB id (restricted to `sport`). */
export function findLeague(sport: Sport, key: string | null | undefined): LeagueInfo | null {
  if (!key) return sport === "soccer" ? null : LEAGUES[sport];
  const k = key.trim().toLowerCase();
  for (const info of Object.values(LEAGUES)) {
    if (info.sport !== sport) continue;
    if (info.alias === k || info.espnPath === k || info.espnPath.split("/")[1] === k || info.sportsDbId === k) {
      return info;
    }
  }
  return null;
}
