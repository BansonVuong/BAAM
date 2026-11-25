// relayer/index.ts
//
// Env vars:
//   ORACLE_KEYPAIR    path to keypair JSON  (default ~/.config/solana/id.json)
//   SOLANA_RPC_URL    RPC endpoint           (default devnet)
//   HOST              HTTP bind address      (default 127.0.0.1)
//   PORT              HTTP port              (default 8787)
//   POLL_INTERVAL_MS  crank interval ms      (default 60_000)
//   PROFILE_NAME      profile display name   (default "Me")
//   PROFILE_INITIALS  profile initials       (default "ME")
//   PROFILE_GITHUB    profile github handle  (default "me")
//   PROFILE_WALLET    profile wallet pubkey  (default oracle pubkey)
//   AUTH_SECRET       HMAC signing secret for auth sessions
//   AUTH_SESSION_TTL_MS session lifetime in milliseconds (default 30 days)
//   OPERATOR_TOKEN    secret for operator-only routes (POST /verify, POST /settle-bet),
//                     sent as "Authorization: Bearer <token>". Unset = those routes 404.
//   MONGODB_URI       Mongo connection string (optional; enables data routes)
//   MONGODB_DB        Mongo database name     (default "accountabilibuddy")
//   DISCORD_ENABLED          "true" to enable the Discord integration (default off)
//   DISCORD_BOT_TOKEN        Discord bot token (needed when DISCORD_ENABLED=true)
//   DISCORD_APPLICATION_ID   Discord app/client ID (for slash command registration)
//   WEB_BASE_URL             Public URL of the web app (for Discord embed links)
//   BET_CURRENCIES    comma list of currencies POST /bets accepts: PTS (play-money
//                     points, off-chain) and/or SOL (devnet escrow). Default "PTS,SOL";
//                     set "PTS" to disable SOL bets. The FIRST entry is the default
//                     when a client omits `currency` (current web/iOS clients send
//                     "SOL" explicitly). Points never convert to or from SOL.
//   POINTS_SIGNUP_GRANT one-time points grant per user (default 1000)
//   POINTS_TOPUP_FLOOR  once per UTC day a balance below this can be refilled up to it
//                       (default 100; 0 disables top-ups)
//   POINTS_SPORTS_RESULT_TIMEOUT_HOURS refund a held points sports bet if the feed has
//                       no final result this long after settle time (default 168)
//   POINTS_STALE_MS     age after which the crank recovers a crashed points op or
//                       accept attempt (default 120000)
//
// Sports data (relayer/sports/; ESPN's keyless public JSON API is the default feed):
//   SPORTS_PROVIDER            provider for /scoreboard + new sports bets: espn (default) | thesportsdb
//   SPORTS_SECONDARY_PROVIDER  optional cross-check before paying a winner: thesportsdb | espn (unset = off).
//                              Disagreement blocks the bet (sportsSettlementBlocked) for an operator.
//   SPORTSDB_API_KEY           TheSportsDB key (unset/"3" = disabled; "3" is permanently 403). Needed to
//                              settle legacy bets created on TheSportsDB ids; "123" is the free test key,
//                              a paid key is needed for full schedules / cross-checking.
//   SPORTSDB_API_BASE          default https://www.thesportsdb.com/api/v1/json
//   ESPN_API_BASE              default https://site.api.espn.com/apis/site/v2/sports
//   SPORTS_CANCEL_GRACE_HOURS  postponed/cancelled games refund both sides this long after the
//                              scheduled kickoff (default 48)
//   SPORTS_RESULT_MAX_AGE_MS   never settle from a provider snapshot older than this (default 180000)
//   SPORTS_SOCCER_SHOOTOUT     winner (default: shootout winner is paid) | draw (shootouts refund)
//   SPORTS_SOCCER_LEAGUES      soccer leagues when none is requested (default
//                              epl,laliga,seriea,bundesliga,ligue1,mls,ucl; worldcup also accepted)
//   SPORTS_SCOREBOARD_CACHE_MS scoreboard cache TTL (default 60000)
//   SPORTS_EVENT_CACHE_MS      single-event cache TTL for display/lookups (default 15000)
//   SPORTS_HTTP_TIMEOUT_MS     per-request timeout (default 8000)
//   SPORTS_HTTP_RETRIES        retries on timeout/5xx/429 with backoff (default 2)

import "dotenv/config";
import crypto from "crypto";

import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { AnchorProvider, BN, Program, Wallet, web3 } from "@anchor-lang/core";

import {
  decideSportsSettlement,
  fetchScoreboard,
  findLeague,
  getCrossCheckResult,
  getFinalResult,
  getSportsProvider,
  isSportsProviderId,
  mapLimit,
  primarySportsProviderId,
  secondarySportsProviderId,
  teamNamesMatch,
  SPORTS_CANCEL_GRACE_MS,
  SPORTS_RESULT_MAX_AGE_MS,
  SPORTS_UNAVAILABLE_MESSAGE,
  type FinalResult,
  type Sport,
  type SportsEvent,
  type SportsProviderId,
} from "./sports";
import {
  isDbConfigured, groups, messages, bets, players, profiles, users, imessageConversations, discordConversations, type GroupDoc, type MessageDoc, type ProfileDoc, type PlayerDoc, type UserDoc, type BetDoc, type IMessageConversationDoc, type DiscordConversationDoc,
} from "./db";
import { startDiscordBot, verifyDiscordLinkCode, announceDiscordLink } from "./discord";
import { fallbackLabel, isWitnessOfferExpired, witnessCrankAction } from "./witness-fallback";
import * as points from "./points";
import { visibleBetsFilter } from "./bet-visibility";
import {
  crankCheckinBets, decorateBetsForViewer, decorateIMessageCard, handleFeatureRoutes, parseScheduledBetInput,
  SCHEDULED_BET_VOTE_ERROR, type FeatureContext,
} from "./features";
import idl from "./generated/accountability.json";
import type { Accountability } from "./generated/accountability";

// ── config ───────────────────────────────────────────────────────────────────

const RPC_URL         = process.env.SOLANA_RPC_URL ?? web3.clusterApiUrl("devnet");
const ORACLE_KP_PATH  = process.env.ORACLE_KEYPAIR ?? "~/.config/solana/id.json";
const HOST            = process.env.HOST ?? "127.0.0.1";
const PORT            = Number(process.env.PORT ?? 8787);
const POLL_INTERVAL   = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const PROFILE_NAME    = process.env.PROFILE_NAME ?? "Me";
const PROFILE_INITIALS = process.env.PROFILE_INITIALS ?? "ME";
const PROFILE_GITHUB   = process.env.PROFILE_GITHUB ?? "me";
const AUTH_SECRET = process.env.AUTH_SECRET ?? "dev-only-insecure-auth-secret";
const AUTH_SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS ?? 1000 * 60 * 60 * 24 * 30);
// Operator-only routes make the oracle sign on-chain (or run a crank), so they are
// never exposed to end users. Unset disables them entirely.
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN?.trim() ?? "";
// The Discord integration is paused: the bot, /discord/* routes, new Discord bets and
// per-server leaderboards stay off unless explicitly enabled. Existing Discord bets
// still settle and still count toward overall standings.
const DISCORD_ENABLED = process.env.DISCORD_ENABLED === "true";

// Custodial wallets + on-chain SOL bets.
//   WALLET_SECRET_KEY      encryption key for stored wallet secrets (falls back to AUTH_SECRET)
//   WALLET_AIRDROP_LAMPORTS devnet airdrop per new wallet (default 2 SOL)
//   SPORTS_BET_CREATE_WINDOW_SECS max lead time before kickoff to create a sports bet (default 24h)
//   SPORTS_BET_SCOREBOARD_LOOKAHEAD_DAYS how many future days to fetch for upcoming sports games (default 3)
//   SPORTS_BET_SETTLE_AFTER_SECS earliest settle-at offset after kickoff for sports bets (default 60s)
//   SOCIAL_BET_SETTLE_DELAY_SECS  delay before an accepted witness bet can settle (default 15s)
const WALLET_AIRDROP_LAMPORTS = Number(process.env.WALLET_AIRDROP_LAMPORTS ?? 2 * web3.LAMPORTS_PER_SOL);
const SPORTS_BET_CREATE_WINDOW_SECS = Number(process.env.SPORTS_BET_CREATE_WINDOW_SECS ?? 24 * 60 * 60);
const SPORTS_BET_SCOREBOARD_LOOKAHEAD_DAYS = Number(process.env.SPORTS_BET_SCOREBOARD_LOOKAHEAD_DAYS ?? 3);
const SPORTS_BET_SETTLE_AFTER_SECS = Number(process.env.SPORTS_BET_SETTLE_AFTER_SECS ?? 60);
// Witness bets escrow both stakes atomically at acceptance, so this only spans that
// single transaction. A posted witness bet itself never expires — it waits for a taker.
const SOCIAL_BET_SETTLE_DELAY_SECS = Number(
  process.env.SOCIAL_BET_SETTLE_DELAY_SECS ?? 15,
);
const SOCIAL_BET_SPORT        = 0; // reuse the sportsBet program; sport is irrelevant for chat bets
const BET_BALANCE_BUFFER_LAMPORTS = Number(
  process.env.BET_BALANCE_BUFFER_LAMPORTS ?? 0.02 * web3.LAMPORTS_PER_SOL,
);

const VAULT_SEED        = Buffer.from("vault");
const SPORTS_BET_SEED   = Buffer.from("sports_bet");
const SPORTS_VAULT_SEED = Buffer.from("sports_vault");
const SOCIAL_BET_SEED   = Buffer.from("social_bet");
const SOCIAL_VAULT_SEED = Buffer.from("social_vault");

// Standard Solana incinerator — burned lamports are unrecoverable.
const BURN_ADDRESS = new web3.PublicKey("1nc1nerator11111111111111111111111111111111");
const FALLBACK_KIND_CODE: Record<string, number> = { return: 0, burn: 1, charity: 2 };
// New witness bets escrow into SocialBet (escrow_bet/settle_social, fallback enforced
// on-chain). Set SOCIAL_ESCROW_ENABLED=false to fall back to the legacy SportsBet path.
const SOCIAL_ESCROW_ENABLED = process.env.SOCIAL_ESCROW_ENABLED !== "false";
// Accepting must leave room before the on-chain end_date (escrow_bet requires end_date > now).
const SOCIAL_ESCROW_MIN_WINDOW_SECS = 60;

const WALLET_ENC_KEY = deriveWalletKey();

// ── Solana setup ──────────────────────────────────────────────────────────────

const oracle   = loadKeypair(ORACLE_KP_PATH);
const connection = new web3.Connection(RPC_URL, "confirmed");
const provider   = new AnchorProvider(connection, new Wallet(oracle), AnchorProvider.defaultOptions());
const program    = new Program<Accountability>(idl as Accountability, provider);
const profileWallet = parsePublicKey(process.env.PROFILE_WALLET, oracle.publicKey);

// ── custodial wallets ───────────────────────────────────────────────────────────
// Each user gets a relayer-managed devnet keypair. The secret is stored encrypted;
// the relayer signs create/accept on the user's behalf (settle is signed by the oracle).

function deriveWalletKey(): Buffer {
  const raw = process.env.WALLET_SECRET_KEY;
  if (raw && raw.length > 0) return crypto.createHash("sha256").update(raw).digest();
  console.warn("WALLET_SECRET_KEY not set; deriving custodial wallet key from AUTH_SECRET");
  return crypto.createHash("sha256").update(`wallet:${AUTH_SECRET}`).digest();
}

function encryptSecret(plain: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", WALLET_ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptSecret(stored: string): Buffer {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed wallet secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", WALLET_ENC_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
}

function loadUserKeypair(user: UserDoc): web3.Keypair {
  if (!user.walletSecret) throw new Error(`user ${user.username} has no custodial wallet`);
  return web3.Keypair.fromSecretKey(Uint8Array.from(decryptSecret(user.walletSecret)));
}

const isDevnet = /devnet/i.test(RPC_URL);

async function airdrop(pubkey: web3.PublicKey, lamports: number): Promise<void> {
  if (!isDevnet || lamports <= 0) return;
  const sig = await connection.requestAirdrop(pubkey, lamports);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  console.log(`airdropped ${lamports / web3.LAMPORTS_PER_SOL} SOL to ${pubkey.toBase58()}`);
}


/** Provision (and devnet-fund) a custodial wallet on first need; mutates `user`. */
async function ensureUserWallet(user: UserDoc): Promise<web3.Keypair> {
  if (user.walletPubkey && user.walletSecret) return loadUserKeypair(user);
  const col = await users();
  if (!col) throw new Error("database unavailable");
  const kp = web3.Keypair.generate();
  user.walletPubkey = kp.publicKey.toBase58();
  user.walletSecret = encryptSecret(Buffer.from(kp.secretKey));
  await col.updateOne({ id: user.id }, { $set: { walletPubkey: user.walletPubkey, walletSecret: user.walletSecret } });
  await airdrop(kp.publicKey, WALLET_AIRDROP_LAMPORTS).catch((err) =>
    console.warn(`airdrop failed for ${user.walletPubkey}:`, err instanceof Error ? err.message : err),
  );
  return kp;
}

/** A Program bound to `keypair` as fee-payer/signer (the oracle `program` settles). */
function programAs(keypair: web3.Keypair): Program<Accountability> {
  const prov = new AnchorProvider(connection, new Wallet(keypair), AnchorProvider.defaultOptions());
  return new Program<Accountability>(idl as Accountability, prov);
}

// ── on-chain chat-bet (reuses the sportsBet escrow) ─────────────────────────────

function gameIdBytes(id: string): number[] {
  if (Buffer.byteLength(id, "utf8") > 32) throw new Error("bet id too long for on-chain game id");
  const buf = Buffer.alloc(32);
  Buffer.from(id, "utf8").copy(buf);
  return Array.from(buf);
}

function sportsBetPda(creator: web3.PublicKey, gameId: number[]): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [SPORTS_BET_SEED, creator.toBuffer(), Buffer.from(gameId)],
    program.programId,
  )[0];
}

function sportsVaultPda(bet: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync([SPORTS_VAULT_SEED, bet.toBuffer()], program.programId)[0];
}

function socialBetPda(challenger: web3.PublicKey, betId: number[]): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [SOCIAL_BET_SEED, challenger.toBuffer(), Buffer.from(betId)],
    program.programId,
  )[0];
}

function socialVaultPda(bet: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync([SOCIAL_VAULT_SEED, bet.toBuffer()], program.programId)[0];
}

