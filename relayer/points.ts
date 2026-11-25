// relayer/points.ts
//
// Points mode: play-money balances and an off-chain escrow for PTS bets.
//
// Points have NO cash value. There is no purchase path, no transfer endpoint, no
// withdrawal, and no conversion to or from SOL anywhere in the relayer. The only
// ways points enter the system are the signup grant and the daily top-up; the only
// ways they move are bet holds, payouts, refunds and burns.
//
// Storage (MongoDB, created lazily):
//   pointsBalances  one doc per user: cached `balance` + `pendingOps` (see below)
//   pointsLedger    append-only entries keyed by a unique idempotency `key`
//
// Guarantees (no multi-document transactions needed, so this also runs against a
// standalone mongod):
//   * No negative balance: debits are a single conditional
//     updateOne({ userId, balance: { $gte: amount } }, { $inc: { balance: -amount } }).
//   * Idempotency: every movement has a deterministic key (pointsKeys in
//     points-logic.ts). The ledger insert claims the key (unique index), and the
//     balance $inc is conditioned on the key NOT being in the balance doc's
//     `pendingOps`, adding it in the same atomic write. So a key can change a
//     balance at most once even if two cranks race or a request is retried. Once
//     the ledger entry is marked applied the key is pulled from `pendingOps`.
//   * Crash recovery: a pending ledger entry whose key is in `pendingOps` was
//     applied (finish it); one whose key is absent never touched the balance
//     (the sweep deletes it so the owner can retry with the same key).
//   * Bet escrow decisions are recorded on the bet doc with conditional writes
//     (accept claim, settlement decision) before money moves, and a failed second
//     hold is compensated by an idempotent release.
//
// Env vars:
//   POINTS_SIGNUP_GRANT               points granted once per user (default 1000)
//   POINTS_TOPUP_FLOOR                daily top-up refills a balance below this up to it (default 100; 0 disables)
//   POINTS_SPORTS_RESULT_TIMEOUT_HOURS refund a held points sports bet with no final
//                                     result this long after settle time (default 168)
//   POINTS_STALE_MS                   age after which an in-flight op/claim is treated
//                                     as crashed and recovered by the crank (default 120000)
//   BET_CURRENCIES                    see points-logic.ts / relayer/index.ts header

import crypto from "crypto";
import type { Collection } from "mongodb";

import { bets, getDb, users, type BetDoc, type UserDoc } from "./db";
import {
  finalPointsState,
  parseBetCurrencies,
  parsePointsStake,
  planPointsSettlement,
  pointsCrankAction,
  pointsKeys,
  sportsPointsOutcome,
  topupAmount,
  utcDayKey,
  SPORTS_CREATE_ATTEMPT,
  type BetCurrency,
  type PointsOutcome,
  type PointsParty,
} from "./points-logic";

export * from "./points-logic";

// ── config ────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const POINTS_SIGNUP_GRANT = envInt("POINTS_SIGNUP_GRANT", 1_000);
export const POINTS_TOPUP_FLOOR = envInt("POINTS_TOPUP_FLOOR", 100);
const POINTS_SPORTS_RESULT_TIMEOUT_MS = envInt("POINTS_SPORTS_RESULT_TIMEOUT_HOURS", 168) * 60 * 60 * 1000;
const POINTS_STALE_MS = envInt("POINTS_STALE_MS", 120_000);

/** Currencies POST /bets accepts; the first is the default when a client omits it. */
export const BET_CURRENCIES: BetCurrency[] = parseBetCurrencies(process.env.BET_CURRENCIES);
export const DEFAULT_BET_CURRENCY: BetCurrency = BET_CURRENCIES[0] ?? "PTS";
export const SOL_BETS_ENABLED = BET_CURRENCIES.includes("SOL");

// ── documents ─────────────────────────────────────────────────────────────────

export type PointsLedgerKind = "grant" | "topup" | "hold" | "payout" | "refund" | "burn";

export interface PointsBalanceDoc {
  userId: string;
  username: string;
  usernameLower: string;
  /** Spendable points. Never negative. */
  balance: number;
  /** Keys whose $inc landed but whose ledger entry is not yet marked applied. */
  pendingOps: string[];
  signupGranted: boolean;
  createdAt: number;
  /** Last balance movement (unix ms). */
  updatedAt?: number;
}

export interface PointsLedgerDoc {
  /** Idempotency key (unique). */
  key: string;
  userId: string;
  username: string;
  kind: PointsLedgerKind;
  /** Signed change to the balance (hold < 0, payout/refund/grant/topup > 0, burn = 0). */
  delta: number;
  /** Points involved (stake, pot, grant size). */
  amount: number;
  reason: string;
  betId?: string;
  state: "pending" | "applied";
  createdAt: number;
  appliedAt?: number;
}

