// Plain assertion script for the sports data layer (no network, no test framework):
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/sports/sports.check.ts
//
// Fixtures in ./fixtures are trimmed real responses captured from ESPN /
// TheSportsDB (see each file's _source).
import assert from "assert";
import fs from "fs";
import path from "path";

import { espnDateKeys, normalizeEspnStatus, parseEspnScoreboard, parseEspnSummary, type ParseContext } from "./espn";
import { parseSportsDbEvent } from "./thesportsdb";
import { decideSportsSettlement, matchEvent, teamNamesMatch, type SettlementInput } from "./settlement";
import { resolveLeagues, findLeague } from "./leagues";
import { toFinalResult, toScoreboardGame } from "./index";
import type { FinalResult, Sport, SportsEvent } from "./types";

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));
const NOW = Date.parse("2026-11-25T14:10:00Z");
const ctx = (sport: Sport, extra: Partial<ParseContext> = {}): ParseContext => ({
  sport,
  league: sport === "soccer" ? null : sport,
  fetchedAtMs: NOW,
  shootoutPolicy: "winner",
  ...extra,
});
const summary = (name: string, sport: Sport, extra: Partial<ParseContext> = {}): SportsEvent => {
  const raw = fixture(name);
  const e = parseEspnSummary(raw, raw.header.id, ctx(sport, extra));
  assert.ok(e, `${name} should parse`);
  return e!;
};

// ── ESPN status normalization ────────────────────────────────────────────────
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_SCHEDULED", state: "pre", completed: false }), "scheduled");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_DELAYED", state: "pre", completed: false }), "scheduled");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_HALFTIME", state: "in", completed: false }), "in_progress");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_FINAL", state: "post", completed: true }), "final");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_FINAL_OT", state: "post", completed: true }), "final");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_FULL_TIME", state: "post", completed: true }), "final");
// "post" but not completed is never final.
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_FINAL", state: "post", completed: false }), "unknown");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_POSTPONED", state: "post", completed: false }), "postponed");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_SUSPENDED", state: "post", completed: false }), "postponed");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_CANCELED", state: "post", completed: false }), "cancelled");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_ABANDONED", state: "post", completed: false }), "cancelled");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_FORFEIT", state: "post", completed: true }), "unknown");
assert.strictEqual(normalizeEspnStatus({ name: "STATUS_SOMETHING_NEW", state: "post", completed: true }), "unknown");
assert.strictEqual(normalizeEspnStatus(undefined), "unknown");

// ── ESPN fixtures ────────────────────────────────────────────────────────────
// NBA final: DET 104 @ ORL 86 → away win.
const nbaFinal = summary("espn-nba-final", "nba");
assert.strictEqual(nbaFinal.status, "final");
assert.strictEqual(nbaFinal.homeTeam, "Orlando Magic");
assert.strictEqual(nbaFinal.homeScore, 86);
assert.strictEqual(nbaFinal.awayScore, 104);
assert.strictEqual(nbaFinal.homeWon, false);
assert.strictEqual(nbaFinal.decidedBy, "regulation");
assert.strictEqual(nbaFinal.startTimeMs, Date.parse("2026-11-25T00:00:00Z"));
// NFL final: CIN 20 @ WSH 22 → home win.
const nflFinal = summary("espn-nfl-final", "nfl");
assert.strictEqual(nflFinal.status, "final");
assert.strictEqual(nflFinal.homeWon, true);
// Scheduled: no scores, kickoff from the provider.
const nbaSched = summary("espn-nba-scheduled", "nba");
assert.strictEqual(nbaSched.status, "scheduled");
assert.strictEqual(nbaSched.homeScore, null);
assert.strictEqual(nbaSched.homeWon, null);
assert.strictEqual(nbaSched.startTimeMs, Date.parse("2026-11-25T22:00:00Z"));
// Soccer in progress (live 1-0) is never final.
const live = summary("espn-soccer-in-progress", "soccer");
assert.strictEqual(live.status, "in_progress");
assert.strictEqual(live.homeWon, null);
// Soccer draw: Newcastle 2-2 Arsenal (EPL) → final draw; league mapped to alias.
const draw = summary("espn-soccer-draw", "soccer");
assert.strictEqual(draw.status, "final");
assert.strictEqual(draw.homeWon, null);
assert.strictEqual(draw.league, "epl");
assert.strictEqual(toFinalResult(draw).isDraw, true);
// Shootout: SEA 1-1 RSL after ET, RSL wins 4-2 on pens.
const so = summary("espn-soccer-shootout", "soccer");
assert.strictEqual(so.status, "final");
assert.strictEqual(so.decidedBy, "shootout");
assert.strictEqual(so.homeScore, 1);
assert.strictEqual(so.awayScore, 1);
assert.strictEqual(so.homeWon, false, "shootout winner (away) per provider under the default policy");
assert.strictEqual(so.league, "mls");
const soDraw = summary("espn-soccer-shootout", "soccer", { shootoutPolicy: "draw" });
assert.strictEqual(soDraw.status, "final");
assert.strictEqual(soDraw.homeWon, null, "SPORTS_SOCCER_SHOOTOUT=draw refunds shootouts");
// Postponed / cancelled.
assert.strictEqual(summary("espn-soccer-postponed", "soccer").status, "postponed");
assert.strictEqual(summary("espn-soccer-canceled", "soccer").status, "cancelled");
// A payload for a different event than requested is rejected.
assert.strictEqual(parseEspnSummary(fixture("espn-nba-final"), "123", ctx("nba")), null);