function solStakeToLamports(stake: string): number {
  const n = Number(stake);
  if (!Number.isFinite(n) || n <= 0) throw new Error("invalid SOL stake");
  const lamports = Math.round(n * web3.LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error("SOL stake too small");
  return lamports;
}

class InsufficientSolBalanceError extends Error {
  constructor(
    public readonly actor: "challenger" | "acceptor",
    public readonly availableLamports: number,
    public readonly requiredLamports: number,
  ) {
    super(
      `${actor} has insufficient SOL: requires ${formatSol(requiredLamports)} SOL, available ${formatSol(availableLamports)} SOL`,
    );
    this.name = "InsufficientSolBalanceError";
  }
}

function formatSol(lamports: number): string {
  return (lamports / web3.LAMPORTS_PER_SOL).toFixed(4);
}
async function currentUnixTimeSec(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

function isSportsBetWithinCreateWindow(startTimeSec: number, nowSec: number): boolean {
  if (startTimeSec <= nowSec) return false;
  return (startTimeSec - nowSec) <= SPORTS_BET_CREATE_WINDOW_SECS;
}

async function requireSolBalanceForBet(
  pubkey: web3.PublicKey,
  amountLamports: number,
  actor: "challenger" | "acceptor",
): Promise<void> {
  const requiredLamports = amountLamports + BET_BALANCE_BUFFER_LAMPORTS;
  const availableLamports = await connection.getBalance(pubkey, "confirmed");
  if (availableLamports < requiredLamports) {
    throw new InsufficientSolBalanceError(actor, availableLamports, requiredLamports);
  }
}

// ── original accountability crank ─────────────────────────────────────────────

async function resolveSuccess(commitmentId: string): Promise<string> {
  const commitment = new web3.PublicKey(commitmentId);
  const account    = await program.account.commitment.fetch(commitment);

  if (!account.oraclePubkey.equals(oracle.publicKey)) {
    throw new Error(`oracle mismatch for commitment ${commitmentId}`);
  }

  const [vault] = web3.PublicKey.findProgramAddressSync(
    [VAULT_SEED, commitment.toBuffer()],
    program.programId,
  );

  return program.methods.resolve(true)
    .accountsStrict({
      oracle: oracle.publicKey,
      staker: account.staker,
      commitment,
      vault,
      destination: account.failureDestination,
    })
    .rpc();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function crankTimeouts(): Promise<void> {
  const slot = await connection.getSlot("confirmed");
  const now  = await connection.getBlockTime(slot);
  if (now === null) return;

  const commitments = await program.account.commitment.all();
  for (const { publicKey, account } of commitments) {
    if (!("active" in account.state) || account.deadline.gtn(now)) continue;

    const [vault] = web3.PublicKey.findProgramAddressSync(
      [VAULT_SEED, publicKey.toBuffer()],
      program.programId,
    );

    try {
      const sig = await program.methods.timeout()
        .accountsStrict({
          cranker:    oracle.publicKey,
          staker:     account.staker,
          commitment: publicKey,
          vault,
          destination: account.failureDestination,
        })
        .rpc();
      console.log(`timed out ${publicKey.toBase58()}: ${sig}`);
    } catch (err) {
      console.error(`timeout failed for ${publicKey.toBase58()}:`, err);
    }
  }
}

// ── sports bet helpers ────────────────────────────────────────────────────────

const SUPPORTED_SPORTS: Sport[] = ["soccer", "nba", "nfl", "nhl"];
// On-chain program currently allows sport ids 0..2 only. NHL shares id=2; the
// Mongo bet document keeps the true source sport for settlement lookups.
const ON_CHAIN_SPORT_BY_INDEX: Record<number, Exclude<Sport, "nhl">> = {
  0: "soccer",
  1: "nba",
  2: "nfl",
};
const ON_CHAIN_SPORT_INDEX: Record<Sport, number> = {
  soccer: 0,
  nba: 1,
  nfl: 2,
  nhl: 2,
};
type BetVoteChoice = "challenger" | "acceptor";

function isSupportedSport(value: unknown): value is Sport {
  return typeof value === "string" && SUPPORTED_SPORTS.includes(value as Sport);
}

function normalizeBetStatus(status: BetDoc["status"]): BetDoc["status"] {
  return status === "RESOLVED" ? "COMPLETED" : status;
}

function normalizeVotesByVoter(input: BetDoc["votesByVoter"]): Record<string, BetVoteChoice> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, BetVoteChoice> = {};
  for (const [voter, choice] of Object.entries(input)) {
    if ((choice === "challenger" || choice === "acceptor") && voter.trim()) {
      out[voter] = choice;
    }
  }
  return out;
}

function normalizeBetDoc(doc: BetDoc): BetDoc {
  return {
    ...doc,
    status: normalizeBetStatus(doc.status),
    votesByVoter: normalizeVotesByVoter(doc.votesByVoter),
  };
}

function isBetCompletedStatus(status: BetDoc["status"]): boolean {
  return normalizeBetStatus(status) === "COMPLETED";
}

function inferBetCreatedAt(doc: BetDoc): number {
  if (typeof doc.createdAt === "number" && Number.isFinite(doc.createdAt)) return doc.createdAt;
  const match = /^bet-(\d+)-/.exec(doc.id);
  const parsed = match?.[1] ? Number(match[1]) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildLeaderboardPlayers(
  userDocs: UserDoc[],
  profileDocs: ProfileDoc[],
  legacyPlayers: PlayerDoc[],
  betDocs: BetDoc[],
): PlayerDoc[] {
  type MutablePlayer = PlayerDoc & { outcomes: Array<{ won: boolean; at: number }> };
  const byUsername = new Map<string, MutablePlayer>();
  const profileByHandle = new Map(profileDocs.map((profile) => [profile.github.toLowerCase(), profile]));
  const legacyByHandle = new Map(legacyPlayers.map((player) => [player.github.toLowerCase(), player]));

  const ensurePlayer = (username: string): MutablePlayer | null => {
    const key = username.trim().replace(/^@/, "").toLowerCase();
    if (!key || key === "anyone") return null;
    const existing = byUsername.get(key);
    if (existing) return existing;
    const profile = profileByHandle.get(key);
    const legacy = legacyByHandle.get(key);
    const created: MutablePlayer = {
      rank: 0,
      name: profile?.name ?? legacy?.name ?? username,
      initials: profile?.initials ?? legacy?.initials ?? toInitials(username),
      github: profile?.github ?? legacy?.github ?? username,
      sol: profile?.sol ?? legacy?.sol ?? 0,
      solDelta: legacy?.solDelta ?? 0,
      wins: 0,
      disputes: 0,
      streak: 0,
      streakDir: "neutral",
      betCount: 0,
      completionRate: 0,
      outcomes: [],
    };
    byUsername.set(key, created);
    return created;
  };

  for (const user of userDocs) ensurePlayer(user.username);
  for (const profile of profileDocs) ensurePlayer(profile.github);
  for (const player of legacyPlayers) ensurePlayer(player.github);

  for (const raw of betDocs) {
    const bet = normalizeBetDoc(raw);
    const challenger = ensurePlayer(bet.challenger);
    const acceptorName = bet.acceptedBy ?? bet.opponentUsername ?? bet.acceptor;
    const acceptor = ensurePlayer(acceptorName);
    if (challenger) challenger.betCount = (challenger.betCount ?? 0) + 1;
    if (acceptor) acceptor.betCount = (acceptor.betCount ?? 0) + 1;

    const winner = getBetResolvedWinner(bet);
    if (!winner || !isBetCompletedStatus(bet.status) || !challenger || !acceptor) continue;
    const at = inferBetCreatedAt(bet);
    const winnerPlayer = winner === "challenger" ? challenger : acceptor;
    const loserPlayer = winner === "challenger" ? acceptor : challenger;
    winnerPlayer.wins += 1;
    winnerPlayer.disputes += 1;
    loserPlayer.disputes += 1;
    winnerPlayer.outcomes.push({ won: true, at });
    loserPlayer.outcomes.push({ won: false, at });
  }

  const ranked = [...byUsername.values()].map(({ outcomes, ...player }) => {
    const ordered = [...outcomes].sort((a, b) => b.at - a.at);
    const latest = ordered[0]?.won;
    let streak = 0;
    for (const outcome of ordered) {
      if (outcome.won !== latest) break;
      streak += 1;
    }
    return {
      ...player,
      streak,
      streakDir: latest === undefined ? "neutral" as const : latest ? "up" as const : "down" as const,
      completionRate: player.betCount
        ? Math.round((player.disputes / player.betCount) * 100)
        : 0,
    };
  }).sort((a, b) => b.sol - a.sol || b.wins - a.wins || a.name.localeCompare(b.name));

  return ranked.map((player, index) => ({ ...player, rank: index + 1 }));
}

function countBetVotes(votesByVoter: Record<string, BetVoteChoice>): {
  challenger: number;
  acceptor: number;
  total: number;
} {
  let challenger = 0;
  let acceptor = 0;
  for (const choice of Object.values(votesByVoter)) {
    if (choice === "challenger") challenger += 1;
    if (choice === "acceptor") acceptor += 1;
  }
  return { challenger, acceptor, total: challenger + acceptor };
}

type BetPresentationStatus = "pending" | "active" | "completed";

function getBetResolvedWinner(doc: BetDoc): BetVoteChoice | undefined {
  const normalized = normalizeBetDoc(doc);
  if (normalized.status === "PENDING") return undefined;
  // A committed/blocked fallback is final: late (racing) votes never produce a winner.
  if (normalized.fallbackApplied || normalized.fallbackBlocked) return undefined;
  if (normalized.resolvedWinner) return normalized.resolvedWinner;
  const votes = countBetVotes(normalized.votesByVoter ?? {});
  const threshold = Math.max(1, Number(normalized.witnesses) || 1);
  if (votes.challenger >= threshold) return "challenger";
  if (votes.acceptor >= threshold) return "acceptor";
  return undefined;
}

function getBetPresentationStatus(doc: BetDoc): BetPresentationStatus {
  // A fallback/expiry is final even if a racing vote rewrote `status`.
  if (doc.fallbackApplied || doc.fallbackBlocked || doc.offerExpired) return "completed";
  const normalized = normalizeBetStatus(doc.status);
  if (normalized === "PENDING") return "pending";
  if (normalized === "ACTIVE") return "active";
  return "completed";
}

function getOnChainStateLabel(state?: BetDoc["onChainState"], doc?: BetDoc): string {
  const fallback = doc ? fallbackLabel(doc) : null;
  if (fallback) return fallback.toUpperCase();
  switch (state) {
    case "open": return "ESCROW OPEN · awaiting match";
    case "locked": return "LOCKED IN ESCROW · on-chain";
    case "settled": return "PAID OUT ON-CHAIN";
    case "cancelled": return "REFUNDED · window expired";
    default: return "ON-CHAIN ESCROW";
  }
}

function buildIMessagePayloadURL(queryItems: Record<string, string>): string {
  const params = new URLSearchParams(queryItems);
  return `?${params.toString()}`;
}

function buildIMessageBetDeepLink(betId: string): string {
  return buildIMessagePayloadURL({ betId });
}

function buildIMessageConversationDeepLink(conversationId: string): string {
  return buildIMessagePayloadURL({ conversationId });
}

// Decode a [u8; 32] zero-padded game id back into a string.
function decodeGameId(raw: ArrayLike<number>): string {
  const buf    = Buffer.from(raw as number[]);
  const nullAt = buf.indexOf(0);
  return buf.slice(0, nullAt === -1 ? 32 : nullAt).toString("utf8");
}

// Turn an on-chain sportsBet account into a JSON-friendly object for the dashboard.
function decodeSportsBet(
  pubkey: web3.PublicKey,
  bet: Awaited<ReturnType<typeof program.account.sportsBet.fetch>>,
): Record<string, unknown> {
  const state = "open" in bet.state ? "open" : "locked" in bet.state ? "locked" : "settled";
  return {
    pubkey:           pubkey.toBase58(),
    creator:          bet.creator.toBase58(),
    opponent:         bet.opponent ? bet.opponent.toBase58() : null,
    amountLamports:   bet.amount.toNumber(),
    amountSol:        bet.amount.toNumber() / web3.LAMPORTS_PER_SOL,
    oracle:           bet.oraclePubkey.toBase58(),
    sport:            ON_CHAIN_SPORT_BY_INDEX[bet.sport as number] ?? "soccer",
    gameId:           decodeGameId(bet.gameId),
    creatorBacksHome: bet.creatorBacksHome,
    startTime:        bet.startTime.toNumber(),
    settleAfter:      bet.settleAfter.toNumber(),
    state,
  };
}

// ── sports bet crank (sports-feed powered) ───────────────────────────────────
// Settles locked on-chain sports bets from the provider the bet was created on
// (doc.sportsProvider; legacy docs without it are TheSportsDB). The rules —
// final-only payouts, postponed/cancelled refunds after a grace window, stale-data
// rejection, optional cross-provider agreement — live in decideSportsSettlement()
// (relayer/sports/settlement.ts). Bets the oracle can't settle stay escrowed and
// are recoverable on-chain with the permissionless refund_stale_bet.

const sportsLogged = new Set<string>();
function logSportsOnce(key: string, message: string, level: "log" | "warn" | "error" = "log"): void {
  if (sportsLogged.has(key)) return;
  if (sportsLogged.size > 5_000) sportsLogged.clear();
  sportsLogged.add(key);
  console[level](message);
}
/** Blocked bets that have no Mongo doc to carry the flag (pre-Mongo legacy bets). */
const sportsBlockedInMemory = new Set<string>();
let sportsCrankRunning = false;

interface SportsSettlementTarget {
  betPubkey: web3.PublicKey;
  bet: Awaited<ReturnType<typeof program.account.sportsBet.fetch>>;
  doc: BetDoc | null;
  provider: SportsProviderId;
  eventId: string;
  sport: Sport;
  league: string | null;
}

async function crankSportsBets(): Promise<void> {
  // The poll loop and POST /settle-bet can overlap; one sweep at a time.
  if (sportsCrankRunning) return;
  sportsCrankRunning = true;
  try {
    await crankSportsBetsOnce();
  } finally {
    sportsCrankRunning = false;
  }
}

async function crankSportsBetsOnce(): Promise<void> {
  const slot = await connection.getSlot("confirmed");
  const now  = await connection.getBlockTime(slot);
  if (now === null) return;

  const onChainBets = await program.account.sportsBet.all();
  const betsCol = await bets();

  const due = onChainBets.filter(({ account: bet }) =>
    "locked" in bet.state &&
    bet.settleAfter.toNumber() <= now &&
    bet.oraclePubkey.equals(oracle.publicKey) &&
    Boolean(bet.opponent),
  );
  if (due.length === 0) return;

  const docsByPda = new Map<string, BetDoc>();
  if (betsCol) {
    const docs = await betsCol
      .find({ betPda: { $in: due.map(({ publicKey }) => publicKey.toBase58()) } }, { projection: { _id: 0 } })
      .toArray();
    for (const doc of docs) if (doc.betPda) docsByPda.set(doc.betPda, doc);
  }

  const targets: SportsSettlementTarget[] = [];
  for (const { publicKey: betPubkey, account: bet } of due) {
    const pda = betPubkey.toBase58();
    const doc = docsByPda.get(pda) ?? null;
    // sport is stored on-chain as a u8 enum (0=soccer, 1=nba, 2=nfl); the doc keeps
    // the true sport (NHL shares id 2).
    let sport: Sport = ON_CHAIN_SPORT_BY_INDEX[bet.sport as number] ?? "soccer";
    let provider: SportsProviderId;
    let eventId: string;
    let league: string | null = null;
    if (doc) {
      // Witness/chat bets also live in SportsBet accounts; crankWitnessBets settles those.
      if (doc.validation !== "sports") continue;
      if (doc.sportsSettlementBlocked) {
        logSportsOnce(`blocked:${pda}`, `sports bet ${pda} (${doc.id}) is blocked for an operator: ${doc.sportsSettlementBlockedReason ?? "no reason recorded"}`, "warn");
        continue;
      }
      if (isSupportedSport(doc.sport)) sport = doc.sport;
      // Docs without sportsProvider predate the provider abstraction: their
      // espnGameId holds a TheSportsDB event id despite the field name.
      provider = isSportsProviderId(doc.sportsProvider) ? doc.sportsProvider : "thesportsdb";
      eventId = `${doc.sportsEventId ?? doc.espnGameId ?? ""}`.trim();
      league = doc.sportsLeague ?? null;
    } else {
      // Pre-Mongo legacy bets stored the TheSportsDB event id directly on-chain.
      const onChainGameId = decodeGameId(bet.gameId);
      if (!/^\d+$/.test(onChainGameId)) continue;
      if (sportsBlockedInMemory.has(pda)) continue;
      provider = "thesportsdb";
      eventId = onChainGameId;
    }
    if (!/^\d+$/.test(eventId)) {
      logSportsOnce(`badid:${pda}`, `sports bet ${pda} has no usable event id; leaving it for refund_stale_bet`, "warn");
      continue;
    }
    if (!getSportsProvider(provider).isConfigured()) {
      logSportsOnce(
        `unconfigured:${pda}`,
        `sports bet ${pda} settles against ${provider} event ${eventId}, but ${provider} is not configured ` +
        `(set SPORTSDB_API_KEY). Not guessing a result; it stays escrowed until configured or refunded via refund_stale_bet.`,
        "warn",
      );
      continue;
    }
    targets.push({ betPubkey, bet, doc, provider, eventId, sport, league });
  }
  if (targets.length === 0) return;

  // One fresh lookup per distinct event per sweep, a few at a time.
  const eventKey = (t: SportsSettlementTarget) => `${t.provider}:${t.sport}:${t.eventId}`;
  const uniqueTargets = Array.from(new Map(targets.map((t) => [eventKey(t), t])).values());
  const secondaryId = secondarySportsProviderId();
  const results = new Map<string, { primary: FinalResult; secondary?: FinalResult | null }>();
  await mapLimit(uniqueTargets, 4, async (t) => {
    const primary = await getFinalResult(t.provider, t.eventId, { sport: t.sport, league: t.league });
    let secondary: FinalResult | null | undefined;
    if (secondaryId && secondaryId !== t.provider && primary.status === "final") {
      secondary = primary.homeTeam && primary.awayTeam && primary.startTimeMs !== null
        ? await getCrossCheckResult(secondaryId, {
            sport: t.sport,
            league: primary.league ?? t.league,
            homeTeam: primary.homeTeam,
            awayTeam: primary.awayTeam,
            startTimeMs: primary.startTimeMs,
          })
        : null;
    }
    results.set(eventKey(t), { primary, secondary });
  });

  for (const t of targets) {
    const { betPubkey, bet, doc } = t;
    const pda = betPubkey.toBase58();
    const { primary, secondary } = results.get(eventKey(t))!;
    const action = decideSportsSettlement({
      nowMs: Date.now(),
      scheduledKickoffMs: bet.startTime.toNumber() * 1000,
      acceptedAtMs: doc?.acceptedAt ?? null,
      expected: { homeTeamId: doc?.sportsHomeTeamId, awayTeamId: doc?.sportsAwayTeamId },
      primary,
      secondary,
      graceMs: SPORTS_CANCEL_GRACE_MS,
      maxResultAgeMs: SPORTS_RESULT_MAX_AGE_MS,
    });

    if (action.type === "wait") {
      logSportsOnce(`wait:${pda}:${primary.status}:${action.reason}`, `sports bet ${pda} (${t.provider} ${t.eventId}): waiting — ${action.reason}`);
      continue;
    }

    if (action.type === "block") {
      console.error(
        `OPERATOR ACTION REQUIRED: sports bet ${pda}${doc ? ` (${doc.id})` : ""} on ${t.provider} event ${t.eventId} ` +
        `was NOT settled: ${action.reason}. Funds stay escrowed. Verify the result manually, then unset ` +
        `sportsSettlementBlocked to retry, or let refund_stale_bet refund both sides.`,
      );
      if (betsCol && doc) {
        await betsCol.updateOne(
          { betPda: pda },
          { $set: { sportsSettlementBlocked: true, sportsSettlementBlockedReason: action.reason, sportsSettlementBlockedAt: Date.now() } },
        );
      } else {
        sportsBlockedInMemory.add(pda);
      }
      continue;
    }

    console.log(
      `Settling sports bet ${pda} (${t.provider} ${t.eventId}): ${primary.awayTeam} ${primary.awayScore} @ ` +
      `${primary.homeTeam} ${primary.homeScore} — ${action.reason} → homeWon=${action.homeWon}`,
    );

    const [vault] = web3.PublicKey.findProgramAddressSync(
      [SPORTS_VAULT_SEED, betPubkey.toBuffer()],
      program.programId,
    );

    try {
      const sig = await program.methods
        .settleBet(action.homeWon)
        .accountsStrict({
          oracle:    oracle.publicKey,
          creator:   bet.creator,
          opponent:  bet.opponent!,
          sportsBet: betPubkey,
          vault,
        })
        .rpc();
      console.log(`Settled bet ${pda}: ${sig}`);

      // Mirror the on-chain result back to the chat bet doc so the UI updates.
      // The challenger is the on-chain creator; they back home iff creatorBacksHome.
      if (betsCol) {
        const resolvedWinner =
          action.homeWon === null
            ? undefined
            : bet.creatorBacksHome === action.homeWon
              ? "challenger"
              : "acceptor";
        await betsCol.updateOne(
          { betPda: pda },
          { $set: {
            status: "COMPLETED",
            onChainState: "settled",
            settleSig: sig,
            sportsResult: {
              provider: primary.provider,
              eventId: primary.eventId,
              status: primary.status,
              providerStatus: primary.providerStatus,
              homeScore: primary.homeScore,
              awayScore: primary.awayScore,
              homeWon: action.homeWon,
              decidedBy: primary.decidedBy,
              fetchedAtMs: primary.fetchedAtMs,
              reason: action.reason,
            },
            ...(resolvedWinner ? { resolvedWinner } : {}),
          } },
        );
      }
    } catch (err) {
      console.error(`settle failed for ${pda}:`, err);
    }
  }
}

// ── chat-bet crank (witness-vote settled) ──────────────────────────────────────
// Settles on-chain SOL chat bets from their off-chain resolution: pays the winner
// once both sides have staked (Locked) and a witness quorum picked a side, applies
// the precommitted fallback when the resolve-by date passes with no quorum, and
// refunds the creator if a legacy accept window lapses with no opponent.
//
// Race safety: the fallback is claimed in Mongo with a conditional updateOne
// (status ACTIVE, no resolvedWinner, no prior claim) BEFORE any on-chain call, and
// witnessCrankAction() lets a claimed fallback outrank any resolvedWinner written
// afterwards by a racing vote. On-chain, settleBet/settleSocial close the escrow,
// so at most one payout can ever land.

type BetsCollection = NonNullable<Awaited<ReturnType<typeof bets>>>;

/** Atomically commit a locked, unresolved witness bet to its fallback (or to blocking it). */
async function claimWitnessFallback(
  betsCol: BetsCollection,
  betId: string,
  set: Partial<BetDoc>,
): Promise<boolean> {
  const result = await betsCol.updateOne(
    {
      id: betId,
      status: "ACTIVE",
      onChainState: "locked",
      resolvedWinner: { $exists: false },
      fallbackApplied: { $exists: false },
      fallbackBlocked: { $exists: false },
    },
    { $set: { status: "COMPLETED", fallbackAppliedAt: Date.now(), ...set } },
  );
  return result.modifiedCount === 1;
}

async function markWitnessBetSettled(betsCol: BetsCollection, betId: string, sig: string | undefined): Promise<void> {
  await betsCol.updateOne(
    { id: betId },
    { $set: { onChainState: "settled", status: "COMPLETED", ...(sig ? { settleSig: sig } : {}) } },
  );
}

async function crankWitnessBets(): Promise<void> {
  const betsCol = await bets();
  const usersCol = await users();
  if (!betsCol || !usersCol) return;

  const slot = await connection.getSlot("confirmed");
  const now = await connection.getBlockTime(slot);
  if (now === null) return;
  const nowMs = now * 1000;

  // Unaccepted witness offers past their accept-by (or resolve-by) date: nothing was
  // escrowed, so just close them out. POST /bets/accept also rejects them.
  const expired = await betsCol.updateMany(
    {
      status: "PENDING",
      validation: { $ne: "sports" },
      onChain: { $ne: true },
      $or: [{ acceptByDate: { $lte: nowMs } }, { resolveByDate: { $lte: nowMs } }],
    },
    { $set: { status: "COMPLETED", offerExpired: true } },
  );
  if (expired.modifiedCount) console.log(`expired ${expired.modifiedCount} unaccepted witness offer(s)`);

  const docs = await betsCol
    .find({ onChain: true, onChainState: { $in: ["open", "locked"] } }, { projection: { _id: 0 } })
    .toArray();

  for (const doc of docs) {
    const bet = normalizeBetDoc(doc);
    if (!bet.betPda) continue;
    try {
      if ((bet.onChainKind ?? "sports") === "social") {
        await crankSocialWitnessBet(betsCol, bet, nowMs);
      } else {
        await crankLegacyWitnessBet(betsCol, usersCol, bet, now);
      }
    } catch (err) {
      console.error(`witness crank failed for bet ${bet.id}:`, err);
    }
  }
}

/** Witness bet escrowed in a SocialBet (escrow_bet). Fallback is enforced on-chain. */
async function crankSocialWitnessBet(betsCol: BetsCollection, bet: BetDoc, nowMs: number): Promise<void> {
  const socialBet = new web3.PublicKey(bet.betPda!);
  const acct = await program.account.socialBet.fetchNullable(socialBet);
  if (!acct) {
    // Escrow already closed. If we had committed to the fallback, its settle tx
    // landed but wasn't recorded (e.g. confirmation timeout) — finalize the doc.
    if (bet.fallbackApplied && bet.onChainState === "locked") {
      await markWitnessBetSettled(betsCol, bet.id, undefined);
      console.warn(`social bet ${bet.id}: escrow already closed; marked fallback settled without a signature`);
    }
    return;
  }
  if (!("locked" in acct.state)) return;

  const action = witnessCrankAction(bet, nowMs);
  let outcome: 0 | 1 | 2;
  if (action.type === "settle-winner") {
    outcome = action.winner === "challenger" ? 0 : 1;
  } else if (action.type === "apply-fallback") {
    if (acct.endDate.toNumber() * 1000 > nowMs) return; // on-chain end_date not reached yet
    if (!action.alreadyClaimed && !(await claimWitnessFallback(betsCol, bet.id, { fallbackApplied: action.fallback }))) {
      return; // lost the race to a quorum vote; the next tick pays the winner
    }
    outcome = 2;
  } else {
    return;
  }

  // `destination` is only read for burn/charity fallbacks; otherwise pass a harmless
  // writable account (it must not be a builtin program id, which gets demoted to read-only).
  const destination = outcome === 2 && acct.fallbackKind !== 0 ? acct.fallbackDest : BURN_ADDRESS;
  const sig = await program.methods
    .settleSocial(outcome)
    .accountsStrict({
      oracle: oracle.publicKey,
      challenger: acct.challenger,
      opponent: acct.opponent,
      destination,
      socialBet,
      vault: socialVaultPda(socialBet),
    })
    .rpc();
  await markWitnessBetSettled(betsCol, bet.id, sig);
  console.log(
    outcome === 2
      ? `applied ${bet.fallbackApplied ?? bet.fallbackKind ?? "return"} fallback to social bet ${bet.id}: ${sig}`
      : `settled social bet ${bet.id} (winner=${outcome === 0 ? "challenger" : "acceptor"}): ${sig}`,
  );
}

/** Legacy witness bet escrowed in a SportsBet (createBet + acceptBet). */
async function crankLegacyWitnessBet(
  betsCol: BetsCollection,
  usersCol: NonNullable<Awaited<ReturnType<typeof users>>>,
  bet: BetDoc,
  now: number,
): Promise<void> {
  const betPubkey = new web3.PublicKey(bet.betPda!);
  const acct = await program.account.sportsBet.fetchNullable(betPubkey);
  if (!acct) {
    if (bet.fallbackApplied && bet.onChainState === "locked") {
      await markWitnessBetSettled(betsCol, bet.id, undefined);
      console.warn(`chat bet ${bet.id}: escrow already closed; marked fallback settled without a signature`);
    }
    return; // already closed (settled/cancelled) on-chain
  }
  const vault = sportsVaultPda(betPubkey);

  if ("locked" in acct.state) {
    // Sports bets are settled from sports feeds by crankSportsBets, not votes.
    if (bet.validation === "sports" || !acct.opponent) return;
    const action = witnessCrankAction(bet, now * 1000);

    if (action.type === "block-fallback") {
      if (await claimWitnessFallback(betsCol, bet.id, { fallbackBlocked: true, fallbackBlockedReason: action.reason })) {
        console.warn(
          `OPERATOR ACTION REQUIRED: chat bet ${bet.id} passed its resolve-by date with no verdict; ` +
          `its ${action.fallback} fallback (dest ${bet.fallbackDest}) cannot run on a legacy SportsBet ` +
          `(${betPubkey.toBase58()}). Funds remain escrowed; votes are now closed.`,
        );
      }
      return;
    }
    if (acct.settleAfter.toNumber() > now) return;

    let homeWon: boolean | null;
    if (action.type === "settle-winner") {
      // creator backs "home"/challenger, so home_won === challenger won.
      homeWon = action.winner === "challenger";
    } else if (action.type === "apply-fallback" && action.fallback === "return") {
      if (!action.alreadyClaimed && !(await claimWitnessFallback(betsCol, bet.id, { fallbackApplied: "return" }))) {
        return; // lost the race to a quorum vote; the next tick pays the winner
      }
      homeWon = null; // draw path: process_settle_bet refunds both stakes
    } else {
      return;
    }

    const sig = await program.methods
      .settleBet(homeWon)
      .accountsStrict({
        oracle: oracle.publicKey,
        creator: acct.creator,
        opponent: acct.opponent,
        sportsBet: betPubkey,
        vault,
      })
      .rpc();
    await markWitnessBetSettled(betsCol, bet.id, sig);
    console.log(
      homeWon === null
        ? `refunded chat bet ${bet.id} (no verdict by resolve-by date): ${sig}`
        : `settled chat bet ${bet.id} (winner=${bet.resolvedWinner}): ${sig}`,
    );
  } else if ("open" in acct.state) {
    // Accept window elapsed with no opponent — refund the creator and close out.
    if (acct.startTime.toNumber() > now) return;
    const challengerUser = await usersCol.findOne({ usernameLower: bet.challenger.toLowerCase() });
    if (!challengerUser?.walletSecret) return;
    const sig = await programAs(loadUserKeypair(challengerUser))
      .methods.cancelBet()
      .accountsStrict({ creator: acct.creator, sportsBet: betPubkey, vault })
      .rpc();
    await betsCol.updateOne(
      { id: bet.id },
      { $set: { onChainState: "cancelled", status: "COMPLETED", createSig: bet.createSig ?? sig } },
    );
    console.log(`refunded expired chat bet ${bet.id}: ${sig}`);
  }
}

// Proof, recurring check-in bets and stats (relayer/features.ts).
const featureCtx: FeatureContext = {
  getAuthenticatedUser,
  isBetContextMember,
  normalizeBetDoc,
  json,
  corsHeaders,
  urlSigningSecret: AUTH_SECRET,
  // The fallback crank uses chain time; never judge a deadline earlier than it does.
  deadlineNowMs: async () => {
    const chainSec = await Promise.race([
      currentUnixTimeSec().catch(() => 0),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 3_000).unref()),
    ]);
    return Math.max(Date.now(), chainSec * 1000);
  },
};

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight (browser dashboard calls these endpoints directly)
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    // GET /health
    if (req.method === "GET" && req.url === "/health") {
      const slot = await connection.getSlot("confirmed").catch(() => 0);
      return json(res, 200, {
        ok: true,
        oracle:  oracle.publicKey.toBase58(),
        program: program.programId.toBase58(),
        rpc:     RPC_URL,
        slot,
        db:      isDbConfigured() ? "configured" : "unconfigured",
      });
    }

    // Proof, check-ins, GET /bets/:id, GET /stats/:username (relayer/features.ts)
    if (await handleFeatureRoutes(req, res, featureCtx)) return;

    // POST /auth/signup  { email, username, password }
    if (req.method === "POST" && req.url === "/auth/signup") {
      const col = await users();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const username = normalizeUsername(body.username);
      const password = typeof body.password === "string" ? body.password : "";
      if (!email) return json(res, 400, { error: "valid email is required" });
      if (!username) return json(res, 400, { error: "username must be 3-24 chars using letters, numbers, underscore, dash, or dot" });
      if (password.length < 8) return json(res, 400, { error: "password must be at least 8 characters" });

      const emailLower = email.toLowerCase();
      const usernameLower = username.toLowerCase();
      const existing = await col.findOne({
        $or: [{ emailLower }, { usernameLower }],
      }, { projection: { emailLower: 1, usernameLower: 1 } });
      if (existing?.emailLower === emailLower) {
        return json(res, 409, { error: "email already registered" });
      }
      if (existing?.usernameLower === usernameLower) {
        return json(res, 409, { error: "username already taken" });
      }

      const now = Date.now();
      const user: UserDoc = {
        id: `u-${now}-${crypto.randomBytes(4).toString("hex")}`,
        email,
        emailLower,
        username,
        usernameLower,
        passwordHash: hashPassword(password),
        createdAt: now,
      };
      await col.insertOne(user);
      await points.ensurePointsAccount(user).catch((err) =>
        console.warn("points grant failed on signup (retried lazily):", err instanceof Error ? err.message : err),
      );
      await ensureUserWallet(user).catch((err) =>
        console.warn("wallet provisioning failed on signup:", err instanceof Error ? err.message : err),
      );
      const token = signAuthToken(user.id, user.email, user.username);
      return json(res, 201, { token, user: toPublicUser(user) });
    }

    // POST /auth/login  { email, password }
    if (req.method === "POST" && req.url === "/auth/login") {
      const col = await users();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || !password) return json(res, 400, { error: "email and password are required" });

      const user = await col.findOne({ emailLower: email.toLowerCase() });
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(res, 401, { error: "invalid email or password" });
      }
      await ensureUserWallet(user).catch((err) =>
        console.warn("wallet provisioning failed on login:", err instanceof Error ? err.message : err),
      );
      const token = signAuthToken(user.id, user.email, user.username);
      return json(res, 200, { token, user: toPublicUser(user) });
    }

    // GET /auth/me
    if (req.method === "GET" && req.url === "/auth/me") {
      const user = await getAuthenticatedUser(req);
      if (!user) return json(res, 401, { error: "unauthorized" });
      const pointsBalance = await points.getPointsBalance(user).catch(() => null);
      return json(res, 200, { user: toPublicUser(user), pointsBalance });
    }

    // GET /profile
    if (req.method === "GET" && req.url === "/profile") {
      const authUser = await getAuthenticatedUser(req);
      let wallet = profileWallet;
      if (authUser) {
        await ensureUserWallet(authUser).catch((err) =>
          console.warn("wallet provisioning failed on profile:", err instanceof Error ? err.message : err),
        );
        if (authUser.walletPubkey) wallet = new web3.PublicKey(authUser.walletPubkey);
      }
      const solBalance = await connection
        .getBalance(wallet, "confirmed")
        .then((lamports) => lamports / web3.LAMPORTS_PER_SOL)
        .catch((err) => {
          console.error("failed to fetch SOL balance:", err);
          return 0;
        });
      return json(res, 200, {
        name: authUser?.username ?? PROFILE_NAME,
        initials: authUser ? toInitials(authUser.username) : PROFILE_INITIALS,
        github: authUser?.username ?? PROFILE_GITHUB,
        wallet: wallet.toBase58(),
        solBalance,
        pointsBalance: authUser ? await points.getPointsBalance(authUser).catch(() => null) : null,
        betCurrencies: { allowed: points.BET_CURRENCIES, default: points.DEFAULT_BET_CURRENCY },
      });
    }

    // ── points (play money; see relayer/points.ts) ──
    // GET /points → { currency, balance, held, topup, signupGrant, ledger[], betCurrencies }
    if (req.method === "GET" && req.url && /^\/points(?:\?|$)/.test(req.url)) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const limit = Number(new URL(req.url, "http://x").searchParams.get("limit") ?? 25);
      const summary = await points.getPointsSummary(authUser, Number.isFinite(limit) ? limit : 25);
      return json(res, 200, { points: summary });
    }
    // POST /points/topup → { claimed, points } | 409 { error, points }
    if (req.method === "POST" && req.url === "/points/topup") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const out = await points.claimPointsTopup(authUser);
      return json(res, out.status, out.body);
    }
    // POST /points/crank — operator-only: run the points settlement sweep now.
    if (req.method === "POST" && req.url === "/points/crank") {
      if (!OPERATOR_TOKEN) return json(res, 404, { error: "not found" });
      if (!isOperatorRequest(req)) return json(res, 401, { error: "unauthorized" });
      const report = await runPointsCrank();
      return json(res, 200, { ok: true, report });
    }

    // POST /verify  (original accountability commitment)
    if (req.method === "POST" && req.url === "/verify") {
      if (!OPERATOR_TOKEN) return json(res, 404, { error: "not found" });
      if (!isOperatorRequest(req)) return json(res, 401, { error: "unauthorized" });
      const body = await readJson(req);
      if (typeof body.commitmentId !== "string")
        return json(res, 400, { error: "commitmentId is required" });
      const signature = await resolveSuccess(body.commitmentId);
      return json(res, 200, { commitmentId: body.commitmentId, signature, explorer: explorerUrl(signature) });
    }

    // GET /scoreboard?sport=nba|nfl|nhl|soccer[&league=epl|laliga|seriea|bundesliga|ligue1|mls|ucl|worldcup]
    // Returns upcoming games currently in the sports-bet creation window. Soccer
    // without a league merges the default league set (SPORTS_SOCCER_LEAGUES).
    if (req.method === "GET" && req.url?.startsWith("/scoreboard")) {
      const params = new URL(req.url, "http://x").searchParams;
      const sport  = (params.get("sport") ?? "nba") as Sport;
      const league = params.get("league") ?? undefined;
      if (!isSupportedSport(sport))
        return json(res, 400, { error: "sport must be soccer | nba | nfl | nhl" });
      const nowMs = Date.now();
      const betWindowEndMs = nowMs + SPORTS_BET_CREATE_WINDOW_SECS * 1000;
      let scrapedGames: Awaited<ReturnType<typeof fetchScoreboard>>;
      try {
        scrapedGames = await fetchScoreboard(sport, league, {
          // Games past the create window are filtered out below, so don't fetch them.
          daysAhead: Math.min(SPORTS_BET_SCOREBOARD_LOOKAHEAD_DAYS, SPORTS_BET_CREATE_WINDOW_SECS / 86_400),
          includeStarted: false,
          maxGames: 120,
        });
      } catch (err) {
        console.error(`[sports] /scoreboard ${sport}${league ? `/${league}` : ""} failed:`, err instanceof Error ? err.message : err);
        return json(res, 502, { error: SPORTS_UNAVAILABLE_MESSAGE });
      }
      const games = scrapedGames
        .filter((game) => game.state === "scheduled")
        .filter((game): game is typeof game & { startTimeMs: number } => typeof game.startTimeMs === "number")
        .filter((game) => game.startTimeMs > nowMs && game.startTimeMs <= betWindowEndMs);
      return json(res, 200, {
        sport,
        league: league ?? null,
        games,
        bettingWindowSeconds: SPORTS_BET_CREATE_WINDOW_SECS,
        provider: primarySportsProviderId(),
      });
    }

    // GET /game?sport=nba&id=401584793[&provider=espn|thesportsdb][&league=epl]
    // `result` stays null until the game is final (legacy shape); `event` carries the
    // normalized live status for any state.
    if (req.method === "GET" && req.url?.startsWith("/game")) {
      const params = new URL(req.url, "http://x").searchParams;
      const sport  = (params.get("sport") ?? "nba") as Sport;
      const gameId = (params.get("id") ?? "").trim();
      const providerParam = params.get("provider");
      const provider = isSportsProviderId(providerParam) ? providerParam : primarySportsProviderId();
      if (!gameId) return json(res, 400, { error: "id is required" });
      if (!/^\d{1,20}$/.test(gameId)) return json(res, 400, { error: "id must be a numeric event id" });
      if (!isSupportedSport(sport)) {
        return json(res, 400, { error: "sport must be soccer | nba | nfl | nhl" });
      }
      if (!getSportsProvider(provider).isConfigured()) {
        return json(res, 400, { error: "That game source isn't available." });
      }
      const lookup = await getFinalResult(provider, gameId, {
        sport,
        league: params.get("league"),
        maxAgeMs: 15_000,
      });
      if (lookup.error && lookup.error !== "event not found") {
        console.error(`[sports] /game ${provider} ${sport} ${gameId} failed: ${lookup.error}`);
        return json(res, 502, { error: SPORTS_UNAVAILABLE_MESSAGE });
      }
      if (lookup.error) return json(res, 200, { result: null, provider, event: null });
      const result = lookup.status === "final" && lookup.homeScore !== null && lookup.awayScore !== null
        ? {
            gameId,
            sport,
            homeWon: lookup.isDraw ? null : lookup.homeWon,
            homeTeam: lookup.homeTeam ?? "Home",
            awayTeam: lookup.awayTeam ?? "Away",
            homeScore: lookup.homeScore,
            awayScore: lookup.awayScore,
            isFinal: true,
            status: lookup.statusLabel,
          }
        : null;
      return json(res, 200, { result, provider, event: lookup });
    }

    // GET /sports-bets  — all on-chain sports bets (1v1 / group-chat wagers)
    if (req.method === "GET" && req.url?.startsWith("/sports-bets")) {
      const all = await program.account.sportsBet.all();
      const bets = all.map(({ publicKey, account }) => decodeSportsBet(publicKey, account));
      return json(res, 200, { bets });
    }

    // POST /settle-bet  — manually trigger crank
    if (req.method === "POST" && req.url === "/settle-bet") {
      if (!OPERATOR_TOKEN) return json(res, 404, { error: "not found" });
      if (!isOperatorRequest(req)) return json(res, 401, { error: "unauthorized" });
      await crankSportsBets();
      return json(res, 200, { ok: true });
    }
    // GET /imessage/deeplink?betId=...    -> canonical deep-link URL
    // GET /imessage/deeplink?url=...      -> extract betId from a deep-link URL
    if (req.method === "GET" && req.url?.startsWith("/imessage/deeplink")) {
      const params = new URL(req.url, "http://x").searchParams;
      const betId = params.get("betId");
      const rawUrl = params.get("url");
      if (betId && betId.trim()) {
        return json(res, 200, {
          betId: betId.trim(),
          url: buildIMessageBetDeepLink(betId.trim()),
        });
      }
      if (rawUrl && rawUrl.trim()) {
        return json(res, 200, {
          betId: parseIMessageBetDeepLink(rawUrl),
        });
      }
      return json(res, 400, { error: "provide either betId or url query param" });
    }

    // AccountabiliBuddy conversation tokens provide shared membership that
    // Messages.framework intentionally does not expose.
    if (req.method === "POST" && req.url === "/imessage/conversations") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await imessageConversations();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      const rawParticipantIds = Array.isArray(body.participantIds) ? body.participantIds.slice(0, 50) : [];
      const participantIds = Array.from(new Set(
        rawParticipantIds
          .map(normalizeIMessageParticipantId)
          .filter((id): id is string => Boolean(id)),
      )).sort();
      const participantFingerprint = participantIds.length
        ? crypto.createHash("sha256").update(participantIds.join(".")).digest("hex")
        : null;

      const now = Date.now();
      if (participantFingerprint) {
        const existing = await col.findOne({ participantFingerprint });
        if (existing) {
          const joined = await col.findOneAndUpdate(
            { id: existing.id },
            {
              $addToSet: {
                memberUserIds: authUser.id,
                memberUsernames: authUser.username,
              },
              $set: { participantIds, updatedAt: now },
            },
            { returnDocument: "after" },
          );
          if (!joined) return json(res, 404, { error: "conversation not found" });
          return json(res, 200, {
            conversation: toIMessageConversation(authUser, joined),
            inviteUrl: buildIMessageConversationDeepLink(joined.id),
          });
        }
      }

      const conversation: IMessageConversationDoc = {
        id: `imc-${crypto.randomBytes(18).toString("base64url")}`,
        ...(participantFingerprint ? { participantFingerprint, participantIds } : {}),
        ownerUserId: authUser.id,
        ownerUsername: authUser.username,
        memberUserIds: [authUser.id],
        memberUsernames: [authUser.username],
        createdAt: now,
        updatedAt: now,
      };
      try {
        await col.insertOne(conversation);
      } catch (err) {
        if (!participantFingerprint || !(err instanceof Error) || !err.name.startsWith("MongoServerError")) {
          throw err;
        }
        const existing = await col.findOneAndUpdate(
          { participantFingerprint },
          {
            $addToSet: {
              memberUserIds: authUser.id,
              memberUsernames: authUser.username,
            },
            $set: { participantIds, updatedAt: now },
          },
          { returnDocument: "after" },
        );
        if (!existing) throw err;
        return json(res, 200, {
          conversation: toIMessageConversation(authUser, existing),
          inviteUrl: buildIMessageConversationDeepLink(existing.id),
        });
      }
      return json(res, 201, {
        conversation: toIMessageConversation(authUser, conversation),
        inviteUrl: buildIMessageConversationDeepLink(conversation.id),
      });
    }

    const imessageConversationPath = req.url ? decodeIMessageConversationPath(req.url) : null;
    if (imessageConversationPath && req.method === "GET" && !imessageConversationPath.join) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await imessageConversations();
      if (!col) return dbUnconfigured(res);
      const conversation = await col.findOne({ id: imessageConversationPath.id });
      if (!conversation) return json(res, 404, { error: "conversation invite not found" });
      return json(res, 200, { conversation: toIMessageConversation(authUser, conversation) });
    }

    if (imessageConversationPath?.join && req.method === "POST") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await imessageConversations();
      if (!col) return dbUnconfigured(res);
      const now = Date.now();
      const result = await col.findOneAndUpdate(
        { id: imessageConversationPath.id },
        {
          $addToSet: {
            memberUserIds: authUser.id,
            memberUsernames: authUser.username,
          },
          $set: { updatedAt: now },
        },
        { returnDocument: "after" },
      );
      if (!result) return json(res, 404, { error: "conversation invite not found" });
      return json(res, 200, { conversation: toIMessageConversation(authUser, result) });
    }

    // POST /imessage/participants/link { participantId }
    // Links the current account to the opaque identifier supplied by Messages.framework.
    if (req.method === "POST" && req.url === "/imessage/participants/link") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await users();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      const participantId = normalizeIMessageParticipantId(body.participantId);
      if (!participantId) return json(res, 400, { error: "valid participantId is required" });

      const claimed = await col.findOne(
        { imessageParticipantIds: participantId, id: { $ne: authUser.id } },
        { projection: { username: 1 } },
      );
      if (claimed) return json(res, 409, { error: "this Messages identity is linked to another account" });

      await col.updateOne(
        { id: authUser.id },
        { $addToSet: { imessageParticipantIds: participantId } },
      );
      return json(res, 200, { linked: true, username: authUser.username });
    }

    // POST /imessage/participants/resolve { participantIds: string[] }
    if (req.method === "POST" && req.url === "/imessage/participants/resolve") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await users();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      const rawIds = Array.isArray(body.participantIds) ? body.participantIds.slice(0, 50) : [];
      const participantIds = Array.from(new Set(rawIds.map(normalizeIMessageParticipantId).filter((id): id is string => Boolean(id))));
      if (!participantIds.length) return json(res, 200, { participants: [] });

      const docs = await col.find(
        { imessageParticipantIds: { $in: participantIds } },
        { projection: { _id: 0, username: 1, imessageParticipantIds: 1 } },
      ).toArray();
      const participants = participantIds.flatMap((participantId) => {
        const user = docs.find((doc) => doc.imessageParticipantIds?.includes(participantId));
        return user ? [{ participantId, username: user.username }] : [];
      });
      return json(res, 200, { participants });
    }

    // GET /imessage/bets/:id  — compact, iMessage-friendly card payload
    const imessageBetPathId = req.url ? decodeIMessageBetPathId(req.url) : null;
    if (req.method === "GET" && imessageBetPathId) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const lookup = await loadAuthorizedBetForUser(authUser, imessageBetPathId);
      if ("error" in lookup) return json(res, lookup.status, { error: lookup.error });
      return json(res, 200, {
        card: await decorateIMessageCard(
          featureCtx, authUser, lookup.bet, toIMessageBetCard(authUser.username, lookup.bet, lookup.group),
        ),
      });
    }

    // ── Discord REST routes ───────────────────────────────────────────────────

    if (!DISCORD_ENABLED && req.url?.startsWith("/discord/")) {
      return json(res, 404, { error: "Discord integration is disabled" });
    }

    // GET /discord/me  — resolve which AccountabiliBuddy user is linked to a Discord id
    // Query param: discordId=<snowflake>
    if (req.method === "GET" && req.url?.startsWith("/discord/me")) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        linked: Boolean(authUser.discordId),
        discordId: authUser.discordId ?? null,
        username: authUser.username,
      });
    }

    // DELETE /discord/unlink  — remove the Discord link from the current account
    if (req.method === "DELETE" && req.url === "/discord/unlink") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await users();
      if (!col) return dbUnconfigured(res);
      await col.updateOne({ id: authUser.id }, { $unset: { discordId: "" } });
      return json(res, 200, { unlinked: true });
    }

    // POST /discord/link  — complete a Discord link started from the bot's /setup.
    // Body: { code }  — a signed, short-lived link code minted by the Discord bot.
    // The authenticated account gets the code's Discord id attached.
    if (req.method === "POST" && req.url === "/discord/link") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const body = await readJson(req);
      const code = typeof body.code === "string" ? body.code : "";
      const payload = verifyDiscordLinkCode(code);
      if (!payload) return json(res, 400, { error: "invalid or expired link code" });

      const col = await users();
      if (!col) return dbUnconfigured(res);

      const claimedBy = await col.findOne({ discordId: payload.discordId, id: { $ne: authUser.id } });
      if (claimedBy) {
        return json(res, 409, {
          error: "This Discord account is already linked to another BAAM account.",
        });
      }
      if (authUser.discordId && authUser.discordId !== payload.discordId) {
        return json(res, 409, {
          error: "Your account is already linked to a different Discord account.",
        });
      }

      await col.updateOne({ id: authUser.id }, { $set: { discordId: payload.discordId } });
      void announceDiscordLink(payload, authUser.username);
      return json(res, 200, {
        linked: true,
        username: authUser.username,
        discordUsername: payload.discordUsername,
        returnUrl:
          payload.guildId && payload.channelId
            ? `https://discord.com/channels/${payload.guildId}/${payload.channelId}`
            : "https://discord.com/channels/@me",
      });
    }

    // GET /discord/bets/:id  — compact bet card payload for Discord rendering
    const discordBetPathId = req.url ? decodeDiscordBetPathId(req.url) : null;
    if (req.method === "GET" && discordBetPathId) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const lookup = await loadAuthorizedBetForUser(authUser, discordBetPathId);
      if ("error" in lookup) return json(res, lookup.status, { error: lookup.error });
      return json(res, 200, {
        card: await decorateIMessageCard(
          featureCtx, authUser, lookup.bet, toIMessageBetCard(authUser.username, lookup.bet, lookup.group),
        ),
      });
    }

    // GET /discord/conversations/:channelId  — get conversation for a Discord channel
    const discordConvChannelId = req.url ? decodeDiscordConversationChannelId(req.url) : null;
    if (req.method === "GET" && discordConvChannelId) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await discordConversations();
      if (!col) return dbUnconfigured(res);
      const conversation = await col.findOne({ channelId: discordConvChannelId });
      if (!conversation) return json(res, 404, { error: "no BAAM conversation for this channel" });
      return json(res, 200, { conversation });
    }

    // ── MongoDB-backed dashboard data ─────────────────────────────────────────
    // All of these return 503 (with a clear message) until MONGODB_URI is set,
    // so the frontend keeps using its design fixtures until the DB is wired up.

    // GET /groups  — group-chat list
    if (req.method === "GET" && req.url === "/groups") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await groups();
      if (!col) return dbUnconfigured(res);
      const docs = await col
        .find({}, { projection: { _id: 0 } })
        .toArray();
      const visibleGroups = docs.filter((group) => isGroupMember(group, authUser.username));
      return json(res, 200, { groups: visibleGroups });
    }

    // POST /groups  { name, initials? }  — create a group-chat record
    if (req.method === "POST" && req.url === "/groups") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await groups();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      if (typeof body.name !== "string" || body.name.trim().length < 2)
        return json(res, 400, { error: "name is required (min 2 chars)" });
      const now = Date.now();
      const doc: GroupDoc = {
        id: `g-${now}`,
        name: body.name.trim(),
        initials: toInitials(typeof body.initials === "string" ? body.initials : body.name),
        members: 1,
        memberUsernames: [authUser.username],
        pendingBet: false,
        lastMsg: "Group created",
        time: formatChatClock(now),
        updatedAt: now,
      };
      await col.insertOne(doc);
      return json(res, 201, { group: doc });
    }

    // POST /groups/:id/members  { username } — add a known user to a group by username
    const groupMembersPathId = req.url ? decodeGroupMembersPathId(req.url) : null;
    if (req.method === "POST" && groupMembersPathId) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const groupsCol = await groups();
      const usersCol = await users();
      if (!groupsCol || !usersCol) return dbUnconfigured(res);

      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      if (!username) {
        return json(res, 400, { error: "valid username is required" });
      }

      const group = await groupsCol.findOne(
        { id: groupMembersPathId },
        { projection: { _id: 0 } },
      );
      if (!group) {
        return json(res, 404, { error: "group not found" });
      }
      if (!isGroupMember(group, authUser.username)) {
        return json(res, 403, { error: "group membership required" });
      }

      const user = await usersCol.findOne(
        { usernameLower: username.toLowerCase() },
        { projection: { _id: 0 } },
      );
      if (!user) {
        return json(res, 404, { error: "username not found" });
      }

      const currentMemberUsernames = Array.isArray(group.memberUsernames)
        ? group.memberUsernames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const alreadyMember = currentMemberUsernames.some(
        (value) => value.toLowerCase() === user.usernameLower,
      );
      if (alreadyMember) {
        return json(res, 200, { group, addedUsername: user.username, alreadyMember: true });
      }

      const nextMemberUsernames = [...currentMemberUsernames, user.username];
      const nextMembers = Math.max(
        nextMemberUsernames.length,
        Math.floor(toFiniteNumber(group.members, 1)),
      );
      const now = Date.now();
      const nowLabel = formatChatClock(now);
      await groupsCol.updateOne(
        { id: groupMembersPathId },
        {
          $set: {
            memberUsernames: nextMemberUsernames,
            members: nextMembers,
            lastMsg: `${user.username} joined the group`,
            time: nowLabel,
            updatedAt: now,
          },
        },
      );

      const updatedGroup = await groupsCol.findOne(
        { id: groupMembersPathId },
        { projection: { _id: 0 } },
      );
      if (!updatedGroup) {
        return json(res, 500, { error: "failed to update group members" });
      }
      return json(res, 200, {
        group: updatedGroup,
        addedUsername: user.username,
        alreadyMember: false,
      });
    }

    // POST /groups/:id/leave  — remove the authenticated user from a group
    const groupLeavePathId = req.url ? decodeGroupLeavePathId(req.url) : null;
    if (req.method === "POST" && groupLeavePathId) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const groupsCol = await groups();
      if (!groupsCol) return dbUnconfigured(res);

      const group = await groupsCol.findOne(
        { id: groupLeavePathId },
        { projection: { _id: 0 } },
      );
      if (!group) {
        return json(res, 404, { error: "group not found" });
      }

      const currentMemberUsernames = Array.isArray(group.memberUsernames)
        ? group.memberUsernames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const nextMemberUsernames = currentMemberUsernames.filter(
        (value) => value.toLowerCase() !== authUser.usernameLower,
      );
      if (nextMemberUsernames.length === currentMemberUsernames.length) {
        return json(res, 403, { error: "group membership required" });
      }

      const now = Date.now();
      const nowLabel = formatChatClock(now);
      await groupsCol.updateOne(
        { id: groupLeavePathId },
        {
          $set: {
            memberUsernames: nextMemberUsernames,
            members: nextMemberUsernames.length,
            lastMsg: `${authUser.username} left the group`,
            time: nowLabel,
            updatedAt: now,
          },
        },
      );

      const updatedGroup = await groupsCol.findOne(
        { id: groupLeavePathId },
        { projection: { _id: 0 } },
      );
      if (!updatedGroup) {
        return json(res, 500, { error: "failed to update group members" });
      }
      return json(res, 200, {
        group: updatedGroup,
        leftUsername: authUser.username,
      });
    }

    // GET /messages?group=1  — messages for a group (chronological)
    if (req.method === "GET" && req.url?.startsWith("/messages")) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const messagesCol = await messages();
      const groupsCol = await groups();
      if (!messagesCol || !groupsCol) return dbUnconfigured(res);
      const groupId = new URL(req.url, "http://x").searchParams.get("group") ?? "1";
      const group = await groupsCol.findOne({ id: groupId }, { projection: { _id: 0 } });
      if (!group) return json(res, 404, { error: "group not found" });
      if (!isGroupMember(group, authUser.username)) {
        return json(res, 403, { error: "group membership required" });
      }
      const docs = await messagesCol
        .find({ groupId }, { projection: { _id: 0 } })
        .sort({ createdAt: 1 })
        .toArray();
      return json(res, 200, { messages: docs });
    }

    // POST /messages  { groupId, text }  — append a chat message
    if (req.method === "POST" && req.url === "/messages") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const messagesCol = await messages();
      const groupsCol = await groups();
      if (!messagesCol || !groupsCol) return dbUnconfigured(res);
      const body = await readJson(req);
      if (typeof body.groupId !== "string")
        return json(res, 400, { error: "groupId is required" });
      const group = await groupsCol.findOne({ id: body.groupId }, { projection: { _id: 0 } });
      if (!group) return json(res, 404, { error: "group not found" });
      if (!isGroupMember(group, authUser.username)) {
        return json(res, 403, { error: "group membership required" });
      }
      const now = Date.now();
      const doc: MessageDoc = {
        id:        `m-${now}`,
        groupId:   body.groupId,
        sender:    authUser.username,
        initials:  toInitials(authUser.username),
        text:      typeof body.text === "string" ? body.text : undefined,
        system:    false,
        ts:        formatChatClock(now),
        createdAt: now,
      };
      await messagesCol.insertOne(doc);
      await groupsCol.updateOne(
        { id: body.groupId },
        { $set: { lastMsg: doc.text ?? "New message", time: doc.ts, updatedAt: now } },
      );
      const { ...out } = doc;
      return json(res, 201, { message: out });
    }

    // POST /bets  { groupId?, source?, type, acceptor, terms, stake, currency, witnesses?, minBettors? }
    // Creates a persistent bet plus a linked system message for embedded bet-card rendering.
    if (req.method === "POST" && req.url === "/bets") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const betsCol = await bets();
      const groupsCol = await groups();
      const messagesCol = await messages();
      if (!betsCol || !groupsCol || !messagesCol) return dbUnconfigured(res);

      const body = await readJson(req);
      const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
      const isIMessage = body.source === "imessage";
      const isDiscord = body.source === "discord";
      const imessageConversationId = typeof body.imessageConversationId === "string"
        ? body.imessageConversationId.trim()
        : "";
      const discordConversationId = typeof body.discordConversationId === "string"
        ? body.discordConversationId.trim()
        : "";
      const type = body.type === "PERSONAL" || body.type === "DEV" ? body.type : null;
      const challenger = authUser.username;
      const acceptorInput = typeof body.acceptor === "string" ? body.acceptor.trim() : "";
      let terms = typeof body.terms === "string" ? body.terms.trim() : "";
      const stakeInput = typeof body.stake === "string" ? body.stake.trim() : `${body.stake ?? ""}`.trim();
      // PTS = play-money points (off-chain, relayer/points.ts); SOL = on-chain escrow.
      // BET_CURRENCIES decides what's allowed and the default when omitted.
      const currencyChoice = points.resolveBetCurrency(body.currency, points.BET_CURRENCIES);
      if ("error" in currencyChoice) return json(res, 400, { error: currencyChoice.error });
      const currency = currencyChoice.currency;
      const isPoints = currency === "PTS";

      // DEV "sports" bets are settled by sports feed data rather than witness votes.
      // They carry a sport + numeric event id + which side the challenger backs.
      const isSports = type === "DEV" && typeof body.sport === "string" && body.sport.length > 0;
      const sport = isSports ? (body.sport as Sport) : null;
      const sportsGameId = isSports ? `${body.gameId ?? ""}`.trim() : "";
      const challengerBacksHome = isSports ? body.backsHome !== false : undefined;
      let homeTeam = isSports ? `${body.homeTeam ?? ""}`.trim() : undefined;
      let awayTeam = isSports ? `${body.awayTeam ?? ""}`.trim() : undefined;
      let sportsKickoffSec: number | null = null;
      let sportsEvent: SportsEvent | null = null;

      if (isDiscord && !DISCORD_ENABLED) {
        return json(res, 400, { error: "Discord integration is disabled" });
      }
      if (!isIMessage && !isDiscord && !groupId) return json(res, 400, { error: "groupId is required" });
      if (!type) return json(res, 400, { error: "type must be PERSONAL or DEV" });
      if (type === "DEV" && !isSports) {
        return json(res, 400, { error: "Sports bets must include sport and gameId" });
      }
      const acceptorIsOpen = !acceptorInput || acceptorInput.toLowerCase() === "anyone";
      let acceptor = acceptorIsOpen ? "anyone" : acceptorInput;
      if (!acceptorIsOpen && acceptorInput.toLowerCase() === challenger.toLowerCase()) {
        return json(res, 400, { error: "you cannot challenge yourself" });
      }
      if (isIMessage) {
        if (!imessageConversationId) {
          return json(res, 400, { error: "initialize or join this conversation before creating a bet" });
        }
        const conversationsCol = await imessageConversations();
        if (!conversationsCol) return dbUnconfigured(res);
        const conversation = await conversationsCol.findOne({ id: imessageConversationId });
        if (!conversation || !conversation.memberUserIds.includes(authUser.id)) {
          return json(res, 403, { error: "join this conversation before creating a bet" });
        }
        if (!acceptorIsOpen) {
          const canonicalAcceptor = conversation.memberUsernames.find(
            (username) => username.toLowerCase() === acceptorInput.toLowerCase(),
          );
          if (!canonicalAcceptor) {
            return json(res, 400, { error: "recipient has not joined this conversation" });
          }
          acceptor = canonicalAcceptor;
        } else {
          acceptor = "anyone";
        }
      }
      if (isDiscord) {
        if (!discordConversationId) {
          return json(res, 400, { error: "discordConversationId is required for Discord bets" });
        }
        const discordConvCol = await discordConversations();
        if (!discordConvCol) return dbUnconfigured(res);
        const conversation = await discordConvCol.findOne({ id: discordConversationId });
        if (!conversation || !conversation.memberUserIds.includes(authUser.id)) {
          return json(res, 403, { error: "you must be a member of this Discord channel's conversation" });
        }
        if (!acceptorIsOpen) {
          const canonicalAcceptor = conversation.memberUsernames.find(
            (username) => username.toLowerCase() === acceptorInput.toLowerCase(),
          );
          if (!canonicalAcceptor) {
            return json(res, 400, { error: "recipient has not linked their account in this channel" });
          }
          acceptor = canonicalAcceptor;
        }
      }
      if (!isSports && terms.length < 8) return json(res, 400, { error: "terms must be at least 8 characters" });
      const numericStake = Number(stakeInput);
      if (!stakeInput || !Number.isFinite(numericStake) || numericStake <= 0) {
        return json(res, 400, { error: "stake must be a positive number" });
      }
      if (isPoints) {
        const pre = await points.precheckPointsBet(authUser, { stake: stakeInput, fallbackKind: body.fallbackKind });
        if ("error" in pre) return json(res, pre.status, { error: pre.error });
      }
      const amountLamports = isPoints ? 0 : solStakeToLamports(stakeInput);
      if (isSports) {
        if (!isSupportedSport(sport)) {
          return json(res, 400, { error: "sport must be soccer | nba | nfl | nhl" });
        }
        const sportsSport = sport;
        // Kickoff time, teams and league always come from the provider (never the
        // client): the on-chain start_time gates accept_bet, so a client-supplied
        // kickoff would let someone accept after the game began.
        if (!/^\d{1,20}$/.test(sportsGameId)) {
          return json(res, 400, { error: "gameId must be a numeric event id" });
        }
        const sportsProviderId = primarySportsProviderId();
        const requestedProvider = body.sportsProvider ?? body.provider;
        if (requestedProvider !== undefined && requestedProvider !== sportsProviderId) {
          return json(res, 409, { error: "The game list changed. Refresh and pick the game again." });
        }
        let selectedGame: SportsEvent | null;
        try {
          selectedGame = await getSportsProvider(sportsProviderId).getEvent(sportsSport, sportsGameId, {
            league: typeof body.league === "string" ? body.league : null,
            maxAgeMs: 15_000,
          });
        } catch (err) {
          console.error(`[sports] POST /bets lookup ${sportsProviderId} ${sportsSport} ${sportsGameId} failed:`, err instanceof Error ? err.message : err);
          return json(res, 502, { error: SPORTS_UNAVAILABLE_MESSAGE });
        }
        // Soccer is limited to the leagues we list on the board (no obscure feeds).
        if (!selectedGame || (sportsSport === "soccer" && !findLeague("soccer", selectedGame.league))) {
          return json(res, 400, { error: "selected game is not available on the upcoming board" });
        }
        if (selectedGame.status === "final") {
          return json(res, 400, { error: "selected game is already final" });
        }
        if (selectedGame.status !== "scheduled") {
          return json(res, 400, { error: "selected game has already started or is no longer scheduled" });
        }
        if (typeof selectedGame.startTimeMs !== "number" || !Number.isFinite(selectedGame.startTimeMs)) {
          return json(res, 400, { error: "selected game kickoff time is unavailable" });
        }
        // If the client echoed the teams it showed, make sure it was this game.
        const clientHome = typeof body.homeTeam === "string" ? body.homeTeam.trim() : "";
        const clientAway = typeof body.awayTeam === "string" ? body.awayTeam.trim() : "";
        if (
          (clientHome && !teamNamesMatch(clientHome, selectedGame.homeTeam)) ||
          (clientAway && !teamNamesMatch(clientAway, selectedGame.awayTeam))
        ) {
          return json(res, 409, { error: "The game list changed. Refresh and pick the game again." });
        }
        const chainNowSec = await currentUnixTimeSec();
        const kickoffSec = Math.floor(selectedGame.startTimeMs / 1000);
        if (kickoffSec <= chainNowSec) {
          return json(res, 400, { error: "selected game has already started" });
        }
        if (!isSportsBetWithinCreateWindow(kickoffSec, chainNowSec)) {
          return json(res, 400, {
            error: "sports bets can only be created within 24 hours before kickoff",
          });
        }
        sportsKickoffSec = kickoffSec;
        sportsEvent = selectedGame;
        homeTeam = selectedGame.homeTeam.trim();
        awayTeam = selectedGame.awayTeam.trim();
        if (!homeTeam || !awayTeam) {
          return json(res, 400, { error: "selected game teams are unavailable" });
        }
        if (terms.length < 8) {
          const backedTeam = challengerBacksHome ? homeTeam : awayTeam;
          terms = `${sportsSport.toUpperCase()}: ${awayTeam} @ ${homeTeam} — ${challenger} backs ${backedTeam}.`;
        }
      }
      if (terms.length < 8) {
        return json(res, 400, { error: "terms must be at least 8 characters" });
      }
      // Recurring check-in bets: the schedule fixes resolveByDate and caps acceptByDate.
      const scheduledInput = isSports ? null : parseScheduledBetInput(body, Date.now());
      if (scheduledInput && "error" in scheduledInput) return json(res, 400, { error: scheduledInput.error });
      const scheduled = scheduledInput && !("error" in scheduledInput) ? scheduledInput : null;
      if (scheduled) {
        body.acceptByDate = scheduled.acceptByDate(body.acceptByDate);
        body.resolveByDate = scheduled.resolveByDate;
      }

      const group = groupId
        ? await groupsCol.findOne({ id: groupId }, { projection: { _id: 0 } })
        : null;
      if (!isIMessage && !isDiscord && !group) return json(res, 404, { error: "group not found" });
      if (!isIMessage && !isDiscord && group && !isGroupMember(group, authUser.username)) {
        return json(res, 403, { error: "group membership required" });
      }
      // Points bets never touch a wallet; the stake was checked by precheckPointsBet.
      let challengerKp: web3.Keypair | undefined;
      if (!isPoints) try {
        challengerKp = await ensureUserWallet(authUser);
        await requireSolBalanceForBet(challengerKp.publicKey, amountLamports, "challenger");
      } catch (err) {
        if (err instanceof InsufficientSolBalanceError) {
          return json(res, 400, { error: err.message });
        }
        return json(res, 502, {
          error: `failed to verify challenger SOL balance: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const now = Date.now();
      const ts = formatChatClock(now);
      const isMessagingSource = isIMessage || isDiscord;
      const witnesses = isMessagingSource ? 1 : Math.max(1, Math.floor(toFiniteNumber(body.witnesses, 1)));
      const minBettors = isMessagingSource ? 2 : Math.max(1, Math.floor(toFiniteNumber(body.minBettors, 2)));
      const groupSize = isMessagingSource ? 2 : Math.max(1, Math.floor(toFiniteNumber(group?.members, 1)));

      // Witness bets (non-sports) carry a resolve-by deadline, an optional accept-by
      // deadline (indefinite when omitted), and a precommitted unresolved fallback.
      let witnessFields: Partial<BetDoc> = {};
      if (!isSports) {
        const resolveByDate = toFiniteNumber(
          body.resolveByDate,
          isMessagingSource ? now + 7 * 24 * 60 * 60 * 1000 : 0,
        );
        if (!resolveByDate || resolveByDate <= now) {
          return json(res, 400, { error: "resolveByDate (a future time) is required" });
        }
        const acceptByRaw = body.acceptByDate;
        const acceptByDate = acceptByRaw === null || acceptByRaw === undefined
          ? null
          : isFiniteNumber(acceptByRaw) ? acceptByRaw : NaN;
        if (typeof acceptByDate === "number" && Number.isNaN(acceptByDate)) {
          return json(res, 400, { error: "acceptByDate must be a number or null (indefinite)" });
        }
        if (acceptByDate !== null && acceptByDate <= now) {
          return json(res, 400, { error: "acceptByDate must be in the future or indefinite" });
        }
        if (acceptByDate !== null && acceptByDate > resolveByDate) {
          return json(res, 400, { error: "acceptByDate must be on or before resolveByDate" });
        }
        const fallbackKind: BetDoc["fallbackKind"] =
          body.fallbackKind === "burn" || body.fallbackKind === "charity" ? body.fallbackKind : "return";
        // Points bets have no on-chain destination (charity is rejected by precheckPointsBet).
        let fallbackDest: string | undefined = isPoints ? undefined : BURN_ADDRESS.toBase58();
        let charityName: string | undefined;
        if (fallbackKind === "charity") {
          const addr = typeof body.charityAddress === "string" ? body.charityAddress.trim() : "";
          try {
            fallbackDest = new web3.PublicKey(addr).toBase58();
          } catch {
            return json(res, 400, { error: "a valid charity address is required" });
          }
          // settle_social credits this account directly; a builtin/program (executable)
          // account can't be credited and would leave the pot stuck in escrow.
          try {
            const destPubkey = new web3.PublicKey(fallbackDest);
            const destInfo = destPubkey.equals(web3.SystemProgram.programId)
              ? null
              : await connection.getAccountInfo(destPubkey);
            if (destPubkey.equals(web3.SystemProgram.programId) || destInfo?.executable) {
              return json(res, 400, { error: "charity address must be a wallet, not a program" });
            }
          } catch (err) {
            return json(res, 502, {
              error: `failed to verify charity address: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          charityName = typeof body.charityName === "string" && body.charityName.trim()
            ? body.charityName.trim()
            : undefined;
        }
        witnessFields = { acceptByDate, resolveByDate, fallbackKind, fallbackDest, charityName };
      }

      const betDoc: BetDoc = {
        id: `bet-${now}-${crypto.randomBytes(3).toString("hex")}`,
        createdAt: now,
        ...(isIMessage ? { source: "imessage" as const } : isDiscord ? { source: "discord" as const } : { groupId }),
        ...(isIMessage ? { imessageConversationId } : {}),
        ...(isDiscord ? { discordConversationId } : {}),
        type,
        challenger,
        acceptor,
        terms,
        stake: stakeInput,
        currency,
        status: "PENDING",
        witnesses,
        minBettors,
        groupSize,
        ...(isSports ? {
          validation: "sports" as const,
          sport: sport as BetDoc["sport"],
          // espnGameId is mirrored for older clients; sportsProvider marks this as a
          // post-migration bet (legacy docs without it hold TheSportsDB ids).
          espnGameId: sportsGameId,
          sportsProvider: sportsEvent?.provider,
          sportsEventId: sportsGameId,
          sportsLeague: sportsEvent?.league ?? null,
          sportsHomeTeamId: sportsEvent?.homeTeamId ?? null,
          sportsAwayTeamId: sportsEvent?.awayTeamId ?? null,
          homeTeam,
          awayTeam,
          challengerBacksHome,
        } : {}),
        ...witnessFields,
        ...(isPoints ? { onChain: false } : {}),
        ...(scheduled ? scheduled.fields : {}),
      };
      await betsCol.insertOne(betDoc);

      // Sports bets escrow the challenger's stake at post time and must be accepted
      // before kickoff (an acceptor after the result is known would be unfair). Witness
      // bets escrow nothing yet — they stay PENDING and wait indefinitely for a taker;
      // both stakes are escrowed atomically when someone accepts (see POST /bets/accept).
      // Points sports bets hold the challenger's points the same way, off-chain.
      if (isSports && isPoints) {
        const kickoff = sportsKickoffSec ?? 0;
        if (!kickoff) {
          await betsCol.deleteOne({ id: betDoc.id });
          return json(res, 500, { error: "sports bet kickoff was not resolved" });
        }
        const held = await points
          .holdPointsForSportsCreate(betDoc, authUser, kickoff, kickoff + Math.max(1, SPORTS_BET_SETTLE_AFTER_SECS))
          .catch(async (err) => {
            await betsCol.deleteOne({ id: betDoc.id, pointsState: { $exists: false } });
            throw err;
          });
        if ("error" in held) {
          await betsCol.deleteOne({ id: betDoc.id, pointsState: { $exists: false } });
          return json(res, held.status, { error: held.error });
        }
        Object.assign(betDoc, held.fields);
      } else if (isSports && challengerKp) {
        try {
          if (!sportsKickoffSec) {
            return json(res, 500, { error: "sports bet kickoff was not resolved" });
          }
          const startTime = sportsKickoffSec;
          const settleAfter = startTime + Math.max(1, SPORTS_BET_SETTLE_AFTER_SECS);
          // Use the unique database bet id on-chain. The provider event id lives in
          // sportsProvider + sportsEventId and is used by crankSportsBets for settlement.
          const onChainSport = ON_CHAIN_SPORT_INDEX[sport as Sport];
          const backsHome    = challengerBacksHome ?? true;
          const gid = gameIdBytes(betDoc.id);
          const betPda = sportsBetPda(challengerKp.publicKey, gid);
          const vault = sportsVaultPda(betPda);
          const sig = await programAs(challengerKp)
            .methods.createBet(
              new BN(amountLamports),
              oracle.publicKey,
              onChainSport,
              gid,
              backsHome, // creator (challenger) backs home/challenger side
              new BN(startTime),
              new BN(settleAfter),
            )
            .accountsStrict({
              creator: challengerKp.publicKey,
              sportsBet: betPda,
              vault,
              systemProgram: web3.SystemProgram.programId,
            })
            .rpc();
          Object.assign(betDoc, {
            onChain: true,
            betPda: betPda.toBase58(),
            commitmentId: betPda.toBase58(),
            startTime,
            settleAfter,
            onChainState: "open" as const,
            createSig: sig,
          });
          await betsCol.updateOne({ id: betDoc.id }, { $set: {
            onChain: true, betPda: betDoc.betPda, commitmentId: betDoc.commitmentId,
            startTime, settleAfter, onChainState: "open", createSig: sig,
          } });
        } catch (err) {
          await betsCol.deleteOne({ id: betDoc.id });
          if (err instanceof InsufficientSolBalanceError) {
            return json(res, 400, { error: err.message });
          }
          return json(res, 502, {
            error: `failed to escrow SOL on-chain: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (isIMessage || isDiscord) {
        return json(res, 201, { bet: normalizeBetDoc(betDoc) });
      }

      const systemMessage: MessageDoc = {
        id: `m-${now}-${crypto.randomBytes(2).toString("hex")}`,
        groupId,
        sender: "System",
        initials: "SY",
        betId: betDoc.id,
        system: true,
        ts,
        createdAt: now,
      };
      await messagesCol.insertOne(systemMessage);

      await groupsCol.updateOne(
        { id: groupId },
        {
          $set: {
            pendingBet: true,
            lastMsg: `${challenger} posted a new ${isSports || type === "DEV" ? "sports" : "personal"} bet`,
            time: ts,
            updatedAt: now,
          },
        },
      );

      return json(res, 201, { bet: normalizeBetDoc(betDoc), message: systemMessage });
    }

    // POST /bets/accept  { betId }  — intended opponent accepts and activates a pending bet
    if (req.method === "POST" && req.url === "/bets/accept") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const betsCol = await bets();
      const groupsCol = await groups();
      const messagesCol = await messages();
      if (!betsCol || !groupsCol || !messagesCol) return dbUnconfigured(res);

      const body = await readJson(req);
      const betId = typeof body.betId === "string" ? body.betId.trim() : "";
      if (!betId) return json(res, 400, { error: "betId is required" });

      const existing = await betsCol.findOne({ id: betId }, { projection: { _id: 0 } });
      if (!existing) return json(res, 404, { error: "bet not found" });
      const bet = normalizeBetDoc(existing);
      if (bet.status !== "PENDING") {
        return json(res, 409, { error: "bet is no longer open for acceptance", bet });
      }
      if (isWitnessOfferExpired(bet, Date.now())) {
        return json(res, 409, { error: "this offer expired before it was accepted", bet });
      }

      const linkedMessage = bet.groupId ? null : await messagesCol.findOne({ betId }, { projection: { groupId: 1 } });
      const groupId = bet.groupId ?? linkedMessage?.groupId;
      const group = groupId ? await groupsCol.findOne({ id: groupId }, { projection: { _id: 0 } }) : null;
      if (bet.source !== "imessage" && bet.source !== "discord" && (!group || !isGroupMember(group, authUser.username))) {
        return json(res, 403, { error: "group membership required" });
      }
      if (authUser.username.toLowerCase() === bet.challenger.toLowerCase()) {
        return json(res, 400, { error: "you cannot accept your own bet" });
      }
      const addressed = bet.acceptor && bet.acceptor.toLowerCase() !== "anyone";
      if (addressed && bet.acceptor.toLowerCase() !== authUser.username.toLowerCase()) {
        return json(res, 403, { error: "this bet is addressed to someone else" });
      }

      const acceptedAt = Date.now();
      const update: Partial<BetDoc> = {
        status: "ACTIVE",
        opponentUsername: authUser.username,
        acceptedBy: authUser.username,
        acceptedAt,
      };
      // "anyone" DEV bets adopt the actual acceptor so the card shows who accepted.
      if (!addressed) update.acceptor = authUser.username;

      const usersCol = await users();
      if (!usersCol) return dbUnconfigured(res);

      // Points bets hold stakes off-chain (relayer/points.ts); no wallet, no RPC.
      if (bet.currency === "PTS") {
        const out = await points.acceptPointsBet(bet, authUser, update);
        if (out.status === 200 && out.body.bet) out.body.bet = normalizeBetDoc(out.body.bet as BetDoc);
        return json(res, out.status, out.body);
      }

      try {
        const amountLamports = solStakeToLamports(bet.stake);
        const acceptorKp = await ensureUserWallet(authUser);
        await requireSolBalanceForBet(acceptorKp.publicKey, amountLamports, "acceptor");

        if (bet.validation === "sports") {
          // Sports bets are escrowed at post time; the opponent just stakes the other
          // side, and the program enforces accept-before-kickoff.
          if (!bet.onChain || !bet.betPda || bet.onChainState !== "open") {
            return json(res, 409, { error: "this sports bet is no longer open for acceptance", bet });
          }
          // The on-chain start_time is the kickoff recorded at creation. Re-check the
          // provider so a game moved earlier (or already underway / postponed) can't be
          // accepted with the result partly known. Legacy TheSportsDB bets rely on the
          // program's check alone when that provider isn't configured.
          const sportsProviderId = isSportsProviderId(bet.sportsProvider) ? bet.sportsProvider : null;
          const sportsEventId = `${bet.sportsEventId ?? ""}`.trim();
          if (sportsProviderId && sportsEventId && getSportsProvider(sportsProviderId).isConfigured()) {
            let liveGame: SportsEvent | null;
            try {
              liveGame = await getSportsProvider(sportsProviderId).getEvent(
                isSupportedSport(bet.sport) ? bet.sport : null,
                sportsEventId,
                { league: bet.sportsLeague ?? null, maxAgeMs: 15_000 },
              );
            } catch (err) {
              console.error(`[sports] accept lookup ${sportsProviderId} ${sportsEventId} failed:`, err instanceof Error ? err.message : err);
              return json(res, 503, { error: "Couldn't verify the game right now. Try again in a minute." });
            }
            if (
              !liveGame ||
              liveGame.status !== "scheduled" ||
              liveGame.startTimeMs === null ||
              liveGame.startTimeMs <= Date.now()
            ) {
              return json(res, 409, {
                error: "This game has already started or was rescheduled, so the bet can't be accepted.",
                bet,
              });
            }
          }
          const betPda = new web3.PublicKey(bet.betPda);
          const vault = sportsVaultPda(betPda);
          const sig = await programAs(acceptorKp)
            .methods.acceptBet()
            .accountsStrict({
              opponent: acceptorKp.publicKey,
              sportsBet: betPda,
              vault,
              systemProgram: web3.SystemProgram.programId,
            })
            .rpc();
          Object.assign(update, { onChainState: "locked", acceptSig: sig });
        } else {
          // Witness bets escrow BOTH stakes atomically here — nothing was on-chain while
          // the bet waited, so it never expired. The relayer signs for the (custodial)
          // challenger even though they posted the bet earlier.
          const challengerUser = await usersCol.findOne({ usernameLower: bet.challenger.toLowerCase() });
          if (!challengerUser) return json(res, 409, { error: "challenger account not found" });
          const challengerKp = await ensureUserWallet(challengerUser);
          await requireSolBalanceForBet(challengerKp.publicKey, amountLamports, "challenger");

          const gid = gameIdBytes(bet.id);

          if (SOCIAL_ESCROW_ENABLED && typeof bet.resolveByDate === "number") {
            // SocialBet escrow: the resolve-by date and fallback are recorded on-chain, so
            // settle_social can enforce them even if no witness quorum is ever reached.
            const chainNowSec = await currentUnixTimeSec();
            const endDate = Math.floor(bet.resolveByDate / 1000);
            if (endDate <= chainNowSec + SOCIAL_ESCROW_MIN_WINDOW_SECS) {
              return json(res, 409, { error: "this bet's resolve-by date has passed", bet });
            }
            const fallbackKind = bet.fallbackKind ?? "return";
            const fallbackDest = new web3.PublicKey(bet.fallbackDest ?? BURN_ADDRESS.toBase58());
            const socialBet = socialBetPda(challengerKp.publicKey, gid);
            const escrowIx = await programAs(challengerKp)
              .methods.escrowBet(
                new BN(amountLamports),
                oracle.publicKey,
                gid,
                new BN(endDate),
                FALLBACK_KIND_CODE[fallbackKind],
                fallbackDest,
              )
              .accountsStrict({
                challenger: challengerKp.publicKey,
                opponent: acceptorKp.publicKey,
                socialBet,
                vault: socialVaultPda(socialBet),
                systemProgram: web3.SystemProgram.programId,
              })
              .instruction();
            const tx = new web3.Transaction().add(escrowIx);
            const sig = await web3.sendAndConfirmTransaction(connection, tx, [challengerKp, acceptorKp]);
            Object.assign(update, {
              onChain: true,
              onChainKind: "social",
              betPda: socialBet.toBase58(),
              commitmentId: socialBet.toBase58(),
              onChainState: "locked",
              createSig: sig,
              acceptSig: sig,
            });
          } else {
            // Legacy SportsBet escrow (docs without a resolve-by date, or social escrow disabled).
            const betPda = sportsBetPda(challengerKp.publicKey, gid);
            const vault = sportsVaultPda(betPda);

            // Base timestamps on the chain clock (avoids skew); the accept window only has
            // to span this single atomic transaction.
            const slot = await connection.getSlot("confirmed");
            const base = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
            const startTime = base + SOCIAL_BET_SETTLE_DELAY_SECS;
            const settleAfter = startTime + 1;

            const createIx = await programAs(challengerKp)
              .methods.createBet(
                new BN(amountLamports),
                oracle.publicKey,
                SOCIAL_BET_SPORT,
                gid,
                true, // challenger backs the "home"/challenger side
                new BN(startTime),
                new BN(settleAfter),
              )
              .accountsStrict({
                creator: challengerKp.publicKey,
                sportsBet: betPda,
                vault,
                systemProgram: web3.SystemProgram.programId,
              })
              .instruction();
            const acceptIx = await programAs(acceptorKp)
              .methods.acceptBet()
              .accountsStrict({
                opponent: acceptorKp.publicKey,
                sportsBet: betPda,
                vault,
                systemProgram: web3.SystemProgram.programId,
              })
              .instruction();

            const tx = new web3.Transaction().add(createIx, acceptIx);
            const sig = await web3.sendAndConfirmTransaction(connection, tx, [challengerKp, acceptorKp]);

            Object.assign(update, {
              onChain: true,
              onChainKind: "sports",
              betPda: betPda.toBase58(),
              commitmentId: betPda.toBase58(),
              startTime,
              settleAfter,
              onChainState: "locked",
              createSig: sig,
              acceptSig: sig,
            });
          }
        }

        // The on-chain program already prevents a second acceptance (the PDA/state is
        // unique), so this just records the result.
        // Funds are escrowed by now, so record unconditionally (and undo an expiry the
        // crank may have raced in at the deadline).
        await betsCol.updateOne({ id: betId }, { $set: update, $unset: { offerExpired: "" } });
        const updated = await betsCol.findOne({ id: betId }, { projection: { _id: 0 } });
        return json(res, 200, { bet: updated ? normalizeBetDoc(updated) : { ...bet, ...update } });
      } catch (err) {
        if (err instanceof InsufficientSolBalanceError) {
          return json(res, 400, { error: err.message });
        }
        return json(res, 502, {
          error: `failed to escrow SOL on-chain: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // GET /bets — bets linked to the current user's groups and iMessage/Discord
    // conversations, plus bets they are a party to. Only context members may vote
    // as witnesses, so bets from other contexts are not listed.
    if (req.method === "GET" && req.url === "/bets") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const betsCol = await bets();
      const groupsCol = await groups();
      const messagesCol = await messages();
      if (!betsCol || !groupsCol || !messagesCol) return dbUnconfigured(res);
      const docs = await betsCol.find(await visibleBetsFilter(authUser), { projection: { _id: 0 } }).toArray();
      // Every listed bet is in the viewer's chats or involves them, so proof is viewable.
      return json(res, 200, {
        bets: await decorateBetsForViewer(featureCtx, authUser, docs, { contextMember: true }),
      });
    }

    // POST /bets/vote  { betId, votedFor }  — cast/update witness vote
    if (req.method === "POST" && req.url === "/bets/vote") {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const col = await bets();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      const betId = typeof body.betId === "string" ? body.betId.trim() : "";
      const voter = authUser.username;
      const votedFor = body.votedFor;

      if (!betId) return json(res, 400, { error: "betId is required" });
      if (votedFor !== "challenger" && votedFor !== "acceptor") {
        return json(res, 400, { error: "votedFor must be challenger or acceptor" });
      }

      const existing = await col.findOne({ id: betId }, { projection: { _id: 0 } });
      if (!existing) return json(res, 404, { error: "bet not found" });
      const current = normalizeBetDoc(existing);
      const voterLower = voter.toLowerCase();
      const isParticipant = [
        current.challenger,
        current.acceptor,
        current.acceptedBy,
        current.opponentUsername,
      ].some(
        (name) => typeof name === "string" && name.trim().toLowerCase() === voterLower,
      );
      if (isParticipant) {
        return json(res, 403, {
          error: "bet participants cannot vote as witnesses",
          bet: current,
        });
      }
      if (!(await isBetContextMember(authUser, current))) {
        return json(res, 403, {
          error: current.source === "imessage"
            ? "only members of this iMessage conversation can vote on this bet"
            : current.source === "discord"
              ? "only members of this Discord channel can vote on this bet"
              : "only members of this bet's group can vote on it",
        });
      }
      if (current.validation === "sports") {
        return json(res, 409, {
          error: "sports bets are settled by the official sports feed result, not witness votes",
          bet: current,
        });
      }
      if (current.schedule) return json(res, 409, { error: SCHEDULED_BET_VOTE_ERROR, bet: current });
      if (isBetCompletedStatus(current.status)) {
        return json(res, 409, { error: "bet is already completed", bet: current });
      }
      if (current.status !== "ACTIVE") {
        return json(res, 409, { error: "bet must be accepted before voting", bet: current });
      }
      // On-chain SOL bets can only be resolved once both sides have staked (locked).
      if (current.onChain && current.currency === "SOL" && current.onChainState !== "locked") {
        return json(res, 409, {
          error: "both sides must stake before this bet can be voted on",
          bet: current,
        });
      }

      // The resolve-by date is a hard voting deadline; after it the crank applies
      // the precommitted fallback instead.
      if (typeof current.resolveByDate === "number" && Date.now() >= current.resolveByDate) {
        return json(res, 409, { error: "the resolve-by date has passed; voting is closed", bet: current });
      }

      const nextVotesByVoter: Record<string, BetVoteChoice> = {
        ...current.votesByVoter,
        [voter]: votedFor,
      };
      const votes = countBetVotes(nextVotesByVoter);
      const witnessThreshold = Math.max(1, Number(current.witnesses) || 1);
      const winner: BetVoteChoice | undefined =
        votes.challenger >= witnessThreshold
          ? "challenger"
          : votes.acceptor >= witnessThreshold
            ? "acceptor"
            : undefined;
      const nextStatus: BetDoc["status"] = winner
        ? "COMPLETED"
        : current.status;

      // Conditional write: never overwrite a bet that completed or had its fallback
      // claimed by the crank after we read it.
      const voteWrite = await col.updateOne(
        {
          id: betId,
          status: "ACTIVE",
          fallbackApplied: { $exists: false },
          fallbackBlocked: { $exists: false },
        },
        {
          $set: {
            votesByVoter: nextVotesByVoter,
            status: nextStatus,
            ...(winner ? { resolvedWinner: winner } : {}),
          },
        },
      );
      if (voteWrite.matchedCount === 0) {
        const latest = await col.findOne({ id: betId }, { projection: { _id: 0 } });
        return json(res, 409, {
          error: "this bet was resolved before your vote was recorded",
          ...(latest ? { bet: normalizeBetDoc(latest) } : {}),
        });
      }
      if (!winner && current.resolvedWinner) {
        await col.updateOne({ id: betId, status: "ACTIVE" }, { $unset: { resolvedWinner: "" } });
      }

      const updated = await col.findOne({ id: betId }, { projection: { _id: 0 } });
      if (!updated) return json(res, 404, { error: "bet not found after update" });
      return json(res, 200, { bet: normalizeBetDoc(updated) });
    }

    // GET /leaderboard[?discordGuildId=...] — Mongo standings excluding iMessage.
    // Discord standings are grouped across every bot channel in a server.
    if (req.method === "GET" && req.url && /^\/leaderboard(?:\?|$)/.test(req.url)) {
      const authUser = await getAuthenticatedUser(req);
      if (!authUser) return json(res, 401, { error: "unauthorized" });
      const [usersCol, betsCol, profilesCol, playersCol, discordConvCol] = await Promise.all([
        users(),
        bets(),
        profiles(),
        players(),
        discordConversations(),
      ]);
      if (!usersCol || !betsCol || !profilesCol || !playersCol || !discordConvCol) return dbUnconfigured(res);
      const [userDocs, discordBetDocs, webBetDocs, profileDocs, legacyPlayers, discordConversationDocs] = await Promise.all([
        usersCol.find({}, { projection: { _id: 0 } }).toArray(),
        betsCol.find({ source: "discord" }, { projection: { _id: 0 } }).toArray(),
        betsCol.find({ source: { $exists: false } }, { projection: { _id: 0 } }).toArray(),
        profilesCol.find({}, { projection: { _id: 0 } }).toArray(),
        playersCol.find({}, { projection: { _id: 0 } }).toArray(),
        discordConvCol.find({ guildId: { $type: "string" } }, { projection: { _id: 0 } }).toArray(),
      ]);
      const conversationById = new Map(discordConversationDocs.map((conversation) => [conversation.id, conversation]));
      const guildId = new URL(req.url, "http://x").searchParams.get("discordGuildId")?.trim() ?? "";
      if (guildId && !DISCORD_ENABLED) {
        return json(res, 404, { error: "Discord integration is disabled" });
      }
      const isAuthParticipant = (bet: BetDoc): boolean => [
        bet.challenger,
        bet.acceptor,
        bet.acceptedBy,
        bet.opponentUsername,
      ].some((username) => username?.toLowerCase() === authUser.usernameLower);
      const visibleGuildIds = new Set<string>();
      for (const conversation of discordConversationDocs) {
        if (conversation.guildId && conversation.memberUserIds.includes(authUser.id)) {
          visibleGuildIds.add(conversation.guildId);
        }
      }
      for (const bet of discordBetDocs) {
        const betGuildId = bet.discordConversationId
          ? conversationById.get(bet.discordConversationId)?.guildId
          : null;
        if (betGuildId && isAuthParticipant(bet)) visibleGuildIds.add(betGuildId);
      }
      if (guildId && !visibleGuildIds.has(guildId)) {
        return json(res, 403, { error: "Discord server leaderboard access required" });
      }
      const selectedDiscordBets = guildId
        ? discordBetDocs.filter((bet) => (
          bet.discordConversationId
          && conversationById.get(bet.discordConversationId)?.guildId === guildId
        ))
        : discordBetDocs;
      const leaderboardBets = guildId ? selectedDiscordBets : [...webBetDocs, ...discordBetDocs];
      const discordServers = (DISCORD_ENABLED ? [...visibleGuildIds] : []).map((visibleGuildId) => {
        const conversations = discordConversationDocs.filter((conversation) => conversation.guildId === visibleGuildId);
        const memberUsernames = new Set(conversations.flatMap((conversation) => conversation.memberUsernames));
        for (const bet of discordBetDocs) {
          if (!bet.discordConversationId || conversationById.get(bet.discordConversationId)?.guildId !== visibleGuildId) continue;
          for (const username of [bet.challenger, bet.acceptor, bet.acceptedBy, bet.opponentUsername]) {
            if (username && username.toLowerCase() !== "anyone") memberUsernames.add(username);
          }
        }
        return {
          id: visibleGuildId,
          name: conversations.find((conversation) => conversation.guildName)?.guildName ?? `Discord server ${visibleGuildId}`,
          memberUsernames: [...memberUsernames],
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      // Points and SOL are ranked separately (?currency=PTS|SOL). Default: SOL while SOL
      // bets are enabled (existing clients), otherwise PTS.
      const currencyParam = new URL(req.url, "http://x").searchParams.get("currency")?.trim().toUpperCase() || "";
      const lbCurrency = currencyParam || (points.SOL_BETS_ENABLED ? "SOL" : "PTS");
      if (!points.isBetCurrency(lbCurrency)) return json(res, 400, { error: "currency must be PTS or SOL" });
      const currencyBets = leaderboardBets.filter((bet) => points.betCurrencyOf(bet) === lbCurrency);
      const lbPlayers = buildLeaderboardPlayers(userDocs, profileDocs, legacyPlayers, currencyBets);
      return json(res, 200, {
        currency: lbCurrency,
        players: lbCurrency === "PTS" ? await points.rankPlayersByPoints(lbPlayers, userDocs) : lbPlayers,
        discordServers,
        ...(guildId ? { bets: selectedDiscordBets.map(normalizeBetDoc) } : {}),
      });
    }

    // GET /profiles  — all profile records
    if (req.method === "GET" && req.url === "/profiles") {
      const col = await profiles();
      if (!col) return dbUnconfigured(res);
      const docs = await col
        .find({}, { projection: { _id: 0 } })
        .sort({ sol: -1, updatedAt: -1 })
        .toArray();
      return json(res, 200, { profiles: docs });
    }

    // GET /profiles/:id  — one profile by id
    if (req.method === "GET" && req.url?.startsWith("/profiles/")) {
      const col = await profiles();
      if (!col) return dbUnconfigured(res);
      const id = decodeProfilePathId(req.url);
      if (!id) return json(res, 400, { error: "profile id is required" });
      const doc = await col.findOne({ id }, { projection: { _id: 0 } });
      if (!doc) return json(res, 404, { error: "profile not found" });
      return json(res, 200, { profile: doc });
    }

    // POST /profiles  { name, initials?, github?, bio?, ...stats }
    if (req.method === "POST" && req.url === "/profiles") {
      const col = await profiles();
      if (!col) return dbUnconfigured(res);
      const body = await readJson(req);
      if (typeof body.name !== "string" || body.name.trim().length < 2)
        return json(res, 400, { error: "name is required (min 2 chars)" });
      const now = Date.now();
      const doc: ProfileDoc = {
        id: `u-${now}`,
        name: body.name.trim(),
        initials: toInitials(typeof body.initials === "string" ? body.initials : body.name),
        github: typeof body.github === "string" && body.github.trim() ? body.github.trim() : `user-${now}`,
        bio: typeof body.bio === "string" ? body.bio.trim() : undefined,
        sol: toFiniteNumber(body.sol, 0),
        wins: toFiniteNumber(body.wins, 0),
        disputes: toFiniteNumber(body.disputes, 0),
        streak: toFiniteNumber(body.streak, 0),
        streakDir: body.streakDir === "up" || body.streakDir === "down" ? body.streakDir : "neutral",
        createdAt: now,
        updatedAt: now,
      };
      await col.insertOne(doc);
      return json(res, 201, { profile: doc });
    }

    // PATCH /profiles/:id  — partial profile updates
    if (req.method === "PATCH" && req.url?.startsWith("/profiles/")) {
      const col = await profiles();
      if (!col) return dbUnconfigured(res);
      const id = decodeProfilePathId(req.url);
      if (!id) return json(res, 400, { error: "profile id is required" });
      const body = await readJson(req);
      const update: Partial<ProfileDoc> = {};
      if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
      if (typeof body.initials === "string" && body.initials.trim()) update.initials = toInitials(body.initials);
      if (typeof body.github === "string" && body.github.trim()) update.github = body.github.trim();
      if (typeof body.bio === "string") update.bio = body.bio.trim();
      if (isFiniteNumber(body.sol)) update.sol = body.sol;
      if (isFiniteNumber(body.wins)) update.wins = body.wins;
      if (isFiniteNumber(body.disputes)) update.disputes = body.disputes;
      if (isFiniteNumber(body.streak)) update.streak = body.streak;
      if (body.streakDir === "up" || body.streakDir === "down" || body.streakDir === "neutral") update.streakDir = body.streakDir;
      if (Object.keys(update).length === 0)
        return json(res, 400, { error: "no valid fields provided for update" });
      update.updatedAt = Date.now();
      await col.updateOne({ id }, { $set: update });
      const doc = await col.findOne({ id }, { projection: { _id: 0 } });
      if (!doc) return json(res, 404, { error: "profile not found" });
      return json(res, 200, { profile: doc });
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (err instanceof Error && err.name.startsWith("Mongo")) {
      return json(res, 503, {
        error: "database unavailable; check MongoDB Atlas network access",
      });
    }
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`relayer listening on http://${HOST}:${PORT}`);
  console.log(`oracle: ${oracle.publicKey.toBase58()}`);
  console.log(`program: ${program.programId.toBase58()}`);
});

setInterval(() => void runPoll(), POLL_INTERVAL);
void runPoll();

// Start the Discord bot only when the integration is enabled (it also no-ops
// gracefully when DISCORD_BOT_TOKEN is unset).
if (DISCORD_ENABLED) {
  void startDiscordBot().catch((err) => console.error("Discord bot failed to start:", err));
} else {
  console.log("Discord integration disabled (set DISCORD_ENABLED=true to enable)");
}

// Points settlement never touches the chain, so it runs first and on its own (an
// RPC outage must not stall play-money payouts). Points sports bets go through the
// same decideSportsSettlement() rules as SOL ones (final-only, postponed/cancelled
// refunds after the grace window, stale-data and team-change checks).
async function pointsSportsResult(bet: BetDoc): Promise<{ homeWon: boolean | null } | null> {
  if (!isSupportedSport(bet.sport) || bet.sportsSettlementBlocked) return null;
  const provider: SportsProviderId = isSportsProviderId(bet.sportsProvider) ? bet.sportsProvider : "thesportsdb";
  const eventId = `${bet.sportsEventId ?? bet.espnGameId ?? ""}`.trim();
  if (!/^\d+$/.test(eventId) || !getSportsProvider(provider).isConfigured()) return null;
  const primary = await getFinalResult(provider, eventId, { sport: bet.sport, league: bet.sportsLeague ?? null });
  const secondaryId = secondarySportsProviderId();
  let secondary: FinalResult | null | undefined;
  if (secondaryId && secondaryId !== provider && primary.status === "final") {
    secondary = primary.homeTeam && primary.awayTeam && primary.startTimeMs !== null
      ? await getCrossCheckResult(secondaryId, {
          sport: bet.sport,
          league: primary.league ?? bet.sportsLeague ?? null,
          homeTeam: primary.homeTeam,
          awayTeam: primary.awayTeam,
          startTimeMs: primary.startTimeMs,
        })
      : null;
  }
  const action = decideSportsSettlement({
    nowMs: Date.now(),
    scheduledKickoffMs: (bet.startTime ?? 0) * 1000,
    acceptedAtMs: bet.acceptedAt ?? null,
    expected: { homeTeamId: bet.sportsHomeTeamId, awayTeamId: bet.sportsAwayTeamId },
    primary,
    secondary,
    graceMs: SPORTS_CANCEL_GRACE_MS,
    maxResultAgeMs: SPORTS_RESULT_MAX_AGE_MS,
  });
  if (action.type === "settle") return { homeWon: action.homeWon };
  if (action.type === "block") {
    console.error(`OPERATOR ACTION REQUIRED: points sports bet ${bet.id} was NOT settled: ${action.reason}`);
    const col = await bets();
    await col?.updateOne(
      { id: bet.id },
      { $set: { sportsSettlementBlocked: true, sportsSettlementBlockedReason: action.reason, sportsSettlementBlockedAt: Date.now() } },
    );
  }
  return null; // wait (points crank refunds after POINTS_SPORTS_RESULT_TIMEOUT_HOURS)
}

function runPointsCrank(): Promise<points.PointsCrankReport> {
  return points.crankPointsBets({ fetchSportsResult: pointsSportsResult });
}

async function runPoll(): Promise<void> {
  await runPointsCrank().catch((err) => console.error("points crank error:", err));
  try {
    // Decide check-in bets first (independent of RPC health) so a decidable bet
    // never loses to crankWitnessBets' fallback claim.
    await crankCheckinBets(featureCtx).catch((err) => console.error("check-in crank error:", err));
    await crankTimeouts();
    await crankSportsBets();
    await crankWitnessBets();
  } catch (err) {
    console.error("poll error:", err);
  }
}

// ── utils ─────────────────────────────────────────────────────────────────────

function loadKeypair(filename: string): web3.Keypair {
  const expanded = filename.startsWith("~/")
    ? path.join(os.homedir(), filename.slice(2))
    : filename;
  return web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expanded, "utf8")) as number[])
  );
}

function parsePublicKey(value: string | undefined, fallback: web3.PublicKey): web3.PublicKey {
  if (!value) return fallback;
  try {
    return new web3.PublicKey(value);
  } catch {
    console.warn(`invalid public key "${value}", falling back to ${fallback.toBase58()}`);
    return fallback;
  }
}
function formatChatClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}


