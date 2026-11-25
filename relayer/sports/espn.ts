// relayer/sports/espn.ts
//
// ESPN public site API (no key). Unofficial: ESPN publishes no terms for
// third-party use and may change or block these endpoints at any time — see
// relayer/README.md "Sports data" before relying on it for real money.
//
//   GET {base}/{sportPath}/scoreboard?dates=YYYYMMDD   one US-Eastern calendar day
//   GET {base}/{sportPath}/summary?event=<id>          one event (header.competitions[0])
//
// sportPath is basketball/nba, football/nfl, hockey/nhl or soccer/<slug>; a
// soccer event can be looked up league-agnostically via soccer/all/summary.
// Date ranges (dates=A-B) currently return HTTP 400, so we fetch day by day.

import { findLeague, LEAGUES, resolveLeagues } from "./leagues";
import { getJson, positiveNumber, ProviderError, TtlCache } from "./http";
import type { DecidedBy, EventStatus, GetEventOptions, ListEventsOptions, Sport, SportsEvent, SportsProvider } from "./types";

const PROVIDER = "espn" as const;
const ESPN_API_BASE = (process.env.ESPN_API_BASE ?? "https://site.api.espn.com/apis/site/v2/sports").replace(/\/+$/, "");
const SCOREBOARD_CACHE_MS = positiveNumber(process.env.SPORTS_SCOREBOARD_CACHE_MS, 60_000);
const EVENT_CACHE_MS = positiveNumber(process.env.SPORTS_EVENT_CACHE_MS, 15_000);

/**
 * Soccer penalty-shootout policy. Bets are on "home win vs away win" with draws
 * refunded, and the score we compare is regular time + extra time (ESPN's
 * competitor `score` excludes shootout kicks). When a match is level after extra
 * time and goes to penalties, ESPN marks the shootout winner with `winner: true`
 * (STATUS_FINAL_PEN). We follow the provider: "winner" (default) pays the team
 * that won the shootout, because that is who "won the match" in the official
 * record. Set SPORTS_SOCCER_SHOOTOUT=draw to instead treat shootouts as a draw
 * (refund both). League matches never go to penalties, so this only affects
 * knockout/cup games. Non-soccer sports always use the provider's winner.
 */
export type ShootoutPolicy = "winner" | "draw";
export function soccerShootoutPolicy(): ShootoutPolicy {
  return process.env.SPORTS_SOCCER_SHOOTOUT === "draw" ? "draw" : "winner";
}

// ── raw payload shapes (only the fields we read) ─────────────────────────────

export interface EspnStatusType {
  name?: string;
  state?: string;
  completed?: boolean;
  description?: string;
  detail?: string;
  shortDetail?: string;
}

export interface EspnCompetitor {
  id?: string;
  homeAway?: string;
  score?: string | number | { value?: number; displayValue?: string };
  winner?: boolean;
  shootoutScore?: number | string;
  team?: { id?: string; displayName?: string; name?: string; abbreviation?: string };
}

export interface EspnCompetition {
  id?: string;
  date?: string;
  status?: { type?: EspnStatusType };
  competitors?: EspnCompetitor[];
}

export interface EspnScoreboardPayload {
  events?: Array<{ id?: string; date?: string; status?: { type?: EspnStatusType }; competitions?: EspnCompetition[] }>;
}

export interface EspnSummaryPayload {
  header?: {
    id?: string;
    league?: { id?: string; slug?: string; name?: string };
    competitions?: EspnCompetition[];
  };
}

export interface ParseContext {
  sport: Sport;
  /** League alias / slug to record on the event (summary payloads override it). */
  league: string | null;
  fetchedAtMs: number;
  shootoutPolicy: ShootoutPolicy;
}

// ── pure normalization ───────────────────────────────────────────────────────

