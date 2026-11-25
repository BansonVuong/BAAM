// End-to-end check for points mode. Drives the HTTP API of a running local relayer
// and, for idempotency/race cases, calls relayer/points.ts directly against the SAME
// database. Never point this at production.
//
//   # terminal 1 (throwaway DB + oracle keypair; OPERATOR_TOKEN enables /points/crank)
//   HOST=127.0.0.1 PORT=8792 OPERATOR_TOKEN=e2e-op MONGODB_URI=mongodb://127.0.0.1:27999 \
//     MONGODB_DB=baam-points-e2e ORACLE_KEYPAIR=/path/to/throwaway.json npx ts-node -T relayer/index.ts
//   # terminal 2 (same MONGODB_URI / MONGODB_DB / OPERATOR_TOKEN)
//   POINTS_E2E_URL=http://127.0.0.1:8792 OPERATOR_TOKEN=e2e-op MONGODB_URI=mongodb://127.0.0.1:27999 \
//     MONGODB_DB=baam-points-e2e npx ts-node -T relayer/points.e2e.ts
import assert from "assert";

import { bets, getDb, type BetDoc } from "./db";
import * as points from "./points";

const BASE = process.env.POINTS_E2E_URL ?? "http://127.0.0.1:8792";
const OPERATOR = process.env.OPERATOR_TOKEN ?? "";
const GRANT = points.POINTS_SIGNUP_GRANT;
const FLOOR = points.POINTS_TOPUP_FLOOR;

if (/66\.42\.115\.38|nip\.io/.test(BASE) || /accountabilibuddy$/.test(process.env.MONGODB_DB ?? "accountabilibuddy")) {
  throw new Error("refusing to run against production (set POINTS_E2E_URL and a throwaway MONGODB_DB)");
}
if (!OPERATOR) throw new Error("OPERATOR_TOKEN must match the relayer's (enables POST /points/crank)");

type Json = Record<string, any>;
type User = { id: string; username: string; token: string };