type AuthTokenPayload = {
  uid: string;
  email: string;
  username: string;
  exp: number;
};

function signAuthToken(uid: string, email: string, username: string): string {
  const payload: AuthTokenPayload = {
    uid,
    email,
    username,
    exp: Date.now() + AUTH_SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyAuthToken(token: string): AuthTokenPayload | null {
  const [encoded, providedSignature] = token.split(".");
  if (!encoded || !providedSignature) return null;
  const expectedSignature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(encoded)
    .digest("base64url");
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AuthTokenPayload;
    if (!payload?.uid || !payload?.email || !payload?.username) return null;
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email) return null;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return valid ? email : null;
}

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim();
  if (!username) return null;
  const valid = /^[a-zA-Z0-9._-]{3,24}$/.test(username);
  return valid ? username : null;
}

function normalizeIMessageParticipantId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const participantId = value.trim().toLowerCase();
  if (!participantId || participantId.length > 128) return null;
  return /^[a-z0-9-]+$/.test(participantId) ? participantId : null;
}

function toIMessageConversation(authUser: UserDoc, conversation: IMessageConversationDoc): Record<string, unknown> {
  return {
    id: conversation.id,
    ownerUsername: conversation.ownerUsername,
    members: conversation.memberUsernames,
    joined: conversation.memberUserIds.includes(authUser.id),
    isOwner: conversation.ownerUserId === authUser.id,
    createdAt: conversation.createdAt,
  };
}