const POSTPONED_NAMES = new Set(["STATUS_POSTPONED", "STATUS_SUSPENDED"]);
const CANCELLED_NAMES = new Set(["STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_ABANDONED"]);
// Forfeits / no-contests can be awarded either way after the fact; never auto-settle.
const UNSAFE_NAMES = new Set(["STATUS_FORFEIT", "STATUS_FORFEIT_HOME", "STATUS_FORFEIT_AWAY", "STATUS_NO_CONTEST"]);
const FINAL_NAME = /^STATUS_(FINAL(_[A-Z0-9]+)?|FULL_TIME)$/;

export function normalizeEspnStatus(type: EspnStatusType | undefined): EventStatus {
  const name = `${type?.name ?? ""}`.toUpperCase();
  if (POSTPONED_NAMES.has(name)) return "postponed";
  if (CANCELLED_NAMES.has(name)) return "cancelled";
  if (UNSAFE_NAMES.has(name)) return "unknown";
  const state = type?.state;
  if (state === "pre") return "scheduled";
  if (state === "in") return "in_progress";
  if (state === "post" && type?.completed === true && FINAL_NAME.test(name)) return "final";
  return "unknown";
}

function decidedByFor(name: string): DecidedBy {
  if (/PEN|_SO$|SHOOTOUT/.test(name)) return "shootout";
  if (/OT|AET|EXTRA/.test(name)) return "overtime";
  return "regulation";
}

function parseScore(raw: EspnCompetitor["score"]): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "object" ? (raw.value ?? raw.displayValue) : raw;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseShootout(raw: EspnCompetitor["shootoutScore"]): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function teamName(c: EspnCompetitor | undefined, fallback: string): string {
  return `${c?.team?.displayName ?? c?.team?.name ?? fallback}`.trim() || fallback;
}

/**
 * Normalize one ESPN competition. Returns null when the payload lacks the basic
 * shape (an id plus exactly one home and one away competitor). A "final" status
 * is downgraded to "unknown" whenever the score and the provider's winner flags
 * disagree or are missing — settlement only ever acts on unambiguous data.
 */
export function parseEspnCompetition(
  competition: EspnCompetition | undefined,
  eventId: string | undefined,
  ctx: ParseContext,
  fallbackStatus?: { type?: EspnStatusType },
  fallbackDate?: string,
): SportsEvent | null {
  const id = `${eventId ?? competition?.id ?? ""}`.trim();
  if (!id || !competition) return null;
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const home = competitors.filter((c) => c.homeAway === "home");
  const away = competitors.filter((c) => c.homeAway === "away");
  if (competitors.length !== 2 || home.length !== 1 || away.length !== 1) return null;

  const statusType = competition.status?.type ?? fallbackStatus?.type;
  const providerStatus = `${statusType?.name ?? ""}`.toUpperCase();
  let status = normalizeEspnStatus(statusType);
  const startMs = Date.parse(competition.date ?? fallbackDate ?? "");
  const homeScore = parseScore(home[0].score);
  const awayScore = parseScore(away[0].score);

  let homeWon: boolean | null = null;
  let decidedBy: DecidedBy | null = null;
  if (status === "final") {
    decidedBy = decidedByFor(providerStatus);
    const outcome = decideFinalOutcome(ctx, decidedBy, home[0], away[0], homeScore, awayScore);
    if (outcome === "ambiguous") {
      status = "unknown";
      decidedBy = null;
    } else {
      homeWon = outcome;
    }
  }

  return {
    provider: PROVIDER,
    eventId: id,
    sport: ctx.sport,
    league: ctx.league,
    homeTeam: teamName(home[0], "Home"),
    awayTeam: teamName(away[0], "Away"),
    homeTeamId: home[0].team?.id ?? home[0].id ?? null,
    awayTeamId: away[0].team?.id ?? away[0].id ?? null,
    homeScore: status === "scheduled" ? null : homeScore,
    awayScore: status === "scheduled" ? null : awayScore,
    startTimeMs: Number.isFinite(startMs) ? startMs : null,
    status,
    statusLabel: `${statusType?.shortDetail ?? statusType?.description ?? statusType?.detail ?? ""}`.trim() || status,
    providerStatus,
    homeWon,
    decidedBy,
    fetchedAtMs: ctx.fetchedAtMs,
  };
}

