/**
 * Thin client for the BAAM relayer (see ../../../relayer/index.ts).
 *
 * The relayer is the oracle/crank service that talks to the Solana
 * `accountability` program on devnet. These helpers let the dashboard show
 * *real* chain status and drive the on-chain flows that the relayer exposes.
 *
 * Base URL is configurable via VITE_RELAYER_URL. By default, local Vite
 * development uses the local relayer and production uses the current origin.
 */

export const RELAYER_URL =
  (import.meta.env.VITE_RELAYER_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://localhost:8787" : window.location.origin);
export const AUTH_TOKEN_STORAGE_KEY = "BAAM_auth_token";
const REQUEST_TIMEOUT_MS = 10_000;

export interface RelayerHealth {
  ok: boolean;
  oracle: string;
  program: string;
  rpc: string;
  /** Current confirmed slot on the cluster — used as the live "block" counter. */
  slot: number;
  /** Whether MONGODB_URI is set on the relayer. */
  db?: "configured" | "unconfigured";
}

export interface GameResult {
  gameId: string;
  sport: Sport;
  homeWon: boolean | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  isFinal: boolean;
  status: string;
}

export interface ScoreboardGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  isFinal: boolean;
  startTime?: string;
  startTimeMs?: number;
}

export type Sport = "soccer" | "nba" | "nfl" | "nhl";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const token = readStoredAuthToken();
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${RELAYER_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `relayer ${res.status}`);
    }
    return res.json() as Promise<T>;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("relayer request timed out");
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

function readStoredAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}

/** Liveness + identity of the relayer/oracle and the cluster it's pointed at. */
export function getHealth(): Promise<RelayerHealth> {
  return req<RelayerHealth>("/health");
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  initials: string;
  createdAt: number;
}

export interface AuthResult {
  token: string;
  user: AuthUser;
}

