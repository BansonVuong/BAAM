// relayer/scraper.ts
//
// Backward-compatible facade over relayer/sports/ (provider abstraction: ESPN
// primary, TheSportsDB for legacy bets / optional cross-check). New code should
// import from "./sports" directly.

export {
  fetchScoreboard,
  fetchGameResult,
  getFinalResult,
  SOCCER_LEAGUES,
  type Sport,
  type GameResult,
  type ScoreboardGame,
  type FetchScoreboardOptions,
} from "./sports";