async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function ok(method: string, path: string, token?: string, body?: unknown, expect = [200, 201]): Promise<Json> {
  const r = await call(method, path, token, body);
  assert.ok(expect.includes(r.status), `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const crank = () => ok("POST", "/points/crank", OPERATOR, {});
const balance = async (u: User) => (await ok("GET", "/points", u.token)).points.balance as number;
const balances = async (...us: User[]) => Promise.all(us.map(balance));
const betDoc = async (id: string) => (await (await bets())!.findOne({ id }, { projection: { _id: 0 } })) as BetDoc;

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const run = Date.now().toString(36).slice(-5);
  const signup = async (name: string): Promise<User> => {
    const username = `${name}${run}`;
    const b = await ok("POST", "/auth/signup", undefined, {
      email: `${username}@example.test`,
      username,
      password: "password123",
    });
    return { id: b.user.id, username, token: b.token };
  };

  console.log(`points e2e against ${BASE} (run ${run})`);
  const [A, B, C, D] = await Promise.all(["al", "bo", "ca", "da"].map(signup));
  let group = "";

  const createBet = (u: User, extra: Json) =>
    call("POST", "/bets", u.token, {
      groupId: group,
      type: "PERSONAL",
      acceptor: "anyone",
      terms: "Points e2e: I will finish the thing",
      stake: "100",
      currency: "PTS",
      witnesses: 2,
      resolveByDate: Date.now() + 60 * 60 * 1000,
      ...extra,
    });

  await step("signup grants points (and only once)", async () => {
    for (const u of [A, B, C, D]) {
      const p = (await ok("GET", "/points", u.token)).points;
      assert.strictEqual(p.balance, GRANT);
      assert.strictEqual(p.ledger.filter((e: Json) => e.kind === "grant").length, 1);
      assert.strictEqual(p.topup.claimable, false);
    }
    assert.strictEqual((await balances(A, A, A)).every((b) => b === GRANT), true); // re-access: no second grant
    const me = await ok("GET", "/auth/me", A.token);
    assert.strictEqual(me.pointsBalance, GRANT);
  });

  await step("group setup", async () => {
    group = (await ok("POST", "/groups", A.token, { name: `Points ${run}` })).group.id;
    for (const u of [B, C, D]) await ok("POST", `/groups/${group}/members`, A.token, { username: u.username });
  });

  await step("validation: charity / fractional / over-balance / bad currency rejected; default is PTS", async () => {
    assert.strictEqual((await createBet(A, { fallbackKind: "charity", charityAddress: "x" })).status, 400);
    assert.strictEqual((await createBet(A, { stake: "1.5" })).status, 400);
    assert.strictEqual((await createBet(A, { stake: "0" })).status, 400);
    assert.strictEqual((await createBet(A, { stake: String(GRANT + 1) })).status, 400);
    assert.strictEqual((await createBet(A, { currency: "DOGE" })).status, 400);
    const r = await createBet(A, { currency: undefined, stake: "1" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.bet.currency, points.DEFAULT_BET_CURRENCY);
    assert.strictEqual(r.body.bet.onChain, false);
  });

  let bet1 = "";
  await step("witness bet: accept holds both stakes; two votes; crank pays the winner", async () => {
    const r = await createBet(A, {});
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    bet1 = r.body.bet.id;
    assert.deepStrictEqual(await balances(A, B), [GRANT, GRANT]); // witness bets hold nothing at creation
    const acc = await ok("POST", "/bets/accept", B.token, { betId: bet1 });
    assert.strictEqual(acc.bet.status, "ACTIVE");
    assert.strictEqual(acc.bet.pointsState, "held");
    assert.deepStrictEqual(await balances(A, B), [GRANT - 100, GRANT - 100]);
    assert.strictEqual((await ok("GET", "/points", A.token)).points.held, 100);
    // participants can't vote; witnesses can
    assert.strictEqual((await call("POST", "/bets/vote", A.token, { betId: bet1, votedFor: "challenger" })).status, 403);
    await ok("POST", "/bets/vote", C.token, { betId: bet1, votedFor: "acceptor" });
    const v = await ok("POST", "/bets/vote", D.token, { betId: bet1, votedFor: "acceptor" });
    assert.strictEqual(v.bet.resolvedWinner, "acceptor");
    await crank();
    assert.deepStrictEqual(await balances(A, B), [GRANT - 100, GRANT + 100]);
    const doc = await betDoc(bet1);
    assert.strictEqual(doc.pointsState, "settled");
    assert.strictEqual(doc.status, "COMPLETED");
    const ledgerB = (await ok("GET", "/points", B.token)).points.ledger as Json[];
    assert.deepStrictEqual(ledgerB.filter((e) => e.betId === bet1).map((e) => [e.kind, e.delta]).sort(), [["hold", -100], ["payout", 200]]);
  });

  await step("idempotency: crank + settlePointsBet repeated (even with a different outcome) never double-pays", async () => {
    await crank();
    await crank();
    const again = await points.settlePointsBet(bet1, { type: "winner", winner: "challenger" });
    assert.ok("state" in again && again.already && again.state === "settled");
    assert.deepStrictEqual((again as { outcome: unknown }).outcome, { type: "winner", winner: "acceptor" });
    await Promise.all([points.settlePointsBet(bet1, { type: "refund", reason: "x" }), crank()]);
    assert.deepStrictEqual(await balances(A, B), [GRANT - 100, GRANT + 100]);
    const db = await getDb();
    const payouts = await db!.collection("pointsLedger").countDocuments({ betId: bet1, kind: "payout" });
    assert.strictEqual(payouts, 1);
  });

  await step("iMessage card + GET /bets show PTS", async () => {
    const card = (await ok("GET", `/imessage/bets/${bet1}`, A.token)).card;
    assert.deepStrictEqual(card.stake, { amount: "100", currency: "PTS" });
    assert.strictEqual(card.points.state, "settled");
    assert.strictEqual(card.onChain.enabled, false);
    assert.match(card.onChain.label, /POINTS/);
    const list = (await ok("GET", "/bets", A.token)).bets as Json[];
    assert.strictEqual(list.find((b) => b.id === bet1)?.currency, "PTS");
  });

  await step("return fallback: no verdict by resolve-by → both refunded; voting closed", async () => {
    const r = await createBet(A, { stake: "50", resolveByDate: Date.now() + 3_000, fallbackKind: "return" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const id = r.body.bet.id;
    await ok("POST", "/bets/accept", B.token, { betId: id });
    const [a0, b0] = await balances(A, B);
    await sleep(3_500);
    assert.strictEqual((await call("POST", "/bets/vote", C.token, { betId: id, votedFor: "acceptor" })).status, 409);
    await crank();
    const doc = await betDoc(id);
    assert.strictEqual(doc.pointsState, "refunded");
    assert.strictEqual(doc.fallbackApplied, "return");
    assert.deepStrictEqual(await balances(A, B), [a0 + 50, b0 + 50]);
    await crank();
    assert.deepStrictEqual(await balances(A, B), [a0 + 50, b0 + 50]);
  });

  await step("burn fallback: stakes destroyed (burn ledger entries, no refund)", async () => {
    const r = await createBet(A, { stake: "30", resolveByDate: Date.now() + 3_000, fallbackKind: "burn" });
    const id = r.body.bet.id;
    await ok("POST", "/bets/accept", B.token, { betId: id });
    const [a0, b0] = await balances(A, B);
    await sleep(3_500);
    await crank();
    await crank();
    assert.strictEqual((await betDoc(id)).pointsState, "burned");
    assert.deepStrictEqual(await balances(A, B), [a0, b0]);
    const burns = (await ok("GET", "/points", A.token)).points.ledger.filter((e: Json) => e.betId === id && e.kind === "burn");
    assert.strictEqual(burns.length, 1);
    assert.strictEqual(burns[0].amount, 30);
  });

  let bigBet = "";
  await step("failed challenger hold releases the acceptor's hold (compensation)", async () => {
    const aBal = await balance(A); // 870
    const stake = aBal - 70;
    bigBet = (await createBet(A, { stake: String(stake) })).body.bet.id;
    const second = (await createBet(A, { stake: String(stake) })).body.bet.id; // precheck passes, A can't cover both
    await ok("POST", "/bets/accept", B.token, { betId: bigBet });
    assert.strictEqual(await balance(A), 70);
    const c0 = await balance(C);
    const r = await call("POST", "/bets/accept", C.token, { betId: second });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(await balance(C), c0);
    const ledgerC = (await ok("GET", "/points", C.token)).points.ledger.filter((e: Json) => e.betId === second);
    assert.deepStrictEqual(ledgerC.map((e: Json) => [e.kind, e.delta]).sort(), [["hold", -stake], ["refund", stake]]);
    const doc = await betDoc(second);
    assert.strictEqual(doc.status, "PENDING");
    assert.strictEqual(doc.pointsState, undefined);
    assert.strictEqual(doc.pointsAcceptClaim, undefined);
    // Acceptor short on points: plain 400, nothing moves.
    const third = (await createBet(D, { stake: "900" })).body.bet.id;
    const r2 = await call("POST", "/bets/accept", A.token, { betId: third });
    assert.strictEqual(r2.status, 400);
    assert.strictEqual(await balance(A), 70);
  });

  await step("daily top-up: below floor → refill to floor once per UTC day", async () => {
    const p = (await ok("GET", "/points", A.token)).points;
    assert.strictEqual(p.topup.claimable, FLOOR > 70);
    if (FLOOR > 70) {
      const t = await ok("POST", "/points/topup", A.token, {});
      assert.strictEqual(t.claimed, FLOOR - 70);
      assert.strictEqual(t.points.balance, FLOOR);
      assert.strictEqual((await call("POST", "/points/topup", A.token, {})).status, 409);
      assert.strictEqual(await balance(A), FLOOR);
    }
    assert.strictEqual((await call("POST", "/points/topup", B.token, {})).status, 409); // above floor
  });

  await step("concurrent accepts: exactly one acceptor is charged", async () => {
    const id = (await createBet(D, { stake: "100" })).body.bet.id;
    const [b0, c0, d0] = await balances(B, C, D);
    const results = await Promise.all([
      call("POST", "/bets/accept", B.token, { betId: id }),
      call("POST", "/bets/accept", C.token, { betId: id }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, [200, 409], JSON.stringify(results.map((r) => r.body)));
    const [b1, c1, d1] = await balances(B, C, D);
    assert.strictEqual(d1, d0 - 100);
    assert.strictEqual(b0 + c0 - (b1 + c1), 100);
  });

  await step("concurrent settlement (HTTP cranks + direct calls) pays exactly once", async () => {
    await ok("POST", "/bets/vote", C.token, { betId: bigBet, votedFor: "challenger" });
    await ok("POST", "/bets/vote", D.token, { betId: bigBet, votedFor: "challenger" });
    const doc = await betDoc(bigBet);
    const stake = Number(doc.stake);
    const a0 = await balance(A);
    await Promise.all([
      crank(),
      crank(),
      points.settlePointsBet(bigBet, { type: "winner", winner: "challenger" }),
      points.settlePointsBet(bigBet, { type: "winner", winner: "challenger" }),
      points.crankPointsBets(),
    ]);
    assert.strictEqual(await balance(A), a0 + 2 * stake);
    assert.strictEqual((await betDoc(bigBet)).pointsState, "settled");
  });

  await step("applyPointsOp: duplicate key never double-applies; debit never overdraws", async () => {
    const key = `e2e:${run}:dup`;
    const op = { key, userId: C.id, username: C.username, kind: "refund" as const, delta: 5, amount: 5, reason: "e2e" };
    const c0 = await balance(C);
    const rs = await Promise.all([points.applyPointsOp(op), points.applyPointsOp(op), points.applyPointsOp(op)]);
    assert.strictEqual(rs.filter((r) => "already" in r && !r.already).length, 1);
    assert.strictEqual(await balance(C), c0 + 5);
    const over = await points.applyPointsOp({ ...op, key: `${key}:over`, kind: "hold", delta: -(c0 + 1000), amount: c0 + 1000 });
    assert.strictEqual(over.applied, false);
    assert.strictEqual(await balance(C), c0 + 5);
    // cleanup so the conservation check below only sees real flows
    assert.ok((await points.applyPointsOp({ ...op, key: `${key}:undo`, delta: -5, kind: "hold" })).applied);
  });

  await step("sports points bet: challenger held at creation, refund if unaccepted at kickoff, result pays winner", async () => {
    const col = (await bets())!;
    const mk = async (id: string): Promise<BetDoc> => {
      const doc: BetDoc = {
        id, createdAt: Date.now(), groupId: group, type: "DEV", challenger: B.username, acceptor: "anyone",
        terms: "NBA: X @ Y — sports points e2e", stake: "40", currency: "PTS", status: "PENDING",
        witnesses: 1, minBettors: 2, groupSize: 4, validation: "sports", sport: "nba", espnGameId: "999",
        homeTeam: "Y", awayTeam: "X", challengerBacksHome: true, onChain: false,
      };
      await col.insertOne(doc);
      const nowSec = Math.floor(Date.now() / 1000);
      const h = await points.holdPointsForSportsCreate(doc, { id: B.id, username: B.username }, nowSec + 600, nowSec + 660);
      assert.ok("fields" in h);
      return (await betDoc(id))!;
    };
    const b0 = await balance(B);
    const lonely = await mk(`bet-e2e-${run}-s1`);
    const matched = await mk(`bet-e2e-${run}-s2`);
    assert.strictEqual(await balance(B), b0 - 80);
    const c0 = await balance(C);
    const acc = await points.acceptPointsBet(matched, { id: C.id, username: C.username }, { status: "ACTIVE", acceptedBy: C.username, acceptor: C.username });
    assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
    assert.strictEqual(await balance(C), c0 - 40);
    // Jump past kickoff/settle time.
    const past = Math.floor(Date.now() / 1000) - 120;
    await col.updateMany({ id: { $in: [lonely.id, matched.id] } }, { $set: { startTime: past, settleAfter: past + 60 } });
    const late = await points.acceptPointsBet(await betDoc(lonely.id), { id: D.id, username: D.username }, { status: "ACTIVE" });
    assert.strictEqual(late.status, 409); // must be accepted before kickoff
    const fetchSportsResult = async (bet: BetDoc) => (bet.id === matched.id ? { homeWon: false } : null);
    await points.crankPointsBets({ fetchSportsResult });
    await points.crankPointsBets({ fetchSportsResult });
    assert.strictEqual((await betDoc(lonely.id)).pointsState, "refunded");
    const m = await betDoc(matched.id);
    assert.strictEqual(m.pointsState, "settled");
    assert.strictEqual(m.resolvedWinner, "acceptor"); // challenger backed home; away won
    assert.strictEqual(await balance(B), b0 - 40); // lonely refunded, matched lost
    assert.strictEqual(await balance(C), c0 + 40);
  });

  await step("leaderboard ranks points separately", async () => {
    const lb = await ok("GET", "/leaderboard?currency=PTS", A.token);
    assert.strictEqual(lb.currency, "PTS");
    const ours = (lb.players as Json[]).filter((p) => p.github.endsWith(run));
    assert.strictEqual(ours.length, 4);
    for (const p of ours) assert.strictEqual(typeof p.points, "number");
    const sorted = [...(lb.players as Json[])].sort((x, y) => y.points - x.points);
    assert.deepStrictEqual((lb.players as Json[]).map((p) => p.points), sorted.map((p) => p.points));
    const sol = await ok("GET", "/leaderboard?currency=SOL", A.token);
    assert.strictEqual(sol.currency, "SOL");
    const solOurs = (sol.players as Json[]).filter((p) => p.github.endsWith(run));
    assert.ok(solOurs.every((p) => p.wins === 0)); // points wins don't count toward SOL standings
    assert.ok(ours.some((p) => p.wins > 0));
    assert.strictEqual((await call("GET", "/leaderboard?currency=BTC", A.token)).status, 400);
  });

  await step("crash recovery: stale accept claim released, half-applied op finished, orphan pending dropped", async () => {
    const db = (await getDb())!;
    const col = (await bets())!;
    // (a) accept died after holding the acceptor's stake.
    const id = (await createBet(D, { stake: "10" })).body.bet.id;
    const c0 = await balance(C);
    await col.updateOne({ id }, { $set: { pointsAcceptClaim: { attempt: "crash1", userId: C.id, username: C.username, at: Date.now() } } });
    const hold = await points.applyPointsOp({
      key: points.pointsKeys.hold(id, "crash1", C.id), userId: C.id, username: C.username,
      kind: "hold", delta: -10, amount: 10, reason: "e2e crash", betId: id,
    });
    assert.ok(hold.applied);
    // (b) $inc landed but the ledger entry was never marked applied.
    const halfKey = `e2e:${run}:half`;
    const old = Date.now() - 60 * 60 * 1000;
    await db.collection("pointsLedger").insertOne({ key: halfKey, userId: C.id, username: C.username, kind: "grant", delta: 7, amount: 7, reason: "e2e half", state: "pending", createdAt: old });
    await db.collection("pointsBalances").updateOne({ userId: C.id }, { $inc: { balance: 7 }, $addToSet: { pendingOps: halfKey }, $set: { updatedAt: old } });
    // (c) pending entry whose $inc never happened.
    const orphanKey = `e2e:${run}:orphan`;
    await db.collection("pointsLedger").insertOne({ key: orphanKey, userId: C.id, username: C.username, kind: "grant", delta: 9, amount: 9, reason: "e2e orphan", state: "pending", createdAt: old });

    const report = await points.crankPointsBets({ nowMs: Date.now() + 10 * 60 * 1000 });
    assert.ok(report.recoveredClaims.includes(id), JSON.stringify(report));
    assert.strictEqual(await balance(C), c0 + 7); // hold released, half-op kept, orphan never applied
    assert.strictEqual((await betDoc(id)).pointsAcceptClaim, undefined);
    assert.strictEqual((await db.collection("pointsLedger").findOne({ key: halfKey }))?.state, "applied");
    assert.strictEqual(await db.collection("pointsLedger").countDocuments({ key: orphanKey }), 0);
    // The released bet can be accepted normally afterwards.
    await ok("POST", "/bets/accept", C.token, { betId: id });
    assert.strictEqual(await balance(C), c0 + 7 - 10);
  });

  await step("conservation: balances == ledger sums; grants + top-ups == balances + held + burned", async () => {
    const db = (await getDb())!;
    const ids = [A, B, C, D].map((u) => u.id);
    const entries = await db.collection("pointsLedger").find({ userId: { $in: ids } }).toArray();
    assert.ok(entries.every((e) => e.state === "applied"));
    const bals = await db.collection("pointsBalances").find({ userId: { $in: ids } }).toArray();
    let total = 0;
    for (const b of bals) {
      const sum = entries.filter((e) => e.userId === b.userId).reduce((s, e) => s + e.delta, 0);
      assert.strictEqual(b.balance, sum, `balance/ledger mismatch for ${b.username}`);
      assert.deepStrictEqual(b.pendingOps, []);
      assert.ok(b.balance >= 0);
      total += b.balance;
    }
    const minted = entries.filter((e) => e.kind === "grant" || e.kind === "topup").reduce((s, e) => s + e.delta, 0);
    const burned = entries.filter((e) => e.kind === "burn").reduce((s, e) => s + e.amount, 0);
    let held = 0;
    for (const u of [A, B, C, D]) held += (await ok("GET", "/points", u.token)).points.held;
    // `held` counts each user's own stakes, so it's the full escrow.
    assert.strictEqual(total + held + burned, minted);
  });

  console.log(`points e2e passed (${passed} steps)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
