// relayer/sports/index.ts
//
// Sports data layer entry point. Everything outside relayer/sports/ should use
// these exports rather than talking to a provider directly:
//
//   getFinalResult(provider, eventId, { sport, league })  → FinalResult (never throws)
//   decideSportsSettlement(...)                            → wait | settle | block
//   getSportsProvider(id) / primarySportsProvider()       → SportsProvider
//   fetchScoreboard / fetchGameResult                      → legacy scraper-compatible helpers
//
// Env (documented in relayer/index.ts and .env.example):
//   SPORTS_PROVIDER            primary provider for new bets + /scoreboard (default "espn")
//   SPORTS_SECONDARY_PROVIDER  optional cross-check provider ("thesportsdb" | "espn"); unset = off
//   SPORTSDB_API_KEY           TheSportsDB key; legacy bets / cross-check only. Unset or "3" = disabled
//   SPORTS_RESULT_MAX_AGE_MS   never settle from a snapshot older than this (default 180000)
//   SPORTS_CANCEL_GRACE_HOURS  postponed/cancelled → refund this long after kickoff (default 48)
//   SPORTS_SOCCER_SHOOTOUT     "winner" (default) | "draw" — see espn.ts
//   SPORTS_SOCCER_LEAGUES      default soccer leagues (comma-separated aliases)
//   SPORTS_SCOREBOARD_CACHE_MS / SPORTS_EVENT_CACHE_MS / SPORTS_HTTP_TIMEOUT_MS / SPORTS_HTTP_RETRIES

import { createEspnProvider } from "./espn";
import { positiveNumber, ProviderError } from "./http";
import { LEAGUES } from "./leagues";
import { matchEvent } from "./settlement";
import { createSportsDbProvider } from "./thesportsdb";
import {
  isSportsProviderId,
  type FinalResult,
  type FinalResultStatus,
  type Sport,
  type SportsEvent,
  type SportsProvider,
  type SportsProviderId,
} from "./types";

export * from "./types";
export { decideSportsSettlement, matchEvent, normalizeTeamName, teamNamesMatch } from "./settlement";
export type { SettlementAction, SettlementInput, ExpectedTeams } from "./settlement";
export { ProviderError, mapLimit } from "./http";
export { LEAGUES, SOCCER_LEAGUES, findLeague, resolveLeagues, defaultSoccerLeagues } from "./leagues";
export { soccerShootoutPolicy } from "./espn";

export const SPORTS_RESULT_MAX_AGE_MS = positiveNumber(process.env.SPORTS_RESULT_MAX_AGE_MS, 180_000);
export const SPORTS_CANCEL_GRACE_MS = positiveNumber(process.env.SPORTS_CANCEL_GRACE_HOURS, 48) * 60 * 60 * 1000;
/** Results fetched for settlement are at most this old (well inside SPORTS_RESULT_MAX_AGE_MS). */
const SETTLEMENT_FETCH_MAX_AGE_MS = 20_000;

/** Friendly message for API clients. Provider details stay in server logs. */
export const SPORTS_UNAVAILABLE_MESSAGE = "Couldn't load games right now. Try again in a minute.";

const providers: Record<SportsProviderId, SportsProvider> = {
  espn: createEspnProvider(),
  thesportsdb: createSportsDbProvider(),
};

export function getSportsProvider(id: SportsProviderId): SportsProvider {
  return providers[id];
}

export function primarySportsProviderId(): SportsProviderId {
  const raw = process.env.SPORTS_PROVIDER?.trim().toLowerCase();
  return isSportsProviderId(raw) && providers[raw].isConfigured() ? raw : "espn";
}

export function primarySportsProvider(): SportsProvider {
  return providers[primarySportsProviderId()];
}

/** The configured cross-check provider, or null when cross-checking is off/unusable. */
export function secondarySportsProviderId(): SportsProviderId | null {
  const raw = process.env.SPORTS_SECONDARY_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "none" || !isSportsProviderId(raw)) return null;
  return providers[raw].isConfigured() ? raw : null;
}