// Contradictory data downgrades "final" to "unknown".
const tampered = fixture("espn-nba-final");
tampered.header.competitions[0].competitors[0].winner = true; // home flagged winner despite 86-104
assert.strictEqual(parseEspnSummary(tampered, tampered.header.id, ctx("nba"))!.status, "unknown");
const noScore = fixture("espn-nba-final");
noScore.header.competitions[0].competitors[1].score = "";
assert.strictEqual(parseEspnSummary(noScore, noScore.header.id, ctx("nba"))!.status, "unknown");
const soNoWinner = fixture("espn-soccer-shootout");
soNoWinner.header.competitions[0].competitors[1].winner = false;
assert.strictEqual(parseEspnSummary(soNoWinner, soNoWinner.header.id, ctx("soccer"))!.status, "unknown");
const soMismatch = fixture("espn-soccer-shootout");
soMismatch.header.competitions[0].competitors[0].shootoutScore = 5; // pens say home, flag says away
assert.strictEqual(parseEspnSummary(soMismatch, soMismatch.header.id, ctx("soccer"))!.status, "unknown");
const aggregate = fixture("espn-soccer-draw");
aggregate.header.competitions[0].competitors[1].winner = true; // level match, "winner" w/o shootout
assert.strictEqual(parseEspnSummary(aggregate, aggregate.header.id, ctx("soccer"))!.status, "unknown");

// Scoreboard parsing + backward-compatible JSON shape.
const board = parseEspnScoreboard(fixture("espn-nba-scoreboard"), ctx("nba"));
assert.strictEqual(board.length, 3);
const game = toScoreboardGame(board[0]);
for (const key of ["gameId", "homeTeam", "awayTeam", "status", "isFinal", "startTime", "startTimeMs"]) {
  assert.ok(key in game, `scoreboard game keeps ${key}`);
}
assert.strictEqual(game.gameId, "401909317");
assert.strictEqual(game.isFinal, false);
assert.strictEqual(game.startTime, "2026-11-25T22:00:00.000Z");
assert.strictEqual(game.provider, "espn");

// ESPN dates are US-Eastern calendar days.
assert.deepStrictEqual(espnDateKeys(Date.parse("2026-11-25T14:00:00Z"), Date.parse("2026-11-26T14:00:00Z")), ["20261125", "20261126"]);
assert.deepStrictEqual(espnDateKeys(Date.parse("2026-11-26T03:00:00Z"), Date.parse("2026-11-26T03:00:00Z")), ["20261125"]);

// Leagues.
assert.deepStrictEqual(resolveLeagues("nba"), ["nba"]);
assert.deepStrictEqual(resolveLeagues("soccer", "EPL"), ["epl"]);
assert.deepStrictEqual(resolveLeagues("soccer", "eng.1"), ["epl"]);
assert.deepStrictEqual(resolveLeagues("soccer", "4328"), ["epl"]); // legacy TheSportsDB id
assert.ok(resolveLeagues("soccer").includes("mls"));
assert.strictEqual(findLeague("soccer", "aus.w.1"), null);

