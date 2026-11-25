// relayer/sports/thesportsdb.ts
//
// TheSportsDB v1 JSON API. No longer the primary feed: the old public key "3" is
// permanently disabled (HTTP 403) and the free test key "123" only returns a
// truncated slice of each league. It remains for
//   - settling legacy bets created while it was primary (their ids are TheSportsDB ids), and
//   - an optional cross-check provider (SPORTS_SECONDARY_PROVIDER=thesportsdb) with a paid key.
// It is used only when SPORTSDB_API_KEY is explicitly set (anything but "3").
//
//   GET {base}/{key}/lookupevent.php?id=<eventId>
//   GET {base}/{key}/eventsday.php?d=YYYY-MM-DD&l=<leagueId>   (complete lists need a paid key)

import { findLeague, resolveLeagues, LEAGUES } from "./leagues";
import { getJson, positiveNumber, ProviderError, TtlCache } from "./http";
import type { DecidedBy, EventStatus, GetEventOptions, ListEventsOptions, Sport, SportsEvent, SportsProvider } from "./types";

const PROVIDER = "thesportsdb" as const;
const SPORTSDB_API_BASE = (process.env.SPORTSDB_API_BASE ?? "https://www.thesportsdb.com/api/v1/json").replace(/\/+$/, "");
const SCOREBOARD_CACHE_MS = positiveNumber(process.env.SPORTS_SCOREBOARD_CACHE_MS, 60_000);
const EVENT_CACHE_MS = positiveNumber(process.env.SPORTS_EVENT_CACHE_MS, 15_000);

function apiKey(): string | null {
  const key = process.env.SPORTSDB_API_KEY?.trim();
  if (!key || key === "3") return null;
  return key;
}

export interface SportsDbEvent {
  idEvent?: string | null;
  idLeague?: string | null;
  strTimestamp?: string | null;
  dateEvent?: string | null;
  strTime?: string | null;
  strStatus?: string | null;
  strPostponed?: string | null;
  strHomeTeam?: string | null;
  strAwayTeam?: string | null;
  idHomeTeam?: string | null;
  idAwayTeam?: string | null;
  intHomeScore?: string | null;
  intAwayScore?: string | null;
}

const FINAL = new Set(["ft", "aet", "aot", "match finished", "final", "full time", "after over time", "after overtime"]);
// Shootout finals: TheSportsDB gives no reliable shootout winner, so these are "unknown"
// unless the score itself differs.
const FINAL_PENS = new Set(["pen", "ft_pen", "ap", "after penalties", "match finished after penalties"]);
const POSTPONED = new Set(["pst", "postponed", "match postponed", "susp", "suspended", "match suspended", "int", "interrupted"]);
const CANCELLED = new Set(["canc", "cancelled", "canceled", "match cancelled", "abd", "abandoned", "match abandoned"]);
const SCHEDULED = new Set(["", "ns", "not started", "tbd", "time to be defined", "scheduled"]);
const UNSAFE = new Set(["awd", "technical loss", "wo", "walkover"]);