const STATUS_MAP: Record<SportsEvent["status"], FinalResultStatus> = {
  scheduled: "pending",
  in_progress: "pending",
  final: "final",
  postponed: "postponed",
  cancelled: "cancelled",
  unknown: "unknown",
};

export function toFinalResult(event: SportsEvent): FinalResult {
  const status = STATUS_MAP[event.status];
  const isFinal = status === "final";
  return {
    status,
    homeWon: isFinal ? event.homeWon : null,
    isDraw: isFinal && event.homeWon === null,
    provider: event.provider,
    eventId: event.eventId,
    sport: event.sport,
    league: event.league,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    homeTeamId: event.homeTeamId,
    awayTeamId: event.awayTeamId,
    homeScore: event.homeScore,
    awayScore: event.awayScore,
    startTimeMs: event.startTimeMs,
    statusLabel: event.statusLabel,
    providerStatus: event.providerStatus,
    decidedBy: isFinal ? event.decidedBy : null,
    fetchedAtMs: event.fetchedAtMs,
  };
}

function failedResult(provider: SportsProviderId, eventId: string, sport: Sport | null, error: string): FinalResult {
  return {
    status: "unknown",
    homeWon: null,
    isDraw: false,
    provider,
    eventId,
    sport,
    league: null,
    homeTeam: null,
    awayTeam: null,
    homeTeamId: null,
    awayTeamId: null,
    homeScore: null,
    awayScore: null,
    startTimeMs: null,
    statusLabel: "unavailable",
    providerStatus: "",
    decidedBy: null,
    fetchedAtMs: Date.now(),
    error,
  };
}

export interface GetFinalResultOptions {
  /** Strongly recommended: ESPN ids are looked up per sport (and it guards against id collisions). */
  sport?: Sport | null;
  league?: string | null;
  /** Max age of a cached snapshot (default 20s). */
  maxAgeMs?: number;
}

/**
 * Current settlement-relevant result for one event. Never throws: lookup
 * failures come back as `{ status: "unknown", error }`. Only `status: "final"`
 * may move money, and callers should still run decideSportsSettlement() for the
 * staleness / grace / cross-check rules.
 */