// ── TheSportsDB (legacy) ─────────────────────────────────────────────────────
const tsdb = parseSportsDbEvent(fixture("thesportsdb-nba-final").events[0], "nba", NOW)!;
assert.strictEqual(tsdb.status, "final");
assert.strictEqual(tsdb.homeTeam, "Denver Nuggets");
assert.strictEqual(tsdb.homeWon, false); // DEN 101 - DAL 120
assert.strictEqual(tsdb.startTimeMs, Date.parse("2026-11-25T03:00:00Z"));
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "NS" }, "nba", NOW)!.status, "scheduled");
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "Match Postponed" }, "soccer", NOW)!.status, "postponed");
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "NS", strPostponed: "yes" }, "soccer", NOW)!.status, "postponed");
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "Match Abandoned" }, "soccer", NOW)!.status, "cancelled");
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "FT", intHomeScore: "1", intAwayScore: "1" }, "soccer", NOW)!.homeWon, null);
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "PEN", intHomeScore: "1", intAwayScore: "1" }, "soccer", NOW)!.status, "unknown");
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "FT", intHomeScore: "", intAwayScore: "2" }, "soccer", NOW)!.status, "unknown");
assert.strictEqual(parseSportsDbEvent({ idEvent: "1", strStatus: "2H", intHomeScore: "1", intAwayScore: "0" }, "soccer", NOW)!.status, "in_progress");

// ── settlement rules ─────────────────────────────────────────────────────────
const H = 60 * 60 * 1000;
const kickoff = Date.parse("2026-11-25T00:00:00Z");
const base = (primary: FinalResult, extra: Partial<SettlementInput> = {}): SettlementInput => ({
  nowMs: kickoff + 4 * H,
  scheduledKickoffMs: kickoff,
  acceptedAtMs: null, // fixtures span several days; the accept-after-kickoff rule is tested explicitly below
  primary,
  graceMs: 48 * H,
  maxResultAgeMs: 180_000,
  ...extra,
});
const fresh = (e: SportsEvent, at = kickoff + 4 * H): FinalResult => ({ ...toFinalResult(e), fetchedAtMs: at });
const decide = (primary: FinalResult, extra: Partial<SettlementInput> = {}) => decideSportsSettlement(base(primary, extra));

