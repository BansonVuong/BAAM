// relayer/sports/types.ts
//
// Provider-neutral sports data types. Every provider (ESPN, TheSportsDB, ...)
// normalizes its payloads into these shapes so the settlement logic never has to
// know which feed a result came from.

export type Sport = "soccer" | "nba" | "nfl" | "nhl";

export const SUPPORTED_SPORTS: readonly Sport[] = ["soccer", "nba", "nfl", "nhl"];

export function isSport(value: unknown): value is Sport {
  return typeof value === "string" && (SUPPORTED_SPORTS as readonly string[]).includes(value);
}

/** Providers a bet can be bound to. Stored on bets as `sportsProvider`. */
export type SportsProviderId = "espn" | "thesportsdb";

export const SPORTS_PROVIDER_IDS: readonly SportsProviderId[] = ["espn", "thesportsdb"];

export function isSportsProviderId(value: unknown): value is SportsProviderId {
  return typeof value === "string" && (SPORTS_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Normalized lifecycle of one event.
 *   scheduled    not started yet (includes "delayed" before the start)
 *   in_progress  live, halftime, between periods, rain delay mid-game ...
 *   final        provider says the game is over AND the result is unambiguous
 *   postponed    postponed / suspended — may still be played later
 *   cancelled    cancelled / abandoned — will not be completed
 *   unknown      anything we can't interpret safely (forfeits, contradictory data)
 */
export type EventStatus = "scheduled" | "in_progress" | "final" | "postponed" | "cancelled" | "unknown";

/** How a final result was decided. Informational (settlement already folds it into homeWon). */
export type DecidedBy = "regulation" | "overtime" | "shootout";

export interface SportsEvent {
  provider: SportsProviderId;
  eventId: string;
  sport: Sport;
  /** Our league alias (e.g. "epl") when known, else the provider's league slug/id. */
  league: string | null;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** Scores including overtime / extra time, excluding penalty shootouts. Null before kickoff. */
  homeScore: number | null;
  awayScore: number | null;
  /** Scheduled (or actual) start, unix ms. */
  startTimeMs: number | null;
  status: EventStatus;
  /** Short human label ("Scheduled", "Final", "FT-Pens", "Postponed"). */
  statusLabel: string;
  /** Raw provider status code (e.g. "STATUS_FINAL_PEN", "FT"). For logs. */
  providerStatus: string;
  /**
   * Only meaningful when status === "final": true = home won, false = away won,
   * null = draw/tie (bets refund both sides).
   */
  homeWon: boolean | null;
  decidedBy: DecidedBy | null;
  /** When this snapshot was fetched from the provider (unix ms). */
  fetchedAtMs: number;
}

/** Status vocabulary for settlement callers (crankSportsBets, points settlement, ...). */
export type FinalResultStatus = "final" | "pending" | "postponed" | "cancelled" | "unknown";

export interface FinalResult {
  status: FinalResultStatus;
  /**
   * true = home won, false = away won. null when not final OR the game ended
   * level (check `isDraw`). Never pay a winner unless status === "final".
   */
  homeWon: boolean | null;
  /** True only for a final result with no winner (draws refund both sides). */
  isDraw: boolean;
  provider: SportsProviderId;
  eventId: string;
  sport: Sport | null;
  league: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeScore: number | null;
  awayScore: number | null;
  startTimeMs: number | null;
  statusLabel: string;
  providerStatus: string;
  decidedBy: DecidedBy | null;
  /** When the underlying data was fetched (unix ms). Callers must reject stale data. */
  fetchedAtMs: number;
  /** Set when the lookup itself failed (network, provider down, not configured, not found). */
  error?: string;
}

export interface ListEventsOptions {
  /** Soccer league alias (epl, laliga, ...); omitted = the configured default set. */
  league?: string;
  /** Inclusive window on scheduled start time, unix ms. */
  fromMs: number;
  toMs: number;
}

export interface GetEventOptions {
  /** Soccer league alias/slug hint; providers may look the event up without it. */
  league?: string | null;
  /** Max acceptable age of a cached snapshot (default: provider event cache TTL). 0 = always refetch. */
  maxAgeMs?: number;
}

export interface SportsProvider {
  readonly id: SportsProviderId;
  /** False when the provider can't be used (e.g. TheSportsDB without an API key). */
  isConfigured(): boolean;
  /** Scoreboard: all events whose scheduled start falls in [fromMs, toMs], sorted by start. */
  listEvents(sport: Sport, options: ListEventsOptions): Promise<SportsEvent[]>;
  /** One event by provider id. Resolves null when the provider says it doesn't exist. */
  getEvent(sport: Sport | null, eventId: string, options?: GetEventOptions): Promise<SportsEvent | null>;
}