export type PointsOpInput = Omit<PointsLedgerDoc, "state" | "createdAt" | "appliedAt">;

type Cols = { balances: Collection<PointsBalanceDoc>; ledger: Collection<PointsLedgerDoc> };

let indexesReady: Promise<void> | null = null;

async function cols(): Promise<Cols> {
  const db = await getDb();
  if (!db) throw new Error("database unavailable");
  const balances = db.collection<PointsBalanceDoc>("pointsBalances");
  const ledger = db.collection<PointsLedgerDoc>("pointsLedger");
  if (!indexesReady) {
    indexesReady = (async () => {
      await balances.createIndex({ userId: 1 }, { unique: true });
      await balances.createIndex({ usernameLower: 1 });
      await balances.createIndex({ pendingOps: 1 });
      await ledger.createIndex({ key: 1 }, { unique: true });
      await ledger.createIndex({ userId: 1, createdAt: -1 });
      await ledger.createIndex({ betId: 1 });
      await ledger.createIndex({ state: 1, createdAt: 1 });
    })().catch((err) => {
      indexesReady = null;
      throw err;
    });
  }
  await indexesReady;
  return { balances, ledger };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

// ── core: idempotent, never-negative balance movement ────────────────────────────

export type ApplyResult =
  | { applied: true; already: boolean }
  | { applied: false; reason: "insufficient" | "conflict" | "no-account"; balance?: number };

async function finalizeOp(c: Cols, entry: PointsOpInput & { createdAt: number }): Promise<void> {
  await c.ledger.updateOne(
    { key: entry.key },
    { $set: { ...entry, state: "applied", appliedAt: Date.now() } },
    { upsert: true },
  );
  await c.balances.updateOne({ userId: entry.userId }, { $pull: { pendingOps: entry.key } });
}

/**
 * Apply one balance movement exactly once. Debits (delta < 0) only land when the
 * balance covers them. `balanceEquals` makes the write conditional on the current
 * balance (used by the top-up, whose amount depends on it).
 */
export async function applyPointsOp(
  op: PointsOpInput,
  opts: { balanceEquals?: number } = {},
): Promise<ApplyResult> {
  if (!Number.isSafeInteger(op.delta) || !Number.isSafeInteger(op.amount) || op.amount < 0) {
    throw new Error(`invalid points op ${op.key}`);
  }
  const c = await cols();
  const now = Date.now();
  const entry = { ...op, createdAt: now };

  if (op.delta === 0) {
    // Burns don't touch a balance (the stake left at hold time); the ledger key alone dedupes.
    try {
      await c.ledger.insertOne({ ...entry, state: "applied", appliedAt: now });
      return { applied: true, already: false };
    } catch (err) {
      if (isDuplicateKey(err)) return { applied: true, already: true };
      throw err;
    }
  }

  try {
    await c.ledger.insertOne({ ...entry, state: "pending" });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const existing = await c.ledger.findOne({ key: op.key });
    if (existing?.state === "applied") return { applied: true, already: true };
    // Pending: an earlier attempt did not finish. Continue it; the pendingOps guard
    // below makes sure the balance still moves at most once.
  }

  const filter: Record<string, unknown> = { userId: op.userId, pendingOps: { $ne: op.key } };
  if (opts.balanceEquals !== undefined) filter.balance = opts.balanceEquals;
  else if (op.delta < 0) filter.balance = { $gte: -op.delta };
  const write = await c.balances.updateOne(filter, {
    $inc: { balance: op.delta },
    $addToSet: { pendingOps: op.key },
    $set: { updatedAt: now },
  });
  if (write.modifiedCount === 1) {
    await finalizeOp(c, entry);
    return { applied: true, already: false };
  }

  // Not applied by us. Either someone else applied this key, or the condition failed.
  const bal = await c.balances.findOne({ userId: op.userId });
  if (bal?.pendingOps?.includes(op.key)) {
    await finalizeOp(c, entry);
    return { applied: true, already: true };
  }
  const again = await c.ledger.findOne({ key: op.key });
  if (again?.state === "applied") return { applied: true, already: true };
  await c.ledger.deleteOne({ key: op.key, state: "pending" });
  return {
    applied: false,
    reason: !bal ? "no-account" : opts.balanceEquals !== undefined ? "conflict" : "insufficient",
    balance: bal?.balance,
  };
}

/** True when the op with this key has changed (or is changing) the user's balance. */
async function isOpApplied(c: Cols, key: string, userId: string): Promise<boolean> {
  const entry = await c.ledger.findOne({ key }, { projection: { state: 1 } });
  if (entry?.state === "applied") return true;
  const bal = await c.balances.findOne({ userId, pendingOps: key }, { projection: { _id: 1 } });
  return Boolean(bal);
}

// ── accounts, grants, top-ups ─────────────────────────────────────────────────

type PointsUser = Pick<UserDoc, "id" | "username">;

/** Create the user's points account on first access and apply the one-time signup grant. */
export async function ensurePointsAccount(user: PointsUser): Promise<PointsBalanceDoc> {
  const c = await cols();
  const insert: PointsBalanceDoc = {
    userId: user.id,
    username: user.username,
    usernameLower: user.username.toLowerCase(),
    balance: 0,
    pendingOps: [],
    signupGranted: false,
    createdAt: Date.now(),
  };
  try {
    await c.balances.updateOne({ userId: user.id }, { $setOnInsert: insert }, { upsert: true });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err; // concurrent first access; the other upsert won
  }
  let acct = await c.balances.findOne({ userId: user.id }, { projection: { _id: 0 } });
  if (!acct) throw new Error("points account missing after upsert");
  if (!acct.signupGranted) {
    if (POINTS_SIGNUP_GRANT > 0) {
      const r = await applyPointsOp({
        key: pointsKeys.signupGrant(user.id),
        userId: user.id,
        username: user.username,
        kind: "grant",
        delta: POINTS_SIGNUP_GRANT,
        amount: POINTS_SIGNUP_GRANT,
        reason: "welcome grant",
      });
      if (!r.applied) throw new Error(`signup grant failed for ${user.username}`);
    }
    await c.balances.updateOne({ userId: user.id }, { $set: { signupGranted: true } });
    acct = await c.balances.findOne({ userId: user.id }, { projection: { _id: 0 } });
    if (!acct) throw new Error("points account missing after grant");
  }
  return acct;
}

export async function getPointsBalance(user: PointsUser): Promise<number> {
  return (await ensurePointsAccount(user)).balance;
}

export interface PointsTopupStatus {
  floor: number;
  claimable: boolean;
  /** Points a claim right now would add (0 when not claimable). */
  amount: number;
  claimedToday: boolean;
  /** Unix ms of the next UTC midnight (when a new claim period starts). */
  resetsAt: number;
}

function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

async function topupStatus(c: Cols, user: PointsUser, balance: number, now: number): Promise<PointsTopupStatus> {
  const key = pointsKeys.topup(user.id, utcDayKey(now));
  const claimedToday = Boolean(await c.ledger.findOne({ key, state: "applied" }, { projection: { _id: 1 } }));
  const amount = topupAmount(balance, POINTS_TOPUP_FLOOR, claimedToday);
  return { floor: POINTS_TOPUP_FLOOR, claimable: amount > 0, amount, claimedToday, resetsAt: nextUtcMidnight(now) };
}

export interface PointsLedgerEntryView {
  key: string;
  kind: PointsLedgerKind;
  delta: number;
  amount: number;
  reason: string;
  betId: string | null;
  createdAt: number;
}

export interface PointsSummary {
  currency: "PTS";
  balance: number;
  /** Points currently held in this user's open/active bets (not spendable). */
  held: number;
  topup: PointsTopupStatus;
  signupGrant: number;
  ledger: PointsLedgerEntryView[];
  betCurrencies: { allowed: BetCurrency[]; default: BetCurrency };
}

/** GET /points payload: balance, held stakes, top-up status and recent ledger entries. */
export async function getPointsSummary(user: PointsUser, limit = 25): Promise<PointsSummary> {
  const c = await cols();
  const acct = await ensurePointsAccount(user);
  const now = Date.now();
  const [entries, held, topup] = await Promise.all([
    c.ledger
      .find({ userId: user.id, state: "applied" }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(200, limit)))
      .toArray(),
    heldPointsFor(user),
    topupStatus(c, user, acct.balance, now),
  ]);
  return {
    currency: "PTS",
    balance: acct.balance,
    held,
    topup,
    signupGrant: POINTS_SIGNUP_GRANT,
    ledger: entries.map((e) => ({
      key: e.key,
      kind: e.kind,
      delta: e.delta,
      amount: e.amount,
      reason: e.reason,
      betId: e.betId ?? null,
      createdAt: e.createdAt,
    })),
    betCurrencies: { allowed: [...BET_CURRENCIES], default: DEFAULT_BET_CURRENCY },
  };
}