function decideFinalOutcome(
  ctx: ParseContext,
  decidedBy: DecidedBy,
  home: EspnCompetitor,
  away: EspnCompetitor,
  homeScore: number | null,
  awayScore: number | null,
): boolean | null | "ambiguous" {
  if (homeScore === null || awayScore === null) return "ambiguous";
  const homeFlag = home.winner === true;
  const awayFlag = away.winner === true;
  if (homeFlag && awayFlag) return "ambiguous";

  if (homeScore !== awayScore) {
    const scoreSaysHome = homeScore > awayScore;
    // A winner flag on the side with fewer goals/points means the feed is reporting
    // something other than this game's score (aggregate tie, correction in flight).
    if ((scoreSaysHome && awayFlag) || (!scoreSaysHome && homeFlag)) return "ambiguous";
    return scoreSaysHome;
  }

  // Level score (regular + extra time for soccer).
  const flagged: boolean | null = homeFlag ? true : awayFlag ? false : null;
  if (ctx.sport === "soccer") {
    if (decidedBy !== "shootout") {
      // A level soccer match with a winner flag but no shootout is an aggregate /
      // away-goals decision about the tie, not this match — refuse to guess.
      return flagged === null ? null : "ambiguous";
    }
    if (ctx.shootoutPolicy === "draw") return null;
    if (flagged === null) return "ambiguous";
    const homePens = parseShootout(home.shootoutScore);
    const awayPens = parseShootout(away.shootoutScore);
    if (homePens !== null && awayPens !== null && (homePens > awayPens) !== flagged) return "ambiguous";
    return flagged;
  }
  // NBA/NHL can't end level; an NFL tie has no winner flag. If ESPN ever reports a
  // level NHL shootout score, the winner flag is the official result.
  return flagged;
}