assert.deepStrictEqual(decide(fresh(nbaFinal)).type, "settle");
assert.strictEqual((decide(fresh(nbaFinal)) as { homeWon: boolean | null }).homeWon, false);
assert.strictEqual((decide(fresh(nflFinal)) as { homeWon: boolean | null }).homeWon, true);
// Draw → refund.
const drawAction = decide(fresh(draw));
assert.strictEqual(drawAction.type, "settle");
assert.strictEqual((drawAction as { homeWon: boolean | null }).homeWon, null);
// Shootout → provider's winner (away).
assert.strictEqual((decide(fresh(so)) as { homeWon: boolean | null }).homeWon, false);
// Stale snapshot → wait.
assert.strictEqual(decide(fresh(nbaFinal, kickoff + 4 * H - 181_000)).type, "wait");
// Lookup error → wait.
assert.strictEqual(decide({ ...fresh(nbaFinal), status: "unknown", error: "timed out" }).type, "wait");
// Not final → wait.
assert.strictEqual(decide(fresh(live)).type, "wait");
assert.strictEqual(decide(fresh(nbaSched)).type, "wait");
// Postponed / cancelled: wait inside the grace window, refund after it.
const pst = summary("espn-soccer-postponed", "soccer");
const cnl = summary("espn-soccer-canceled", "soccer");
assert.strictEqual(decide(fresh(pst, kickoff + 47 * H), { nowMs: kickoff + 47 * H }).type, "wait");
const pstLate = decide(fresh(pst, kickoff + 48 * H), { nowMs: kickoff + 48 * H });
assert.deepStrictEqual([pstLate.type, (pstLate as { homeWon?: unknown }).homeWon], ["settle", null]);
assert.strictEqual(decide(fresh(cnl, kickoff + H), { nowMs: kickoff + H }).type, "wait");
assert.strictEqual(decide(fresh(cnl, kickoff + 49 * H), { nowMs: kickoff + 49 * H }).type, "settle");
// Re-dated past the grace window (shows "scheduled" again): wait until the window closes, then refund.
const redated = (at: number): FinalResult => ({ ...fresh(nbaSched, at), startTimeMs: kickoff + 72 * H });
assert.strictEqual(decide(redated(kickoff + 10 * H), { nowMs: kickoff + 10 * H }).type, "wait");
assert.deepStrictEqual(
  (({ type, homeWon }: { type: string; homeWon?: unknown }) => [type, homeWon])(decide(redated(kickoff + 48 * H), { nowMs: kickoff + 48 * H }) as never),
  ["settle", null],
);
// Re-dated inside the window: keep waiting for the replay.
assert.strictEqual(decide({ ...fresh(nbaSched, kickoff + 49 * H), startTimeMs: kickoff + 47 * H }, { nowMs: kickoff + 49 * H }).type, "wait");
// Unknown status never settles, even long after the grace window.
const unknownFinal = { ...fresh(nbaFinal, kickoff + 100 * H), status: "unknown" as const, homeWon: null };
assert.strictEqual(decide(unknownFinal, { nowMs: kickoff + 100 * H }).type, "wait");
// Accepted before kickoff → normal payout; at/after the actual kickoff (game moved earlier) → refund.
assert.strictEqual((decide(fresh(nbaFinal), { acceptedAtMs: kickoff - H }) as { homeWon?: unknown }).homeWon, false);
const moved = decide(fresh(nbaFinal), { acceptedAtMs: kickoff + 60_000 });
assert.deepStrictEqual([moved.type, (moved as { homeWon?: unknown }).homeWon], ["settle", null]);
// Team ids changed since creation → block.
assert.strictEqual(decide(fresh(nbaFinal), { expected: { homeTeamId: "19", awayTeamId: "8" } }).type, "settle");
assert.strictEqual(decide(fresh(nbaFinal), { expected: { homeTeamId: "8", awayTeamId: "19" } }).type, "block");

// Cross-check.
const agree = { ...fresh(nbaFinal), provider: "thesportsdb" as const, eventId: "2601925" };
assert.strictEqual(decide(fresh(nbaFinal), { secondary: agree }).type, "settle");
const disagree = { ...agree, homeWon: true, homeScore: 120, awayScore: 101 };
const blocked = decide(fresh(nbaFinal), { secondary: disagree });
assert.strictEqual(blocked.type, "block");
assert.match(blocked.reason, /disagree/);
assert.strictEqual(decide(fresh(nbaFinal), { secondary: { ...agree, isDraw: true, homeWon: null } }).type, "block");
// Secondary not found / not final: wait during grace, block after.
assert.strictEqual(decide(fresh(nbaFinal), { secondary: null }).type, "wait");
assert.strictEqual(decide(fresh(nbaFinal, kickoff + 49 * H), { secondary: null, nowMs: kickoff + 49 * H }).type, "block");
assert.strictEqual(decide(fresh(nbaFinal), { secondary: { ...agree, status: "pending", homeWon: null } }).type, "wait");
// Cancellation refunds don't need the secondary.
assert.strictEqual(decide(fresh(cnl, kickoff + 49 * H), { secondary: null, nowMs: kickoff + 49 * H }).type, "settle");

// Team matching across providers.
assert.ok(teamNamesMatch("Manchester United FC", "Manchester United"));
assert.ok(teamNamesMatch("Newcastle Jets ", "Newcastle Jets FC"));
assert.ok(teamNamesMatch("Atlético Madrid", "Atletico Madrid"));
assert.ok(!teamNamesMatch("Manchester United", "Manchester City"));
const ref = { homeTeam: "Denver Nuggets", awayTeam: "Dallas Mavericks", startTimeMs: kickoff + 3 * H };
assert.strictEqual(matchEvent(ref, [{ ...ref, id: "a" }, { homeTeam: "Dallas Mavericks", awayTeam: "Denver Nuggets", startTimeMs: ref.startTimeMs, id: "b" }])!.id, "a");
assert.strictEqual(matchEvent(ref, [{ ...ref, startTimeMs: ref.startTimeMs + 7 * H }]), null);

console.log("sports checks passed");