async function heldPointsFor(user: PointsUser): Promise<number> {
  const betsCol = await bets();
  if (!betsCol) return 0;
  const docs = await betsCol
    .find(
      {
        currency: "PTS",
        pointsState: { $in: ["open", "held"] },
        $or: [{ pointsChallengerId: user.id }, { pointsAcceptorId: user.id }],
      },
      { projection: { _id: 0, stake: 1 } },
    )
    .toArray();
  return docs.reduce((sum, d) => {
    const parsed = parsePointsStake(d.stake);
    return sum + ("stake" in parsed ? parsed.stake : 0);
  }, 0);
}

export type PointsRouteResult = { status: number; body: Record<string, unknown> };

/** POST /points/topup: refill a balance below the floor up to it, once per UTC day. */
export async function claimPointsTopup(user: PointsUser): Promise<PointsRouteResult> {
  const c = await cols();
  const acct = await ensurePointsAccount(user);
  const now = Date.now();
  const status = await topupStatus(c, user, acct.balance, now);
  if (!status.claimable) {
    return {
      status: 409,
      body: {
        error: status.claimedToday
          ? "you already claimed today's top-up"
          : `top-ups are only available when your balance is below ${POINTS_TOPUP_FLOOR} points`,
        points: await getPointsSummary(user),
      },
    };
  }
  const r = await applyPointsOp(
    {
      key: pointsKeys.topup(user.id, utcDayKey(now)),
      userId: user.id,
      username: user.username,
      kind: "topup",
      delta: status.amount,
      amount: status.amount,
      reason: `daily top-up to ${POINTS_TOPUP_FLOOR}`,
    },
    { balanceEquals: acct.balance },
  );
  if (!r.applied) {
    return { status: 409, body: { error: "your balance changed; try again", points: await getPointsSummary(user) } };
  }
  if (r.already) {
    return { status: 409, body: { error: "you already claimed today's top-up", points: await getPointsSummary(user) } };
  }
  return { status: 200, body: { claimed: status.amount, points: await getPointsSummary(user) } };
}