export function parseEspnScoreboard(payload: EspnScoreboardPayload | null, ctx: ParseContext): SportsEvent[] {
  const events = Array.isArray(payload?.events) ? payload!.events : [];
  const out: SportsEvent[] = [];
  for (const e of events) {
    const parsed = parseEspnCompetition(e.competitions?.[0], e.id, ctx, e.status, e.date);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseEspnSummary(payload: EspnSummaryPayload | null, requestedId: string, ctx: ParseContext): SportsEvent | null {
  const header = payload?.header;
  if (!header) return null;
  // Never trust a payload for a different event than the one we asked for.
  if (`${header.id ?? ""}` !== requestedId) return null;
  const slug = header.league?.slug ?? null;
  const league = ctx.sport === "soccer" ? (findLeague("soccer", slug)?.alias ?? slug) : ctx.league;
  return parseEspnCompetition(header.competitions?.[0], header.id, { ...ctx, league });
}

const etDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ESPN `dates=` keys (US-Eastern calendar days, YYYYMMDD) covering [fromMs, toMs]. */
export function espnDateKeys(fromMs: number, toMs: number): string[] {
  const keys = new Set<string>();
  const step = 3 * 60 * 60 * 1000;
  const end = Math.max(fromMs, toMs);
  for (let t = fromMs; t < end; t += step) keys.add(etDateFormat.format(new Date(t)).replace(/-/g, ""));
  keys.add(etDateFormat.format(new Date(end)).replace(/-/g, ""));
  return Array.from(keys).sort().slice(0, 15);
}

// ── provider ─────────────────────────────────────────────────────────────────

const SUMMARY_PATHS_BY_SPORT: Record<Sport, string> = {
  nba: LEAGUES.nba.espnPath,
  nfl: LEAGUES.nfl.espnPath,
  nhl: LEAGUES.nhl.espnPath,
  soccer: "soccer/all",
};

export function createEspnProvider(): SportsProvider {
  const scoreboardCache = new TtlCache<SportsEvent[]>(300);
  const eventCache = new TtlCache<SportsEvent | null>(1000);

  async function fetchDay(sport: Sport, alias: string, dateKey: string): Promise<SportsEvent[]> {
    const info = LEAGUES[alias];
    const key = `${info.espnPath}@${dateKey}`;
    const cached = scoreboardCache.get(key, SCOREBOARD_CACHE_MS);
    if (cached) return cached.value;
    const label = `scoreboard ${info.espnPath} ${dateKey}`;
    const res = await getJson<EspnScoreboardPayload>(
      PROVIDER,
      `${ESPN_API_BASE}/${info.espnPath}/scoreboard?dates=${dateKey}`,
      label,
    );
    if (res.status === 404 || !res.body) throw new ProviderError(PROVIDER, "http", `${PROVIDER} ${label}: not found`, 404);
    const fetchedAtMs = Date.now();
    const events = parseEspnScoreboard(res.body, {
      sport,
      league: sport === "soccer" ? alias : sport,
      fetchedAtMs,
      shootoutPolicy: soccerShootoutPolicy(),
    });
    scoreboardCache.set(key, events, fetchedAtMs);
    return events;
  }

  async function fetchSummary(sport: Sport, path: string, eventId: string, league: string | null): Promise<SportsEvent | null> {
    const res = await getJson<EspnSummaryPayload>(
      PROVIDER,
      `${ESPN_API_BASE}/${path}/summary?event=${encodeURIComponent(eventId)}`,
      `summary ${path} ${eventId}`,
    );
    if (res.status === 404 || !res.body) return null;
    return parseEspnSummary(res.body, eventId, {
      sport,
      league,
      fetchedAtMs: Date.now(),
      shootoutPolicy: soccerShootoutPolicy(),
    });
  }

  return {
    id: PROVIDER,
    isConfigured: () => true,

    async listEvents(sport: Sport, options: ListEventsOptions): Promise<SportsEvent[]> {
      const aliases = resolveLeagues(sport, options.league);
      const dateKeys = espnDateKeys(options.fromMs, options.toMs);
      const jobs = aliases.flatMap((alias) => dateKeys.map((d) => ({ alias, d })));
      const settled = await Promise.allSettled(jobs.map(({ alias, d }) => fetchDay(sport, alias, d)));
      const failures = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length === settled.length && failures.length > 0) throw failures[0].reason;
      for (const f of failures) console.warn(`[sports] partial scoreboard: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);

      const byId = new Map<string, SportsEvent>();
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        for (const e of r.value) {
          if (e.startTimeMs === null || e.startTimeMs < options.fromMs || e.startTimeMs > options.toMs) continue;
          byId.set(e.eventId, e);
        }
      }
      return Array.from(byId.values()).sort(
        (a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0) || a.eventId.localeCompare(b.eventId),
      );
    },

    async getEvent(sport: Sport | null, eventId: string, options: GetEventOptions = {}): Promise<SportsEvent | null> {
      const id = `${eventId}`.trim();
      if (!/^\d{1,20}$/.test(id)) return null;
      const maxAgeMs = options.maxAgeMs ?? EVENT_CACHE_MS;
      const cacheKey = `${sport ?? "*"}:${id}`;
      const cached = maxAgeMs > 0 ? eventCache.get(cacheKey, maxAgeMs) : null;
      if (cached) return cached.value;

      // Without a sport we probe each sport path; ESPN 404s ids from other sports,
      // so a hit is unambiguous.
      const sports: Sport[] = sport ? [sport] : ["nba", "nfl", "nhl", "soccer"];
      let found: SportsEvent | null = null;
      for (const s of sports) {
        const hint = s === "soccer" ? findLeague("soccer", options.league ?? null) : null;
        const path = hint ? hint.espnPath : SUMMARY_PATHS_BY_SPORT[s];
        found = await fetchSummary(s, path, id, s === "soccer" ? (hint?.alias ?? null) : s);
        if (!found && hint) found = await fetchSummary(s, SUMMARY_PATHS_BY_SPORT.soccer, id, null);
        if (found) break;
      }
      eventCache.set(cacheKey, found);
      return found;
    },
  };
}