export async function getFinalResult(
  provider: SportsProviderId,
  eventId: string,
  options: GetFinalResultOptions = {},
): Promise<FinalResult> {
  const sport = options.sport ?? null;
  const impl = providers[provider];
  if (!impl) return failedResult(provider, eventId, sport, `unknown provider ${provider}`);
  if (!impl.isConfigured()) return failedResult(provider, eventId, sport, `${provider} is not configured`);
  try {
    const event = await impl.getEvent(sport, eventId, {
      league: options.league ?? null,
      maxAgeMs: options.maxAgeMs ?? SETTLEMENT_FETCH_MAX_AGE_MS,
    });
    if (!event) return failedResult(provider, eventId, sport, "event not found");
    return toFinalResult(event);
  } catch (err) {
    return failedResult(provider, eventId, sport, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Cross-check: find the same game on another provider (ids differ between feeds,
 * so match by teams + kickoff) and return its result. null = no unique match.
 */
export async function getCrossCheckResult(
  provider: SportsProviderId,
  ref: { sport: Sport; league: string | null; homeTeam: string; awayTeam: string; startTimeMs: number },
): Promise<FinalResult | null> {
  const impl = providers[provider];
  if (!impl?.isConfigured()) return null;
  const windowMs = 18 * 60 * 60 * 1000;
  try {
    const candidates = await impl.listEvents(ref.sport, {
      league: ref.sport === "soccer" ? ref.league ?? undefined : undefined,
      fromMs: ref.startTimeMs - windowMs,
      toMs: ref.startTimeMs + windowMs,
    });
    const match = matchEvent(
      ref,
      candidates.filter((c): c is SportsEvent & { startTimeMs: number } => c.startTimeMs !== null),
    );
    if (!match) return null;
    // Re-read the single event so the snapshot is fresh rather than a cached scoreboard.
    return await getFinalResult(provider, match.eventId, { sport: ref.sport, league: match.league });
  } catch (err) {
    return failedResult(provider, "", ref.sport, err instanceof Error ? err.message : String(err));
  }
}

// ── scraper-compatible helpers (JSON shapes used by /scoreboard and /game) ───

export interface ScoreboardGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  isFinal: boolean;
  startTime?: string;
  startTimeMs?: number;
  // Added fields (optional for clients):
  provider: SportsProviderId;
  league: string | null;
  leagueName: string | null;
  state: SportsEvent["status"];
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeScore: number | null;
  awayScore: number | null;
}

export interface GameResult {
  gameId: string;
  sport: Sport;
  /** True if the home team won, false if away won, null if draw/tie. */
  homeWon: boolean | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  isFinal: boolean;
  status: string;
}

export interface FetchScoreboardOptions {
  /** Number of days forward (including today) to include. */
  daysAhead?: number;
  /** Also include games that started in the last 24h. */
  includeStarted?: boolean;
  /** Optional cap after sorting by kickoff ascending. */
  maxGames?: number;
  provider?: SportsProviderId;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function toScoreboardGame(event: SportsEvent): ScoreboardGame {
  return {
    gameId: event.eventId,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    status: event.status === "scheduled" ? "Scheduled" : event.statusLabel,
    isFinal: event.status === "final",
    startTime: event.startTimeMs !== null ? new Date(event.startTimeMs).toISOString() : undefined,
    startTimeMs: event.startTimeMs ?? undefined,
    provider: event.provider,
    league: event.league,
    leagueName: (event.league && LEAGUES[event.league]?.name) || null,
    state: event.status,
    homeTeamId: event.homeTeamId,
    awayTeamId: event.awayTeamId,
    homeScore: event.homeScore,
    awayScore: event.awayScore,
  };
}

/** Upcoming (and optionally just-started) games, normalized. Throws ProviderError when the feed is down. */
export async function fetchScoreboard(
  sport: Sport,
  league?: string,
  options: FetchScoreboardOptions = {},
): Promise<ScoreboardGame[]> {
  const nowMs = Date.now();
  const daysAhead = Math.max(0, Math.min(14, options.daysAhead ?? 2));
  const impl = options.provider ? providers[options.provider] : primarySportsProvider();
  if (!impl.isConfigured()) throw new ProviderError(impl.id, "not_configured", `${impl.id} is not configured`);
  const events = await impl.listEvents(sport, {
    league,
    fromMs: options.includeStarted ? nowMs - DAY_MS : nowMs,
    toMs: nowMs + Math.max(daysAhead, 0.25) * DAY_MS,
  });
  let games = events.map(toScoreboardGame);
  if (options.maxGames && options.maxGames > 0) games = games.slice(0, Math.floor(options.maxGames));
  return games;
}

/** Final result for one game, or null until it is final (legacy /game shape). */
export async function fetchGameResult(
  sport: Sport,
  gameId: string,
  provider: SportsProviderId = primarySportsProviderId(),
  league?: string | null,
): Promise<GameResult | null> {
  const result = await getFinalResult(provider, gameId, { sport, league, maxAgeMs: 15_000 });
  if (result.error && result.error !== "event not found") {
    throw new ProviderError(provider, "network", result.error);
  }
  if (result.status !== "final" || result.homeScore === null || result.awayScore === null) return null;
  return {
    gameId,
    sport,
    homeWon: result.isDraw ? null : result.homeWon,
    homeTeam: result.homeTeam ?? "Home",
    awayTeam: result.awayTeam ?? "Away",
    homeScore: result.homeScore,
    awayScore: result.awayScore,
    isFinal: true,
    status: result.statusLabel,
  };
}