export function signupWithEmail(input: {
  email: string;
  username: string;
  password: string;
}): Promise<AuthResult> {
  return req<AuthResult>("/auth/signup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function loginWithEmail(input: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  return req<AuthResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getCurrentAuthUser(): Promise<{ user: AuthUser }> {
  return req<{ user: AuthUser }>("/auth/me");
}

/** Discord integration is paused unless the build sets VITE_DISCORD_ENABLED=true. */
export const DISCORD_ENABLED = import.meta.env.VITE_DISCORD_ENABLED === "true";

export interface DiscordLinkResult {
  linked: boolean;
  username: string;
  discordUsername?: string;
  /** Deep link back to the Discord channel/DM the link was started from. */
  returnUrl?: string | null;
}

/**
 * Complete a Discord account link begun from the bot's `/setup` command.
 * `code` is the signed token carried in the `?discord_link=` query parameter.
 * Requires an authenticated session (Bearer token in localStorage).
 */
export function linkDiscord(code: string): Promise<DiscordLinkResult> {
  return req<DiscordLinkResult>("/discord/link", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export interface ProfileSummary {
  name: string;
  initials: string;
  github: string;
  wallet: string;
  /** SOL balance of the account wallet. */
  solBalance: number;
}
/** Profile details plus current SOL balance for the configured profile wallet. */
export function getProfileSummary(): Promise<ProfileSummary> {
  return req<ProfileSummary>("/profile");
}

/**
 * Upcoming sports-feed games currently exposed for sports betting.
 * For soccer, pass an optional `league` alias or numeric league id.
 */
export function getScoreboard(
  sport: Sport,
  league?: string,
): Promise<{ sport: Sport; league: string | null; games: ScoreboardGame[] }> {
  const qs = league ? `&league=${encodeURIComponent(league)}` : "";
  return req(`/scoreboard?sport=${sport}${qs}`);
}

/** Final result for a single game (null until the game is final). */
export function getGameResult(
  sport: Sport,
  id: string,
): Promise<{ result: GameResult | null }> {
  return req(`/game?sport=${sport}&id=${encodeURIComponent(id)}`);
}

/**
 * An on-chain 1v1 / group-chat sports wager. No witness is needed — the result
 * is verifiable from the sports feed and settled by the oracle crank.
 */
export interface SportsBet {
  pubkey: string;
  creator: string;
  /** null while the bet is still open (no opponent has matched the stake). */
  opponent: string | null;
  amountLamports: number;
  amountSol: number;
  oracle: string;
  sport: Sport;
  /** On-chain escrow identifier; newer bets use their unique database bet id. */
  gameId: string;
  /** true if the creator backs the home team (opponent gets the away side). */
  creatorBacksHome: boolean;
  /** Kickoff (unix seconds). You can back out up to 5 minutes before this. */
  startTime: number;
  /** Earliest settle time (unix seconds). */
  settleAfter: number;
  state: "open" | "locked" | "settled";
}

/** All on-chain sports bets. */
export function getSportsBets(): Promise<{ bets: SportsBet[] }> {
  return req("/sports-bets");
}

// ── MongoDB-backed dashboard data ─────────────────────────────────────────────
// These resolve once MONGODB_URI is set on the relayer; until then they reject
// with a 503 and the views should keep using their local fixtures.

export interface Group {
  id: string;
  name: string;
  initials: string;
  members: number;
  memberUsernames?: string[];
  pendingBet: boolean;
  lastMsg: string;
  time: string;
  updatedAt?: number;
}

export interface Profile {
  id: string;
  name: string;
  initials: string;
  github: string;
  bio?: string;
  sol: number;
  wins: number;
  disputes: number;
  streak: number;
  streakDir: "up" | "down" | "neutral";
  /** Placeholder for future per-user total bet volume metric. */
  betCount?: number;
  /** Placeholder for future per-user completion-rate metric (percentage). */
  completionRate?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  groupId: string;
  sender: string;
  initials: string;
  text?: string;
  betId?: string;
  system: boolean;
  ts: string;
  createdAt?: number;
}

export type BetVoteChoice = "challenger" | "acceptor";

export interface Bet {
  id: string;
  createdAt?: number;
  source?: "imessage" | "discord";
  discordConversationId?: string;
  groupId?: string;
  type: "PERSONAL" | "DEV";
  challenger: string;
  acceptor: string;
  terms: string;
  stake: string;
  currency: string;
  status: "PENDING" | "ACTIVE" | "RESOLVED" | "COMPLETED";
  witnesses: number;
  minBettors: number;
  groupSize: number;
  votesByVoter?: Record<string, BetVoteChoice>;
  resolvedWinner?: BetVoteChoice;
  acceptedBy?: string;
  acceptedAt?: number;
  commitmentId?: string;
  // ── on-chain escrow (SOL bets only) ──────────────────────────────────────────
  /** True once this bet is escrowed on-chain. */
  onChain?: boolean;
  /** sportsBet PDA backing the escrow. */
  betPda?: string;
  /** Username that staked the opposing side on-chain. */
  opponentUsername?: string;
  /** Lifecycle of the on-chain escrow account. */
  onChainState?: "open" | "locked" | "settled" | "cancelled";
  /** Transaction signatures for the create / accept / settle steps. */
  createSig?: string;
  acceptSig?: string;
  settleSig?: string;
  // ── external-validation (sports bets) ─────────────────────────────────────────
  /** Present for sports bets settled by the sports feed instead of witness votes. */
  validation?: "sports";
  sport?: SportKind;
  /** Stores the sports-feed event id used for settlement. */
  espnGameId?: string;
  homeTeam?: string;
  awayTeam?: string;
  /** True when the challenger backs the home side. */
  challengerBacksHome?: boolean;
  // ── witness-bet deadlines + unresolved fallback ───────────────────────────────
  acceptByDate?: number | null;
  resolveByDate?: number;
  fallbackKind?: "return" | "burn" | "charity";
  charityName?: string;
  /** On-chain account type: "social" (fallback enforced on-chain) or legacy "sports". */
  onChainKind?: "social" | "sports";
  /** Set once the resolve-by date passed with no verdict and the fallback ran (or is running). */
  fallbackApplied?: "return" | "burn" | "charity";
  /** Legacy escrow whose burn/charity fallback needs an operator; funds still escrowed. */
  fallbackBlocked?: boolean;
  /** Unaccepted offer whose accept-by deadline passed. */
  offerExpired?: boolean;
}

/** Outcome text for a bet that ended without a verdict (fallback/expiry), else null. */
export function betNoVerdictLabel(bet: Bet): string | null {
  if (bet.offerExpired) return "Offer expired — never accepted";
  if (bet.fallbackBlocked) {
    return `No verdict by deadline — ${bet.fallbackKind ?? "fallback"} awaiting operator (funds still escrowed)`;
  }
  if (!bet.fallbackApplied) return null;
  const done = bet.onChainState === "settled";
  switch (bet.fallbackApplied) {
    case "return": return done ? "Refunded — no verdict by deadline" : "Refund pending — no verdict by deadline";
    case "burn": return done ? "Burned — no verdict by deadline" : "Burn pending — no verdict by deadline";
    case "charity": {
      const to = bet.charityName ? ` to ${bet.charityName}` : " to charity";
      return done ? `Donated${to} — no verdict by deadline` : `Donation${to} pending — no verdict by deadline`;
    }
  }
}

/** Alias for the relayer sport union (see {@link Sport}). */
export type SportKind = Sport;

export interface Player {
  rank: number;
  name: string;
  initials: string;
  github: string;
  sol: number;
  solDelta: number;
  wins: number;
  disputes: number;
  streak: number;
  streakDir: "up" | "down" | "neutral";
  /** Placeholder for future per-user total bet volume metric. */
  betCount?: number;
  /** Placeholder for future per-user completion-rate metric (percentage). */
  completionRate?: number;
}

/** Group-chat list. */
export function getGroups(): Promise<{ groups: Group[] }> {
  return req("/groups");
}

/** Create a new chat group. */
export function createGroup(input: {
  name: string;
  initials?: string;
}): Promise<{ group: Group }> {
  return req("/groups", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Add a user (by username) to a group chat. */
export function addGroupMemberByUsername(
  groupId: string,
  username: string,
): Promise<{ group: Group; addedUsername: string; alreadyMember?: boolean }> {
  return req(`/groups/${encodeURIComponent(groupId)}/members`, {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

/** Leave a group chat as the authenticated user. */
export function leaveGroup(groupId: string): Promise<{ group: Group; leftUsername: string }> {
  return req(`/groups/${encodeURIComponent(groupId)}/leave`, {
    method: "POST",
  });
}

/** Messages for a group, chronological. */
export function getMessages(groupId: string): Promise<{ messages: ChatMessage[] }> {
  return req(`/messages?group=${encodeURIComponent(groupId)}`);
}

/** Append a chat message. */
export function postMessage(input: {
  groupId: string;
  text: string;
}): Promise<{ message: ChatMessage }> {
  return req("/messages", { method: "POST", body: JSON.stringify(input) });
}
/** Create a bet and linked system chat message for embedded card rendering. */
export function createBet(input: {
  groupId: string;
  type: "PERSONAL" | "DEV";
  acceptor: string;
  terms: string;
  stake: string;
  currency: "SOL";
  witnesses?: number;
  minBettors?: number;
  /** Witness (non-sports) bets: unix-ms deadline after which the unresolved fallback fires. */
  resolveByDate?: number;
  /** Witness (non-sports) bets: unix-ms accept deadline; omit/null for indefinite. */
  acceptByDate?: number | null;
  // Sports bets (internal DEV type): settled by the sports feed.
  sport?: SportKind;
  gameId?: string;
  backsHome?: boolean;
  homeTeam?: string;
  awayTeam?: string;
}): Promise<{ bet: Bet; message: ChatMessage }> {
  return req("/bets", { method: "POST", body: JSON.stringify(input) });
}

/** Accept a pending challenge as its intended opponent. */
export function acceptBet(betId: string): Promise<{ bet: Bet }> {
  return req("/bets/accept", { method: "POST", body: JSON.stringify({ betId }) });
}

/** Group-visible bets plus active witness bets open to third-party voting. */
export function getBets(): Promise<{ bets: Bet[] }> {
  return req("/bets");
}

/** Cast or update one witness vote for a bet. */
export function voteBet(input: {
  betId: string;
  votedFor: BetVoteChoice;
}): Promise<{ bet: Bet }> {
  return req("/bets/vote", { method: "POST", body: JSON.stringify(input) });
}

/** Solana explorer link for a devnet transaction signature. */
export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export interface DiscordLeaderboardServer {
  id: string;
  name: string;
  memberUsernames: string[];
}

/** Players ranked from Mongo bet history, optionally scoped to one Discord server. */
export function getLeaderboard(discordGuildId?: string): Promise<{
  players: Player[];
  discordServers: DiscordLeaderboardServer[];
  bets?: Bet[];
}> {
  const query = discordGuildId ? `?discordGuildId=${encodeURIComponent(discordGuildId)}` : "";
  return req(`/leaderboard${query}`);
}

/** All user profiles (Mongo-backed). */
export function getProfiles(): Promise<{ profiles: Profile[] }> {
  return req("/profiles");
}

/** Fetch one profile by id. */
export function getProfile(id: string): Promise<{ profile: Profile }> {
  return req(`/profiles/${encodeURIComponent(id)}`);
}

/** Create a profile document. */
export function createProfile(input: {
  name: string;
  initials?: string;
  github?: string;
  bio?: string;
  sol?: number;
  wins?: number;
  disputes?: number;
  streak?: number;
  streakDir?: "up" | "down" | "neutral";
}): Promise<{ profile: Profile }> {
  return req("/profiles", { method: "POST", body: JSON.stringify(input) });
}

/** Patch an existing profile document by id. */
export function updateProfile(
  id: string,
  input: Partial<Omit<Profile, "id" | "createdAt" | "updatedAt">>,
): Promise<{ profile: Profile }> {
  return req(`/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// ── points ──────────────────────────────────────────────────────────────────────
// Play-money points (no cash value: can't be bought, transferred, withdrawn, or
// converted to/from SOL). PTS bets never touch the chain; see relayer/points.ts.

export type BetCurrency = "PTS" | "SOL";

export type PointsLedgerKind = "grant" | "topup" | "hold" | "payout" | "refund" | "burn";

export interface PointsLedgerEntry {
  key: string;
  kind: PointsLedgerKind;
  /** Signed change to the balance (hold < 0; burn = 0 because the stake left at hold). */
  delta: number;
  /** Points involved (stake, pot, grant size). */
  amount: number;
  reason: string;
  betId: string | null;
  createdAt: number;
}

export interface PointsSummary {
  currency: "PTS";
  balance: number;
  /** Points currently held in the user's open/active bets (not spendable). */
  held: number;
  topup: {
    floor: number;
    claimable: boolean;
    /** Points a claim right now would add (0 when not claimable). */
    amount: number;
    claimedToday: boolean;
    /** Unix ms of the next UTC midnight. */
    resetsAt: number;
  };
  signupGrant: number;
  ledger: PointsLedgerEntry[];
  /** What POST /bets accepts; `default` applies when `currency` is omitted. */
  betCurrencies: { allowed: BetCurrency[]; default: BetCurrency };
}

/** Points-escrow fields present on PTS bets (alongside the base {@link Bet}). */
export interface PointsBetFields {
  pointsState?: "open" | "held" | "settled" | "refunded" | "burned";
  pointsSettlement?:
    | { type: "winner"; winner: BetVoteChoice }
    | { type: "refund"; reason: string }
    | { type: "burn"; reason: string };
  pointsSettledAt?: number;
}

export type PointsBet = Bet & PointsBetFields;

export function isPointsBet(bet: Pick<Bet, "currency">): boolean {
  return bet.currency === "PTS";
}

/** Balance, held stakes, top-up status and recent ledger entries for the signed-in user. */
export function getPoints(limit?: number): Promise<{ points: PointsSummary }> {
  return req(`/points${limit ? `?limit=${encodeURIComponent(String(limit))}` : ""}`);
}

/** Claim the daily top-up (refills a balance below the floor up to it, once per UTC day). */
export function claimPointsTopup(): Promise<{ claimed: number; points: PointsSummary }> {
  return req("/points/topup", { method: "POST", body: "{}" });
}

/**
 * Create a bet in either currency. PTS stakes are whole numbers ≥ 1 and PTS bets
 * can't use a charity fallback (return or burn only).
 */
export function createBetInCurrency(
  input: Omit<Parameters<typeof createBet>[0], "currency"> & {
    currency: BetCurrency;
    fallbackKind?: "return" | "burn" | "charity";
    charityAddress?: string;
    charityName?: string;
  },
): Promise<{ bet: PointsBet; message: ChatMessage }> {
  return req("/bets", { method: "POST", body: JSON.stringify(input) });
}

/** Leaderboard ranked in one currency; PTS players carry a `points` balance. */
export function getLeaderboardByCurrency(
  currency: BetCurrency,
  discordGuildId?: string,
): Promise<{
  currency: BetCurrency;
  players: Array<Player & { points?: number }>;
  discordServers: DiscordLeaderboardServer[];
  bets?: Bet[];
}> {
  const params = new URLSearchParams({ currency });
  if (discordGuildId) params.set("discordGuildId", discordGuildId);
  return req(`/leaderboard?${params.toString()}`);
}

/** "100 PTS" / "0.5 SOL". */
export function formatStake(bet: Pick<Bet, "stake" | "currency">): string {
  return `${bet.stake} ${bet.currency || "SOL"}`;
}

/** Escrow status text for a points bet (the on-chain labels don't apply). */
export function pointsBetLabel(bet: PointsBet): string | null {
  if (!isPointsBet(bet)) return null;
  if (bet.offerExpired) return "Offer expired — never accepted";
  switch (bet.pointsState) {
    case "open": return "Points held · awaiting a taker";
    case "held": return bet.pointsSettlement || bet.fallbackApplied ? "Settling points…" : "Points locked";
    case "settled": return "Points paid out";
    case "refunded": return bet.fallbackApplied ? "Refunded — no verdict by deadline" : "Points refunded";
    case "burned": return "Burned — no verdict by deadline";
    default: return null;
  }
}

// ── proof, check-ins, stats ──────────────────────────────────────────────────
// Relayer side: relayer/features.ts, relayer/proofs.ts, relayer/checkins.ts, relayer/stats.ts.

/** Evidence attached to a witness bet (image, link and/or caption). */
export interface ProofSummary {
  id: string;
  uploader: string;
  createdAt: number;
  /** Set when the proof belongs to a check-in on a recurring bet. */
  checkinId: string | null;
  caption: string | null;
  link: string | null;
  /** `url` is a signed, relative path usable directly as `<img src>` (see {@link proofImageUrl}). */
  image: { url: string; contentType: string; bytes: number } | null;
}

/** Recurring-bet schedule. Days: 0 = Sunday … 6 = Saturday; times are wall clock in `timezone`. */
export interface BetSchedule {
  daysOfWeek: number[];
  timezone: string;
  startDate: string;
  endDate: string;
  windowStart?: string;
  windowEnd?: string;
}

export type CheckinOccurrenceState =
  | "upcoming" | "open" | "submitted" | "approved" | "rejected" | "missed"
  | "approved-by-default" | "lapsed" | "unreviewed";

export interface CheckinReview { reviewer: string; approve: boolean; at: number }

export interface CheckinSummary {
  id: string;
  occurrenceKey: string;
  occurrenceStart: number;
  occurrenceEnd: number;
  doer: string;
  submittedAt: number;
  caption: string | null;
  proofIds: string[];
  status: "pending" | "approved" | "rejected";
  reviews: CheckinReview[];
  approvals: number;
  rejections: number;
  decidedAt: number | null;
}

export interface CheckinWindow { key: string; start: number; end: number }

export interface CheckinProgress {
  schedule: BetSchedule;
  doer: BetVoteChoice;
  doerUsername: string | null;
  required: number;
  total: number;
  approved: number;
  /** Max approvals still reachable; the doer loses once this drops below `required`. */
  possible: number;
  submitted: number;
  pendingReview: number;
  verdictDeadline: number | null;
  currentWindow: CheckinWindow | null;
  nextWindow: CheckinWindow | null;
  occurrences: Array<CheckinWindow & { state: CheckinOccurrenceState; checkinId: string | null }>;
  decision:
    | { winner: "doer" | "other"; reason: string }
    | { winner: null; reason: "in-progress" | "witnesses-silent" };
  verdictReason: string | null;
}

export interface BetViewerActions {
  canAddProof: boolean;
  canCheckin: boolean;
  canReview: boolean;
  canVote: boolean;
}

// Declaration merging: the relayer adds these fields to every Bet payload.
export interface Bet {
  proofCount?: number;
  proofs?: ProofSummary[];
  /** Present on recurring (check-in) bets; their outcome comes from check-ins, not votes. */
  schedule?: BetSchedule;
  requiredCheckins?: number;
  doer?: BetVoteChoice;
  resolvedAt?: number;
  checkinVerdictReason?: string;
  checkins?: CheckinSummary[];
  checkinProgress?: CheckinProgress | null;
  viewerActions?: BetViewerActions;
}

/** Absolute URL for a proof image (works in `<img src>`; the path carries a short-lived signature). */
export function proofImageUrl(proof: ProofSummary): string | null {
  return proof.image ? `${RELAYER_URL}${proof.image.url}` : null;
}

/** One bet with proofs + check-in progress (participants and chat members only). */
export function getBet(betId: string): Promise<{ bet: Bet }> {
  return req(`/bets/${encodeURIComponent(betId)}`);
}

export interface ProofInput {
  /** Image file (JPEG/PNG/WebP/HEIC, ≤ 2 MB) or a data URL. */
  image?: Blob | string;
  /** http(s) link, e.g. a Strava activity. */
  link?: string;
  /** ≤ 280 characters. */
  caption?: string;
}

/** POST a Blob as the raw body (other fields in the query string), or everything as JSON. */
function postProofBody<T>(path: string, input: ProofInput, extra: Record<string, string | string[] | undefined>): Promise<T> {
  if (input.image instanceof Blob) {
    const params = new URLSearchParams();
    const fields = { link: input.link, caption: input.caption, ...extra };
    for (const [key, value] of Object.entries(fields)) {
      if (value && value.length) params.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    const query = params.toString();
    return req(`${path}${query ? `?${query}` : ""}`, {
      method: "POST",
      headers: { "content-type": input.image.type || "application/octet-stream" },
      body: input.image,
    });
  }
  return req(path, { method: "POST", body: JSON.stringify({ ...input, ...extra }) });
}

/** Attach proof to a bet you're part of (optionally to one of your pending check-ins). */
export function uploadProof(
  betId: string,
  input: ProofInput & { checkinId?: string },
): Promise<{ proof: ProofSummary }> {
  const { checkinId, ...rest } = input;
  return postProofBody(`/bets/${encodeURIComponent(betId)}/proof`, rest, { checkinId });
}

/** Recurring-bet fields for POST /bets (resolveByDate is derived by the relayer). */
export interface CheckinBetFields {
  schedule: BetSchedule;
  /** Default: every occurrence. */
  requiredCheckins?: number;
  /** Who does the habit (default "challenger"). */
  doer?: BetVoteChoice;
}

/** Create a recurring check-in bet (createBet plus a schedule). */
export function createCheckinBet(
  input: Omit<Parameters<typeof createBet>[0], "resolveByDate"> & CheckinBetFields,
): Promise<{ bet: Bet; message: ChatMessage }> {
  return req("/bets", { method: "POST", body: JSON.stringify(input) });
}

/** Doer checks in for the open window (or `occurrenceKey`, which must be open now) with proof. */
export function submitCheckin(
  betId: string,
  input: ProofInput & { occurrenceKey?: string; proofIds?: string[] },
): Promise<{ checkin: CheckinSummary; bet: Bet }> {
  const { occurrenceKey, proofIds, ...rest } = input;
  return postProofBody(`/bets/${encodeURIComponent(betId)}/checkins`, rest, { occurrenceKey, proofIds });
}

/** Witness approves/rejects a check-in; the review may decide the bet. */
export function reviewCheckin(
  betId: string,
  checkinId: string,
  approve: boolean,
): Promise<{ checkin: CheckinSummary; bet: Bet; betDecided: boolean; resolvedWinner?: BetVoteChoice }> {
  return req(`/bets/${encodeURIComponent(betId)}/checkins/${encodeURIComponent(checkinId)}/review`, {
    method: "POST",
    body: JSON.stringify({ approve }),
  });
}

export function getCheckins(betId: string): Promise<{ checkins: CheckinSummary[]; progress: CheckinProgress | null }> {
  return req(`/bets/${encodeURIComponent(betId)}/checkins`);
}

export type BetResult = "win" | "loss" | "refund" | "forfeit";

export interface CurrencyTotals {
  wins: number;
  losses: number;
  refunds: number;
  forfeits: number;
  staked: number;
  net: number;
}

export interface HeadToHead {
  opponent: string;
  played: number;
  wins: number;
  losses: number;
  refunds: number;
  forfeits: number;
  active: number;
  lastResult: { result: BetResult; betId: string; at: number; currency: "SOL" | "PTS" } | null;
}

export interface UserStats {
  username: string;
  wins: number;
  losses: number;
  refunds: number;
  forfeits: number;
  active: number;
  pending: number;
  winRate: number | null;
  currentWinStreak: number;
  longestWinStreak: number;
  /** +n = won the last n, −n = lost the last n. */
  form: number;
  currentCheckinStreak: number;
  longestCheckinStreak: number;
  checkins: { approved: number; missed: number; total: number };
  byCurrency: Record<"SOL" | "PTS", CurrencyTotals>;
  /** Sorted by most played. */
  headToHead: HeadToHead[];
  recent: Array<{ betId: string; result: BetResult; opponent: string | null; at: number; currency: "SOL" | "PTS"; terms: string }>;
}

/** Record, streaks and rivalries, computed only from bets the viewer can already see. */
export function getUserStats(username: string): Promise<{ stats: UserStats; scope: "self" | "shared" }> {
  return req(`/stats/${encodeURIComponent(username)}`);
}