/** Balances by lowercase username (for the points leaderboard). */
export async function pointsBalancesByUsername(): Promise<Map<string, number>> {
  const c = await cols();
  const docs = await c.balances.find({}, { projection: { _id: 0, usernameLower: 1, balance: 1 } }).toArray();
  return new Map(docs.map((d) => [d.usernameLower, d.balance]));
}

/**
 * Re-rank leaderboard players by points balance. Real users who have never touched
 * points are shown with the signup grant they will receive on first access.
 */
export async function rankPlayersByPoints<P extends { github: string; name: string; wins: number; rank: number }>(
  players: P[],
  userDocs: Pick<UserDoc, "usernameLower">[],
): Promise<Array<P & { points: number }>> {
  const balances = await pointsBalancesByUsername();
  const userSet = new Set(userDocs.map((u) => u.usernameLower));
  return players
    .map((p) => {
      const key = p.github.toLowerCase();
      const points = balances.get(key) ?? (userSet.has(key) ? POINTS_SIGNUP_GRANT : 0);
      return { ...p, points };
    })
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

// ── bet escrow ────────────────────────────────────────────────────────────────

type BetsCol = NonNullable<Awaited<ReturnType<typeof bets>>>;

async function betsColOrThrow(): Promise<BetsCol> {
  const col = await bets();
  if (!col) throw new Error("database unavailable");
  return col;
}

function stakeOf(bet: Pick<BetDoc, "stake" | "id">): number {
  const parsed = parsePointsStake(bet.stake);
  if ("error" in parsed) throw new Error(`bet ${bet.id} has an invalid points stake "${bet.stake}"`);
  return parsed.stake;
}

function holdOp(bet: BetDoc, attempt: string, user: PointsUser, stake: number): PointsOpInput {
  return {
    key: pointsKeys.hold(bet.id, attempt, user.id),
    userId: user.id,
    username: user.username,
    kind: "hold",
    delta: -stake,
    amount: stake,
    reason: `stake for bet ${bet.id}`,
    betId: bet.id,
  };
}

/** Undo a hold (only if it actually landed). Idempotent via the release key. */
async function releaseHoldIfApplied(
  c: Cols,
  betId: string,
  attempt: string,
  user: PointsUser,
  stake: number,
  reason: string,
): Promise<void> {
  if (!(await isOpApplied(c, pointsKeys.hold(betId, attempt, user.id), user.id))) return;
  await ensurePointsAccount(user);
  const r = await applyPointsOp({
    key: pointsKeys.release(betId, attempt, user.id),
    userId: user.id,
    username: user.username,
    kind: "refund",
    delta: stake,
    amount: stake,
    reason,
    betId,
  });
  if (!r.applied) throw new Error(`failed to release hold ${betId}/${attempt}/${user.username}`);
}

function insufficientMessage(who: string, stake: number, balance: number | undefined): string {
  return `${who} needs ${stake} points but has ${balance ?? 0}`;
}

/**
 * POST /bets precheck for a points bet: validates the stake, rejects charity
 * fallbacks, and checks the challenger can currently cover the stake (witness bets
 * hold nothing until acceptance; sports bets hold at creation).
 */
export async function precheckPointsBet(
  user: PointsUser,
  input: { stake: unknown; fallbackKind?: unknown },
): Promise<{ ok: true; stake: number } | { ok: false; status: number; error: string }> {
  const parsed = parsePointsStake(input.stake);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  if (input.fallbackKind === "charity") {
    return {
      ok: false,
      status: 400,
      error: "points have no cash value, so a charity fallback isn't available; use return or burn",
    };
  }
  const balance = await getPointsBalance(user);
  if (balance < parsed.stake) {
    return { ok: false, status: 400, error: insufficientMessage("you", parsed.stake, balance) };
  }
  return { ok: true, stake: parsed.stake };
}

/**
 * Sports points bet: hold the challenger's stake right after the bet doc is inserted.
 * On failure the caller deletes the bet doc. Records startTime/settleAfter (unix
 * seconds) so the crank can refund at kickoff and settle after the game.
 */
export async function holdPointsForSportsCreate(
  betDoc: BetDoc,
  user: PointsUser,
  startTime: number,
  settleAfter: number,
): Promise<{ ok: true; fields: Partial<BetDoc> } | { ok: false; status: number; error: string }> {
  const betsCol = await betsColOrThrow();
  const stake = stakeOf(betDoc);
  await ensurePointsAccount(user);
  const r = await applyPointsOp(holdOp(betDoc, SPORTS_CREATE_ATTEMPT, user, stake));
  if (!r.applied) {
    return { ok: false, status: 400, error: insufficientMessage("you", stake, "balance" in r ? r.balance : 0) };
  }
  const fields: Partial<BetDoc> = {
    onChain: false,
    pointsState: "open",
    pointsChallengerId: user.id,
    startTime,
    settleAfter,
  };
  const write = await betsCol.updateOne({ id: betDoc.id, pointsState: { $exists: false } }, { $set: fields });
  if (write.matchedCount === 0) {
    // Bet vanished or was already marked: give the stake back.
    const c = await cols();
    await releaseHoldIfApplied(c, betDoc.id, SPORTS_CREATE_ATTEMPT, user, stake, `bet ${betDoc.id} creation failed`);
    return { ok: false, status: 409, error: "bet could not be opened; your points were returned" };
  }
  return { ok: true, fields };
}

/**
 * POST /bets/accept for a points bet (caller already checked status, expiry,
 * membership and addressing). Witness bets hold both stakes here (acceptor first,
 * then challenger; a failed second hold releases the first). Sports bets hold the
 * acceptor's stake and must be accepted before kickoff.
 */
export async function acceptPointsBet(
  bet: BetDoc,
  acceptor: PointsUser,
  update: Partial<BetDoc>,
): Promise<PointsRouteResult> {
  const betsCol = await betsColOrThrow();
  const usersCol = await users();
  if (!usersCol) throw new Error("database unavailable");
  const c = await cols();
  const stake = stakeOf(bet);
  const isSports = bet.validation === "sports";
  const nowMs = Date.now();

  if (isSports) {
    if (bet.pointsState !== "open" || !bet.pointsChallengerId) {
      return { status: 409, body: { error: "this sports bet is no longer open for acceptance", bet } };
    }
    if (typeof bet.startTime !== "number" || nowMs >= bet.startTime * 1000) {
      return { status: 409, body: { error: "this game has already kicked off", bet } };
    }
  } else if (bet.pointsState) {
    return { status: 409, body: { error: "bet is no longer open for acceptance", bet } };
  }

  let challenger: PointsUser;
  if (isSports) {
    challenger = { id: bet.pointsChallengerId!, username: bet.challenger };
  } else {
    const challengerUser = await usersCol.findOne(
      { usernameLower: bet.challenger.toLowerCase() },
      { projection: { _id: 0, id: 1, username: 1 } },
    );
    if (!challengerUser) return { status: 409, body: { error: "challenger account not found" } };
    challenger = challengerUser;
  }

  // Claim the bet so a concurrent accept can't hold a second set of stakes.
  const attempt = crypto.randomBytes(6).toString("hex");
  const claim = await betsCol.updateOne(
    {
      id: bet.id,
      currency: "PTS",
      status: "PENDING",
      pointsAcceptClaim: { $exists: false },
      ...(isSports ? { pointsState: "open" } : { pointsState: { $exists: false } }),
    },
    { $set: { pointsAcceptClaim: { attempt, userId: acceptor.id, username: acceptor.username, at: nowMs } } },
  );
  if (claim.modifiedCount === 0) {
    const latest = await betsCol.findOne({ id: bet.id }, { projection: { _id: 0 } });
    return {
      status: 409,
      body: { error: "someone else is accepting this bet, or it is no longer open", ...(latest ? { bet: latest } : {}) },
    };
  }
  const releaseClaim = () =>
    betsCol.updateOne({ id: bet.id, "pointsAcceptClaim.attempt": attempt }, { $unset: { pointsAcceptClaim: "" } });
  const undo = async (reason: string) => {
    await releaseHoldIfApplied(c, bet.id, attempt, acceptor, stake, reason);
    if (!isSports) await releaseHoldIfApplied(c, bet.id, attempt, challenger, stake, reason);
    await releaseClaim();
  };

  try {
    await ensurePointsAccount(acceptor);
    const a = await applyPointsOp(holdOp(bet, attempt, acceptor, stake));
    if (!a.applied) {
      await releaseClaim();
      return { status: 400, body: { error: insufficientMessage("you", stake, "balance" in a ? a.balance : 0) } };
    }
    if (!isSports) {
      await ensurePointsAccount(challenger);
      const ch = await applyPointsOp(holdOp(bet, attempt, challenger, stake));
      if (!ch.applied) {
        await undo(`accept of bet ${bet.id} failed: challenger short on points`);
        return {
          status: 409,
          body: {
            error: `${bet.challenger} no longer has enough points to cover this bet (${stake} needed); your points were returned`,
          },
        };
      }
    }

    const write = await betsCol.updateOne(
      { id: bet.id, status: "PENDING", "pointsAcceptClaim.attempt": attempt },
      {
        $set: {
          ...update,
          onChain: false,
          pointsState: "held",
          pointsChallengerId: challenger.id,
          pointsAcceptorId: acceptor.id,
          pointsHoldAttempt: attempt,
        },
        $unset: { pointsAcceptClaim: "", offerExpired: "" },
      },
    );
    if (write.modifiedCount === 0) {
      // Offer expired or the claim was recovered as stale while we were holding.
      await undo(`accept of bet ${bet.id} abandoned`);
      const latest = await betsCol.findOne({ id: bet.id }, { projection: { _id: 0 } });
      return {
        status: 409,
        body: { error: "this bet closed before your acceptance was recorded; your points were returned", ...(latest ? { bet: latest } : {}) },
      };
    }
  } catch (err) {
    await undo(`accept of bet ${bet.id} errored`).catch((undoErr) =>
      console.error(`points accept compensation failed for ${bet.id} (crank will retry):`, undoErr),
    );
    throw err;
  }

  const updated = await betsCol.findOne({ id: bet.id }, { projection: { _id: 0 } });
  return { status: 200, body: { bet: updated ?? { ...bet, ...update } } };
}

export type SettlePointsResult =
  | { ok: true; already: boolean; state: NonNullable<BetDoc["pointsState"]>; outcome: PointsOutcome }
  | { ok: false; reason: string };

/**
 * Pay out / refund / burn a points bet. Idempotent: the first caller records the
 * decision on the bet (conditionally), every caller applies the same ledger keys,
 * so calling it twice — or racing two cranks — moves points exactly once. If a
 * different outcome was already recorded, that one wins and is (re)applied.
 *
 * Other modules (sports crank, proof/check-in flows) should normally just set
 * `resolvedWinner` and let crankPointsBets() call this; call it directly only
 * when you already know the final outcome (e.g. a sports result).
 */
export async function settlePointsBet(betOrId: BetDoc | string, outcome: PointsOutcome): Promise<SettlePointsResult> {
  const betsCol = await betsColOrThrow();
  const betId = typeof betOrId === "string" ? betOrId : betOrId.id;
  let doc = await betsCol.findOne({ id: betId }, { projection: { _id: 0 } });
  if (!doc) return { ok: false, reason: "bet not found" };
  if (doc.currency !== "PTS") return { ok: false, reason: "not a points bet" };
  if (doc.pointsState === "settled" || doc.pointsState === "refunded" || doc.pointsState === "burned") {
    return { ok: true, already: true, state: doc.pointsState, outcome: doc.pointsSettlement ?? outcome };
  }
  if (doc.pointsState !== "open" && doc.pointsState !== "held") return { ok: false, reason: "no points are held" };
  if (!doc.pointsSettlement) {
    if (outcome.type === "winner" && doc.pointsState !== "held") {
      return { ok: false, reason: "cannot pay a winner before both stakes are held" };
    }
    await betsCol.updateOne(
      { id: betId, pointsState: doc.pointsState, pointsSettlement: { $exists: false } },
      { $set: { pointsSettlement: outcome } },
    );
    doc = await betsCol.findOne({ id: betId }, { projection: { _id: 0 } });
    if (!doc) return { ok: false, reason: "bet not found" };
  }
  const decided = doc.pointsSettlement;
  if (!decided) return { ok: false, reason: "settlement decision missing" };
  if (doc.pointsState !== "open" && doc.pointsState !== "held") {
    return { ok: true, already: true, state: doc.pointsState ?? "settled", outcome: decided };
  }
  if (!doc.pointsChallengerId) return { ok: false, reason: "bet has no recorded challenger" };

  const stake = stakeOf(doc);
  const challenger: PointsParty = { userId: doc.pointsChallengerId, username: doc.challenger };
  const acceptor: PointsParty | null =
    doc.pointsState === "held" && doc.pointsAcceptorId
      ? { userId: doc.pointsAcceptorId, username: doc.acceptedBy ?? doc.opponentUsername ?? doc.acceptor }
      : null;
  const ops = planPointsSettlement(doc.id, stake, challenger, acceptor, decided);
  let anyNew = false;
  for (const op of ops) {
    await ensurePointsAccount({ id: op.userId, username: op.username });
    const r = await applyPointsOp({ ...op, betId: doc.id });
    if (!r.applied) throw new Error(`points ${op.kind} failed for bet ${doc.id} (${op.username})`);
    if (!r.already) anyNew = true;
  }

  const state = finalPointsState(decided);
  await betsCol.updateOne(
    { id: doc.id, pointsState: { $in: ["open", "held"] } },
    {
      $set: {
        pointsState: state,
        status: "COMPLETED",
        pointsSettledAt: Date.now(),
        ...(decided.type === "winner" ? { resolvedWinner: decided.winner } : {}),
      },
    },
  );
  return { ok: true, already: !anyNew, state, outcome: decided };
}

// ── crank ─────────────────────────────────────────────────────────────────────

export type SportsResultFetcher = (bet: BetDoc) => Promise<{ homeWon: boolean | null } | null>;

export interface PointsCrankReport {
  settled: string[];
  fallbacks: string[];
  recoveredClaims: string[];
  recoveredOps: number;
  errors: Array<{ betId: string; error: string }>;
}

/**
 * Periodic points sweep (called from runPoll; never touches the chain):
 *   1. finish/discard ledger ops a crash left half-done,
 *   2. compensate accept attempts that died mid-way,
 *   3. clean up sports bets whose creation died after the doc was inserted,
 *   4. settle bets: witness quorum / fallback (via witness-fallback.ts), sports
 *      unaccepted-at-kickoff refunds and results (via `fetchSportsResult`).
 */
export async function crankPointsBets(
  opts: { fetchSportsResult?: SportsResultFetcher; nowMs?: number } = {},
): Promise<PointsCrankReport> {
  const report: PointsCrankReport = { settled: [], fallbacks: [], recoveredClaims: [], recoveredOps: 0, errors: [] };
  const betsCol = await bets();
  if (!betsCol) return report;
  const c = await cols();
  const nowMs = opts.nowMs ?? Date.now();
  const staleBefore = nowMs - POINTS_STALE_MS;

  // 1. Half-done ledger ops.
  const stalePending = await c.ledger.find({ state: "pending", createdAt: { $lt: staleBefore } }).toArray();
  for (const entry of stalePending) {
    const bal = await c.balances.findOne({ userId: entry.userId, pendingOps: entry.key }, { projection: { _id: 1 } });
    if (bal) {
      const { key, userId, username, kind, delta, amount, reason, betId, createdAt } = entry;
      await finalizeOp(c, { key, userId, username, kind, delta, amount, reason, ...(betId ? { betId } : {}), createdAt });
    } else {
      await c.ledger.deleteOne({ key: entry.key, state: "pending" });
    }
    report.recoveredOps += 1;
  }
  const withPending = await c.balances
    .find({ "pendingOps.0": { $exists: true }, updatedAt: { $lt: staleBefore } })
    .toArray();
  for (const bal of withPending) {
    for (const key of bal.pendingOps) {
      const entry = await c.ledger.findOne({ key });
      if (entry?.state === "applied") {
        await c.balances.updateOne({ userId: bal.userId }, { $pull: { pendingOps: key } });
        report.recoveredOps += 1;
      } else if (!entry) {
        console.warn(`points: balance ${bal.username} has applied op ${key} with no ledger entry (operator review)`);
      }
    }
  }

  // 2. Accept attempts that died between claim and final write.
  const staleClaims = await betsCol
    .find({ currency: "PTS", "pointsAcceptClaim.at": { $lt: staleBefore } }, { projection: { _id: 0 } })
    .toArray();
  for (const bet of staleClaims) {
    const claim = bet.pointsAcceptClaim!;
    try {
      const cleared = await betsCol.updateOne(
        { id: bet.id, "pointsAcceptClaim.attempt": claim.attempt },
        { $unset: { pointsAcceptClaim: "" } },
      );
      if (cleared.modifiedCount === 0) continue;
      const stake = stakeOf(bet);
      await releaseHoldIfApplied(c, bet.id, claim.attempt, { id: claim.userId, username: claim.username }, stake, `abandoned accept of bet ${bet.id}`);
      if (bet.validation !== "sports") {
        const challengerUser = await (await users())?.findOne(
          { usernameLower: bet.challenger.toLowerCase() },
          { projection: { _id: 0, id: 1, username: 1 } },
        );
        if (challengerUser) {
          await releaseHoldIfApplied(c, bet.id, claim.attempt, challengerUser, stake, `abandoned accept of bet ${bet.id}`);
        }
      }
      report.recoveredClaims.push(bet.id);
    } catch (err) {
      report.errors.push({ betId: bet.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. Sports points bets inserted but never marked open (creation died mid-way).
  const zombies = await betsCol
    .find(
      { currency: "PTS", validation: "sports", status: "PENDING", pointsState: { $exists: false }, createdAt: { $lt: staleBefore } },
      { projection: { _id: 0 } },
    )
    .toArray();
  for (const bet of zombies) {
    try {
      const challengerUser = await (await users())?.findOne(
        { usernameLower: bet.challenger.toLowerCase() },
        { projection: { _id: 0, id: 1, username: 1 } },
      );
      if (challengerUser) {
        await releaseHoldIfApplied(c, bet.id, SPORTS_CREATE_ATTEMPT, challengerUser, stakeOf(bet), `bet ${bet.id} creation failed`);
      }
      await betsCol.updateOne(
        { id: bet.id, pointsState: { $exists: false } },
        { $set: { status: "COMPLETED", pointsState: "refunded", offerExpired: true, pointsSettledAt: nowMs } },
      );
      report.recoveredClaims.push(bet.id);
    } catch (err) {
      report.errors.push({ betId: bet.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Unaccepted points witness offers past their deadline (mirrors crankWitnessBets,
  // but runs even when the RPC is unreachable). Nothing is held for these.
  await betsCol.updateMany(
    {
      currency: "PTS",
      status: "PENDING",
      validation: { $ne: "sports" },
      pointsState: { $exists: false },
      pointsAcceptClaim: { $exists: false },
      $or: [{ acceptByDate: { $lte: nowMs } }, { resolveByDate: { $lte: nowMs } }],
    },
    { $set: { status: "COMPLETED", offerExpired: true } },
  );

  // 4. Settlement.
  const live = await betsCol
    .find({ currency: "PTS", pointsState: { $in: ["open", "held"] } }, { projection: { _id: 0 } })
    .toArray();
  for (const bet of live) {
    try {
      const action = pointsCrankAction(bet, nowMs);
      if (action.type === "none") continue;
      let outcome: PointsOutcome | null = null;
      if (action.type === "settle") {
        outcome = action.outcome;
      } else if (action.type === "claim-fallback") {
        // Same race rule as SOL: commit the fallback only if no verdict landed first.
        const claimed = await betsCol.updateOne(
          {
            id: bet.id,
            status: "ACTIVE",
            pointsState: "held",
            resolvedWinner: { $exists: false },
            fallbackApplied: { $exists: false },
            fallbackBlocked: { $exists: false },
            pointsSettlement: { $exists: false },
          },
          {
            $set: {
              status: "COMPLETED",
              fallbackApplied: action.fallback,
              fallbackAppliedAt: nowMs,
              pointsSettlement: action.outcome,
            },
          },
        );
        if (claimed.modifiedCount === 0) continue; // lost to a vote; next tick pays the winner
        outcome = action.outcome;
        report.fallbacks.push(bet.id);
      } else if (action.type === "check-sports-result") {
        const result = opts.fetchSportsResult ? await opts.fetchSportsResult(bet) : null;
        if (result) {
          outcome = sportsPointsOutcome(bet.challengerBacksHome, result.homeWon);
        } else {
          const settleAtMs = ((bet.settleAfter ?? bet.startTime ?? 0) as number) * 1000;
          if (nowMs >= settleAtMs + POINTS_SPORTS_RESULT_TIMEOUT_MS) {
            outcome = { type: "refund", reason: "no final result from the sports feed" };
          }
        }
      }
      if (!outcome) continue;
      const r = await settlePointsBet(bet.id, outcome);
      if ("state" in r && !r.already) {
        report.settled.push(bet.id);
        console.log(`points bet ${bet.id} → ${r.state} (${r.outcome.type})`);
      } else if ("reason" in r) {
        report.errors.push({ betId: bet.id, error: r.reason });
      }
    } catch (err) {
      report.errors.push({ betId: bet.id, error: err instanceof Error ? err.message : String(err) });
      console.error(`points crank failed for bet ${bet.id}:`, err);
    }
  }
  return report;
}