function toPublicUser(user: UserDoc): {
  id: string;
  email: string;
  username: string;
  initials: string;
  createdAt: number;
  walletPubkey?: string;
} {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    initials: toInitials(user.username),
    createdAt: user.createdAt,
    walletPubkey: user.walletPubkey,
  };
}

function readBearerToken(req: http.IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (!value || typeof value !== "string") return null;
  if (!value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

async function getAuthenticatedUser(req: http.IncomingMessage): Promise<UserDoc | null> {
  const token = readBearerToken(req);
  if (!token) return null;
  const payload = verifyAuthToken(token);
  if (!payload) return null;
  const col = await users();
  if (!col) return null;
  const user = await col.findOne({ id: payload.uid });
  return user;
}

function isGroupMember(group: GroupDoc, username: string): boolean {
  return Array.isArray(group.memberUsernames) && group.memberUsernames.some(
    (member) => member.toLowerCase() === username.toLowerCase(),
  );
}

// Constant-time check of the operator bearer token. Both sides are hashed first so
// timingSafeEqual sees equal-length buffers and the token length is not leaked.
function isOperatorRequest(req: http.IncomingMessage): boolean {
  if (!OPERATOR_TOKEN) return false;
  const token = readBearerToken(req);
  if (!token) return false;
  const provided = crypto.createHash("sha256").update(token).digest();
  const expected = crypto.createHash("sha256").update(OPERATOR_TOKEN).digest();
  return crypto.timingSafeEqual(provided, expected);
}

// A witness must belong to the bet's context: the web group (directly or via the
// legacy message link), the iMessage conversation, or the Discord conversation.
async function isBetContextMember(authUser: UserDoc, bet: BetDoc): Promise<boolean> {
  if (bet.source === "imessage") {
    if (!bet.imessageConversationId) return false;
    const col = await imessageConversations();
    const conversation = await col?.findOne(
      { id: bet.imessageConversationId },
      { projection: { memberUserIds: 1 } },
    );
    return Array.isArray(conversation?.memberUserIds) && conversation.memberUserIds.includes(authUser.id);
  }
  if (bet.source === "discord") {
    if (!bet.discordConversationId) return false;
    const col = await discordConversations();
    const conversation = await col?.findOne(
      { id: bet.discordConversationId },
      { projection: { memberUserIds: 1 } },
    );
    return Array.isArray(conversation?.memberUserIds) && conversation.memberUserIds.includes(authUser.id);
  }
  const groupsCol = await groups();
  const messagesCol = await messages();
  if (!groupsCol || !messagesCol) return false;
  const groupId = bet.groupId
    ?? (await messagesCol.findOne({ betId: bet.id }, { projection: { groupId: 1 } }))?.groupId;
  if (!groupId) return false;
  const group = await groupsCol.findOne({ id: groupId }, { projection: { _id: 0 } });
  return Boolean(group && isGroupMember(group, authUser.username));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; if (body.length > 16_384) req.destroy(new Error("too large")); });
    req.on("end",  () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin":  "*",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(body));
}

function dbUnconfigured(res: http.ServerResponse): void {
  json(res, 503, { error: "MongoDB not configured. Set MONGODB_URI to enable this route." });
}

function explorerUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

type AuthorizedBetLookup =
  | { status: 200; bet: BetDoc; group: GroupDoc }
  | { status: number; error: string };

async function loadAuthorizedBetForUser(authUser: UserDoc, rawBetId: string): Promise<AuthorizedBetLookup> {
  const betId = rawBetId.trim();
  if (!betId) return { status: 400, error: "bet id is required" };

  const betsCol = await bets();
  const groupsCol = await groups();
  const messagesCol = await messages();
  if (!betsCol || !groupsCol || !messagesCol) {
    return { status: 503, error: "MongoDB not configured. Set MONGODB_URI to enable this route." };
  }

  const existing = await betsCol.findOne({ id: betId }, { projection: { _id: 0 } });
  if (!existing) return { status: 404, error: "bet not found" };
  const normalized = normalizeBetDoc(existing);
  if (normalized.source === "imessage") {
    return {
      status: 200,
      bet: normalized,
      group: {
        id: "imessage",
        name: "iMessage conversation",
        initials: "IM",
        members: 2,
        pendingBet: normalized.status === "PENDING",
        lastMsg: normalized.terms,
        time: "",
      },
    };
  }
  if (normalized.source === "discord") {
    return {
      status: 200,
      bet: normalized,
      group: {
        id: "discord",
        name: "Discord channel",
        initials: "DC",
        members: 2,
        pendingBet: normalized.status === "PENDING",
        lastMsg: normalized.terms,
        time: "",
      },
    };
  }

  const linkedMessage = existing.groupId
    ? null
    : await messagesCol.findOne({ betId }, { projection: { groupId: 1 } });
  const groupId = existing.groupId ?? linkedMessage?.groupId;
  if (!groupId) return { status: 422, error: "bet is not linked to a group" };

  const group = await groupsCol.findOne({ id: groupId }, { projection: { _id: 0 } });
  if (!group) return { status: 404, error: "group not found" };
  const isPublicWitnessVote = normalized.status === "ACTIVE" && normalized.validation !== "sports";
  if (!isPublicWitnessVote && !isGroupMember(group, authUser.username)) {
    return { status: 403, error: "group membership required" };
  }

  return { status: 200, bet: { ...normalized, groupId }, group };
}

function toIMessageBetCard(viewerUsername: string, bet: BetDoc, group: GroupDoc): Record<string, unknown> {
  const normalized = normalizeBetDoc(bet);
  const status = getBetPresentationStatus(normalized);
  const votesByVoter = normalized.votesByVoter ?? {};
  const votes = countBetVotes(votesByVoter);
  const witnessThreshold = Math.max(1, Number(normalized.witnesses) || 1);
  const winner = getBetResolvedWinner(normalized) ?? null;
  const winnerName = winner === "challenger"
    ? normalized.challenger
    : winner === "acceptor"
      ? normalized.acceptor
      : null;
  const isSports = normalized.validation === "sports";
  const viewerLower = viewerUsername.toLowerCase();
  const isParticipant = [
    normalized.challenger,
    normalized.acceptor,
    normalized.acceptedBy,
    normalized.opponentUsername,
  ].some((name) => (
    typeof name === "string"
    && name.trim().toLowerCase() === viewerLower
  ));
  const canAccept = status === "pending"
    && !isWitnessOfferExpired(normalized, Date.now())
    && normalized.challenger.toLowerCase() !== viewerLower
    && (
      normalized.acceptor.toLowerCase() === viewerLower
      || normalized.acceptor.toLowerCase() === "anyone"
    );
  const canVote = !isSports
    && !isParticipant
    && status === "active"
    && !winner
    && !(normalized.onChain && normalized.currency === "SOL" && normalized.onChainState !== "locked");
  const isPointsBet = normalized.currency === "PTS";

  return {
    betId: normalized.id,
    group: {
      id: group.id,
      name: group.name,
    },
    type: normalized.type,
    status,
    statusLabel: status.toUpperCase(),
    terms: normalized.terms,
    stake: {
      amount: normalized.stake,
      currency: normalized.currency,
    },
    challenger: normalized.challenger,
    acceptor: normalized.acceptor,
    witnessesRequired: witnessThreshold,
    votes: {
      challenger: votes.challenger,
      acceptor: votes.acceptor,
      total: votes.total,
      byVoter: votesByVoter,
      myVote: votesByVoter[viewerUsername] ?? null,
    },
    winner,
    winnerName,
    outcomeLabel: normalized.offerExpired
      ? "Offer expired — never accepted"
      : fallbackLabel(points.asFallbackLabelDoc(normalized)),
    points: isPointsBet ? {
      state: normalized.pointsState ?? null,
      label: points.pointsStateLabel(normalized),
      settlement: normalized.pointsSettlement ?? null,
    } : null,
    validation: isSports ? "sports" : "witness",
    sports: isSports ? {
      sport: normalized.sport ?? null,
      gameId: normalized.espnGameId ?? null,
      homeTeam: normalized.homeTeam ?? null,
      awayTeam: normalized.awayTeam ?? null,
      challengerBacksHome: normalized.challengerBacksHome ?? null,
    } : null,
    onChain: {
      enabled: Boolean(normalized.onChain),
      state: normalized.onChainState ?? null,
      label: isPointsBet
        ? fallbackLabel(points.asFallbackLabelDoc(normalized))?.toUpperCase() ?? points.pointsStateLabel(normalized)
        : getOnChainStateLabel(normalized.onChainState, normalized),
      signatures: {
        create: normalized.createSig ?? null,
        accept: normalized.acceptSig ?? null,
        settle: normalized.settleSig ?? null,
      },
      explorer: {
        create: normalized.createSig ? explorerUrl(normalized.createSig) : null,
        accept: normalized.acceptSig ? explorerUrl(normalized.acceptSig) : null,
        settle: normalized.settleSig ? explorerUrl(normalized.settleSig) : null,
      },
    },
    actions: {
      canAccept,
      canVote,
      acceptEndpoint: "/bets/accept",
      voteEndpoint: "/bets/vote",
    },
    links: {
      deepLink: buildIMessageBetDeepLink(normalized.id),
    },
  };
}

function parseIMessageBetDeepLink(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const url = new URL(trimmed, "https://imessage.local");
    const fromQuery = url.searchParams.get("betId");
    if (fromQuery && fromQuery.trim()) return fromQuery.trim();

    if (url.protocol === "accountabilibuddy:" && url.hostname === "bet") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? decodeURIComponent(id) : null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => part === "bet" || part === "bets");
    if (marker !== -1 && parts[marker + 1]) {
      return decodeURIComponent(parts[marker + 1]);
    }
    return null;
  } catch {
    return null;
  }
}