export function normalizeSportsDbStatus(event: SportsDbEvent): EventStatus {
  const s = `${event.strStatus ?? ""}`.trim().toLowerCase();
  if (UNSAFE.has(s)) return "unknown";
  if (CANCELLED.has(s)) return "cancelled";
  if (POSTPONED.has(s) || `${event.strPostponed ?? ""}`.toLowerCase() === "yes") return "postponed";
  if (FINAL.has(s) || FINAL_PENS.has(s)) return "final";
  if (SCHEDULED.has(s)) return "scheduled";
  // Live codes: 1H, HT, 2H, ET, BT, P, Q1-Q4, OT, LIVE, "In Progress", ...
  if (/^(1h|ht|2h|et|bt|p|q[1-4]|ot|so|live|in progress|\d+'?)$/.test(s)) return "in_progress";
  return "unknown";
}

function parseScore(value: string | null | undefined): number | null {
  if (value === null || value === undefined || `${value}`.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseStartTimeMs(event: SportsDbEvent): number | null {
  // strTimestamp is UTC without a zone designator ("2026-11-25T03:00:00").
  const ts = event.strTimestamp?.trim();
  if (ts) {
    const direct = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
    if (Number.isFinite(direct)) return direct;
  }
  if (event.dateEvent && event.strTime) {
    const t = event.strTime.trim().replace(/(\+00:00|Z)$/i, "");
    const fallback = Date.parse(`${event.dateEvent}T${t}Z`);
    if (Number.isFinite(fallback)) return fallback;
  }
  return null;
}

export function parseSportsDbEvent(event: SportsDbEvent | null | undefined, sport: Sport, fetchedAtMs: number): SportsEvent | null {
  const eventId = `${event?.idEvent ?? ""}`.trim();
  if (!event || !eventId) return null;
  let status = normalizeSportsDbStatus(event);
  const homeScore = parseScore(event.intHomeScore);
  const awayScore = parseScore(event.intAwayScore);
  const rawStatus = `${event.strStatus ?? ""}`.trim();
  const lower = rawStatus.toLowerCase();

  let homeWon: boolean | null = null;
  let decidedBy: DecidedBy | null = null;
  if (status === "final") {
    if (homeScore === null || awayScore === null) {
      status = "unknown";
    } else if (FINAL_PENS.has(lower)) {
      decidedBy = "shootout";
      if (homeScore === awayScore) status = "unknown"; // shootout winner not reported reliably
      else homeWon = homeScore > awayScore;
    } else {
      decidedBy = lower === "aet" || lower === "aot" || lower.startsWith("after over") ? "overtime" : "regulation";
      homeWon = homeScore === awayScore ? null : homeScore > awayScore;
    }
  }
  const leagueInfo = findLeague(sport, event.idLeague ?? null);
  return {
    provider: PROVIDER,
    eventId,
    sport,
    league: leagueInfo?.alias ?? (sport === "soccer" ? event.idLeague ?? null : sport),
    homeTeam: `${event.strHomeTeam ?? "Home"}`.trim() || "Home",
    awayTeam: `${event.strAwayTeam ?? "Away"}`.trim() || "Away",
    homeTeamId: event.idHomeTeam ?? null,
    awayTeamId: event.idAwayTeam ?? null,
    homeScore: status === "scheduled" ? null : homeScore,
    awayScore: status === "scheduled" ? null : awayScore,
    startTimeMs: parseStartTimeMs(event),
    status,
    statusLabel: rawStatus || (status === "scheduled" ? "Scheduled" : status),
    providerStatus: rawStatus,
    homeWon: status === "final" ? homeWon : null,
    decidedBy: status === "final" ? decidedBy : null,
    fetchedAtMs,
  };
}

function utcDateKeys(fromMs: number, toMs: number): string[] {
  const keys = new Set<string>();
  const end = Math.max(fromMs, toMs);
  for (let t = fromMs; t < end; t += 6 * 60 * 60 * 1000) keys.add(new Date(t).toISOString().slice(0, 10));
  keys.add(new Date(end).toISOString().slice(0, 10));
  return Array.from(keys).sort().slice(0, 15);
}

export function createSportsDbProvider(): SportsProvider {
  const dayCache = new TtlCache<SportsEvent[]>(300);
  const eventCache = new TtlCache<SportsEvent | null>(1000);

  function requireKey(): string {
    const key = apiKey();
    if (!key) throw new ProviderError(PROVIDER, "not_configured", "thesportsdb: SPORTSDB_API_KEY is not set");
    return key;
  }

  return {
    id: PROVIDER,
    isConfigured: () => apiKey() !== null,

    async listEvents(sport: Sport, options: ListEventsOptions): Promise<SportsEvent[]> {
      const key = requireKey();
      const leagueIds = resolveLeagues(sport, options.league).map((alias) => LEAGUES[alias].sportsDbId);
      const out = new Map<string, SportsEvent>();
      for (const leagueId of leagueIds) {
        for (const day of utcDateKeys(options.fromMs, options.toMs)) {
          const cacheKey = `${leagueId}@${day}`;
          let events = dayCache.get(cacheKey, SCOREBOARD_CACHE_MS)?.value;
          if (!events) {
            const res = await getJson<{ events?: SportsDbEvent[] | null }>(
              PROVIDER,
              `${SPORTSDB_API_BASE}/${encodeURIComponent(key)}/eventsday.php?d=${day}&l=${leagueId}`,
              `eventsday ${leagueId} ${day}`,
            );
            const fetchedAtMs = Date.now();
            events = (Array.isArray(res.body?.events) ? res.body!.events! : [])
              .map((e) => parseSportsDbEvent(e, sport, fetchedAtMs))
              .filter((e): e is SportsEvent => e !== null);
            dayCache.set(cacheKey, events, fetchedAtMs);
          }
          for (const e of events) {
            if (e.startTimeMs !== null && e.startTimeMs >= options.fromMs && e.startTimeMs <= options.toMs) out.set(e.eventId, e);
          }
        }
      }
      return Array.from(out.values()).sort((a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0));
    },

    async getEvent(sport: Sport | null, eventId: string, options: GetEventOptions = {}): Promise<SportsEvent | null> {
      const key = requireKey();
      const id = `${eventId}`.trim();
      if (!/^\d{1,20}$/.test(id)) return null;
      const maxAgeMs = options.maxAgeMs ?? EVENT_CACHE_MS;
      const cached = maxAgeMs > 0 ? eventCache.get(`${sport}:${id}`, maxAgeMs) : null;
      if (cached) return cached.value;
      const res = await getJson<{ events?: SportsDbEvent[] | null }>(
        PROVIDER,
        `${SPORTSDB_API_BASE}/${encodeURIComponent(key)}/lookupevent.php?id=${id}`,
        `lookupevent ${id}`,
      );
      const raw = Array.isArray(res.body?.events) ? res.body!.events!.find((e) => `${e.idEvent}` === id) : undefined;
      const parsed = raw ? parseSportsDbEvent(raw, sport ?? "soccer", Date.now()) : null;
      eventCache.set(`${sport}:${id}`, parsed);
      return parsed;
    },
  };
}