function decodeProfilePathId(url: string): string {
  return decodeURIComponent(url.slice("/profiles/".length).split("?")[0] ?? "");
}

function decodeIMessageBetPathId(url: string): string | null {
  const path = url.split("?")[0] ?? "";
  const match = /^\/imessage\/bets\/([^/]+)$/.exec(path);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function decodeIMessageConversationPath(url: string): { id: string; join: boolean } | null {
  const path = url.split("?")[0] ?? "";
  const match = /^\/imessage\/conversations\/([^/]+)(\/join)?$/.exec(path);
  if (!match?.[1]) return null;
  return { id: decodeURIComponent(match[1]), join: Boolean(match[2]) };
}

function decodeGroupMembersPathId(url: string): string | null {
  const path = url.split("?")[0] ?? "";
  const match = /^\/groups\/([^/]+)\/members$/.exec(path);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function decodeGroupLeavePathId(url: string): string | null {
  const path = url.split("?")[0] ?? "";
  const match = /^\/groups\/([^/]+)\/leave$/.exec(path);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function toInitials(input: unknown): string {
  if (typeof input !== "string") return "NA";
  const trimmed = input.trim();
  if (!trimmed) return "NA";
  const fromWords = trimmed
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  if (fromWords.length >= 2) return fromWords;
  return trimmed.slice(0, 2).toUpperCase();
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function decodeDiscordBetPathId(url: string): string | null {
  const path = url.split("?")[0] ?? "";
  const match = /^\/discord\/bets\/([^/]+)$/.exec(path);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function decodeDiscordConversationChannelId(url: string): string | null {
  const path = url.split("?")[0] ?? "";
  const match = /^\/discord\/conversations\/([^/]+)$/.exec(path);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}
