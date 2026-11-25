// End-to-end check for proof, recurring check-in bets and stats, driven through
// the HTTP API of a LOCAL relayer:
//
//   E2E_BASE=http://127.0.0.1:8794 MONGODB_URI=mongodb://127.0.0.1:27999 MONGODB_DB=<test db> \
//     TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/features.e2e.ts
//
// SOL bets need funded devnet wallets to post/accept. When POST /bets can't
// get past the SOL balance check (no devnet SOL / RPC rate limits), the script
// inserts the bet's ACTIVE state straight into the TEST database as a simulated
// play-money (PTS) bet, exactly as POST /bets + POST /bets/accept would leave it.
// It refuses to run against anything but localhost.

import assert from "assert";
import zlib from "zlib";
import { MongoClient } from "mongodb";

import type { BetDoc } from "./db";
import { localDateKey, validateScheduleInput } from "./schedule";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8794";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27999";
const MONGODB_DB = process.env.MONGODB_DB ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error(`refusing to run against ${BASE}`);
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(MONGODB_URI) || !MONGODB_DB) {
  throw new Error("set MONGODB_URI (localhost) and MONGODB_DB to the relayer's throwaway test database");
}

// ── helpers ──────────────────────────────────────────────────────────────────────

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, opts: { token?: string; body?: unknown; raw?: Buffer; type?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: Uint8Array | string | undefined;
  if (opts.raw) {
    headers["content-type"] = opts.type ?? "application/octet-stream";
    body = new Uint8Array(opts.raw);
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: Json = {};
  if ((res.headers.get("content-type") ?? "").includes("json")) json = JSON.parse(buf.toString("utf8"));
  return { status: res.status, json, buf, headers: res.headers };
}

function expectStatus(r: { status: number; json: Json }, status: number, label: string) {
  assert.strictEqual(r.status, status, `${label}: expected ${status}, got ${r.status} ${JSON.stringify(r.json)}`);
  console.log(`  ok  ${label} → ${status}${r.json.error ? ` (${r.json.error})` : ""}`);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A valid 2×2 RGBA PNG. */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.from([0, 255, 80, 0, 255, 0, 160, 255, 255]);
  const raw = Buffer.concat([row, row]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const RUN = Date.now().toString(36);
const PASSWORD = "e2e-password-123";

async function signup(name: string) {
  const username = `${name}-${RUN}`;
  const r = await call("POST", "/auth/signup", { body: { email: `${username}@example.test`, username, password: PASSWORD } });
  expectStatus(r, 201, `signup ${username}`);
  return { username, token: r.json.token as string };
}

// ── run ──────────────────────────────────────────────────────────────────────────

async function main() {
  const mongo = await new MongoClient(MONGODB_URI).connect();
  const betsCol = mongo.db(MONGODB_DB).collection<BetDoc>("bets");
  const simulated: string[] = [];

  try {
    console.log("users + group");
    const jordan = await signup("jordan");
    const sam = await signup("sam");
    const wit1 = await signup("wit1");
    const wit2 = await signup("wit2");
    const outsider = await signup("outsider");
    const g = await call("POST", "/groups", { token: jordan.token, body: { name: `Gym ${RUN}` } });
    expectStatus(g, 201, "create group");
    const groupId = g.json.group.id as string;
    for (const u of [sam, wit1, wit2]) {
      expectStatus(await call("POST", `/groups/${groupId}/members`, { token: jordan.token, body: { username: u.username } }), 200, `add ${u.username}`);
    }

    /** POST /bets; if the SOL balance check blocks it, insert the ACTIVE state directly (PTS). */
    async function activeBet(label: string, body: Json, acceptor = sam.username): Promise<BetDoc> {
      const created = await call("POST", "/bets", { token: jordan.token, body: { groupId, type: "PERSONAL", acceptor, currency: "SOL", stake: "0.01", ...body } });
      const now = Date.now();
      if (created.status === 201) {
        console.log(`  ok  POST /bets ${label} → 201 (on-chain accept still needs SOL; activating in the test DB)`);
      } else {
        assert.match(String(created.json.error), /SOL|balance|lamports/i, `${label}: unexpected create error ${JSON.stringify(created.json)}`);
        console.log(`  --  POST /bets ${label} blocked by SOL balance check (${created.json.error}); simulating a PTS bet in the test DB`);
      }
      const validated = validateScheduleInput(body, now);
      if (validated && "error" in validated) throw new Error(validated.error);
      const scheduled = validated && !("error" in validated) ? validated : null;
      const doc: BetDoc = {
        ...(created.status === 201 ? created.json.bet : {}),
        id: created.status === 201 ? created.json.bet.id : `bet-${now}-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: now,
        groupId,
        type: "PERSONAL",
        challenger: jordan.username,
        acceptor,
        terms: body.terms,
        stake: created.status === 201 ? "0.01" : "100",
        currency: created.status === 201 ? "SOL" : "PTS",
        status: "ACTIVE",
        witnesses: body.witnesses ?? 1,
        minBettors: 2,
        groupSize: 5,
        acceptedBy: acceptor,
        opponentUsername: acceptor,
        acceptedAt: now,
        acceptByDate: null,
        resolveByDate: scheduled ? scheduled.resolveByDate : now + 7 * 24 * 3600 * 1000,
        fallbackKind: "return",
        ...(scheduled ? { schedule: scheduled.schedule, requiredCheckins: scheduled.requiredCheckins, doer: scheduled.doer } : {}),
      };
      delete (doc as Partial<BetDoc>).onChain;
      await betsCol.replaceOne({ id: doc.id }, doc, { upsert: true });
      simulated.push(doc.id);
      return doc;
    }

    // ── 1. proof on a plain witness bet ───────────────────────────────────────
    console.log("proof");
    const plain = await activeBet("plain witness bet", { terms: "Jordan lifts at 5am tomorrow", witnesses: 1 });
    const png = tinyPng();
    const dataUrl = `data:image/gif;base64,${png.toString("base64")}`; // declared type is ignored
    const up = await call("POST", `/bets/${plain.id}/proof`, {
      token: jordan.token, body: { image: dataUrl, caption: "5:02am, bar loaded", link: "https://strava.com/activities/123" },
    });
    expectStatus(up, 201, "participant uploads PNG proof (JSON data URL)");
    const proof = up.json.proof;
    assert.strictEqual(proof.image.contentType, "image/png");
    assert.strictEqual(proof.caption, "5:02am, bar loaded");
    const rawUp = await call("POST", `/bets/${plain.id}/proof?caption=${encodeURIComponent("raw upload")}`, { token: sam.token, raw: png, type: "image/png" });
    expectStatus(rawUp, 201, "acceptor uploads raw image body");
    expectStatus(await call("POST", `/bets/${plain.id}/proof`, { token: jordan.token, raw: Buffer.from("<svg onload=alert(1)>"), type: "image/png" }), 415, "spoofed image/png (SVG bytes) rejected");
    expectStatus(await call("POST", `/bets/${plain.id}/proof`, { token: jordan.token, body: { link: "javascript:alert(1)" } }), 400, "javascript: link rejected");
    expectStatus(await call("POST", `/bets/${plain.id}/proof`, { token: jordan.token, body: { caption: "x".repeat(281) } }), 400, "281-char caption rejected");
    expectStatus(await call("POST", `/bets/${plain.id}/proof`, { token: jordan.token, raw: Buffer.alloc(2 * 1024 * 1024 + 10, 1), type: "image/jpeg" }), 413, "> 2 MB image rejected");
    expectStatus(await call("POST", `/bets/${plain.id}/proof`, { token: wit1.token, body: { caption: "not mine" } }), 403, "witness can't attach proof");

    const asMember = await call("GET", `/proofs/${proof.id}`, { token: wit1.token });
    expectStatus(asMember, 200, "group member fetches proof image");
    assert.strictEqual(asMember.headers.get("content-type"), "image/png");
    assert.strictEqual(asMember.headers.get("x-content-type-options"), "nosniff");
    assert.match(asMember.headers.get("cache-control") ?? "", /private/);
    assert.ok(asMember.buf.equals(png), "served bytes match the upload");
    expectStatus(await call("GET", `/proofs/${proof.id}`, { token: outsider.token }), 403, "outsider fetches proof image");
    expectStatus(await call("GET", `/proofs/${proof.id}`), 401, "anonymous fetch without signature");
    const signed = await call("GET", proof.image.url);
    expectStatus(signed, 200, "signed <img> URL works without a bearer token");
    expectStatus(await call("GET", proof.image.url.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"))), 401, "tampered signature");
    const etag = asMember.headers.get("etag")!;
    const cached = await fetch(`${BASE}/proofs/${proof.id}`, { headers: { authorization: `Bearer ${wit1.token}`, "if-none-match": etag } });
    assert.strictEqual(cached.status, 304);
    console.log("  ok  If-None-Match → 304");

    const listed = await call("GET", "/bets", { token: wit1.token });
    expectStatus(listed, 200, "GET /bets");
    const listedPlain = listed.json.bets.find((b: Json) => b.id === plain.id);
    assert.strictEqual(listedPlain.proofCount, 2);
    assert.strictEqual(listedPlain.proofs[0].caption, "5:02am, bar loaded");
    assert.strictEqual(listedPlain.viewerActions.canVote, true);
    const one = await call("GET", `/bets/${plain.id}`, { token: sam.token });
    expectStatus(one, 200, "GET /bets/:id as participant");
    assert.strictEqual(one.json.bet.proofs.length, 2);
    expectStatus(await call("GET", `/bets/${plain.id}`, { token: outsider.token }), 403, "GET /bets/:id as outsider");
    const card = await call("GET", `/imessage/bets/${plain.id}`, { token: wit1.token });
    expectStatus(card, 200, "iMessage card");
    assert.strictEqual(card.json.card.proofCount, 2);
    assert.match(card.json.card.firstProofImageUrl, /^\/proofs\/prf-.*\?sig=/);

    // Rate limit: 10 uploads / 10 min / user / bet (jordan already used 1 + the rejected ones don't count).
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await call("POST", `/bets/${plain.id}/proof`, { token: jordan.token, body: { caption: `spam ${i}` } });
      if (r.status === 429) limited += 1;
    }
    assert.ok(limited >= 3, `expected rate limiting, got ${limited} x 429`);
    console.log(`  ok  burst uploads rate-limited (${limited} x 429)`);

    // ── 2. recurring check-in bets ────────────────────────────────────────────
    console.log("check-ins");
    const tz = "America/New_York";
    const today = localDateKey(Date.now(), tz);
    const plusDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const everyDay = { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: tz, startDate: today, endDate: plusDays(today, 2) };

    // Validation through the API (runs before the SOL balance check).
    const bad = await call("POST", "/bets", { token: jordan.token, body: { groupId, type: "PERSONAL", acceptor: sam.username, currency: "SOL", stake: "0.01", terms: "Too long a habit", schedule: { ...everyDay, endDate: plusDays(today, 120) } } });
    expectStatus(bad, 400, "schedule longer than 90 days rejected");
    expectStatus(await call("POST", "/bets", { token: jordan.token, body: { groupId, type: "PERSONAL", acceptor: sam.username, currency: "SOL", stake: "0.01", terms: "Bad timezone habit", schedule: { ...everyDay, timezone: "Nowhere/Land" } } }), 400, "invalid timezone rejected");

    // A: jordan (challenger, doer) needs 1 approved check-in; 2 witnesses must approve.
    const betA = await activeBet("scheduled bet A", { terms: "Jordan lifts every day this week", witnesses: 2, schedule: everyDay, requiredCheckins: 1, resolveByDate: Date.now() + 1e10 });
    assert.ok(betA.resolveByDate! < Date.now() + 5 * 86400000, "resolveByDate derived from the schedule, not the client");
    expectStatus(await call("POST", "/bets/vote", { token: wit1.token, body: { betId: betA.id, votedFor: "challenger" } }), 409, "plain vote on a scheduled bet");
    expectStatus(await call("POST", `/bets/${betA.id}/checkins`, { token: sam.token, body: { link: "https://example.com/x" } }), 403, "non-doer check-in");
    expectStatus(await call("POST", `/bets/${betA.id}/checkins`, { token: jordan.token, body: { caption: "trust me" } }), 400, "check-in without proof");
    expectStatus(await call("POST", `/bets/${betA.id}/checkins`, { token: jordan.token, body: { occurrenceKey: plusDays(today, 1), link: "https://example.com/x" } }), 409, "check-in for a window that isn't open yet");
    const ciA = await call("POST", `/bets/${betA.id}/checkins`, { token: jordan.token, body: { image: `data:image/png;base64,${png.toString("base64")}`, caption: "day 1" } });
    expectStatus(ciA, 201, "doer checks in with image proof");
    const checkinA = ciA.json.checkin;
    assert.strictEqual(checkinA.occurrenceKey, today);
    assert.strictEqual(checkinA.proofIds.length, 1);
    expectStatus(await call("POST", `/bets/${betA.id}/checkins`, { token: jordan.token, body: { link: "https://example.com/again" } }), 409, "second check-in for the same occurrence");
    const extra = await call("POST", `/bets/${betA.id}/proof`, { token: jordan.token, body: { checkinId: checkinA.id, link: "https://example.com/more" } });
    expectStatus(extra, 201, "extra proof attached to the check-in");
    expectStatus(await call("GET", `/proofs/${checkinA.proofIds[0]}`, { token: wit2.token }), 200, "witness views check-in proof");
    expectStatus(await call("POST", `/bets/${betA.id}/checkins/${checkinA.id}/review`, { token: sam.token, body: { approve: true } }), 403, "participant can't review");
    expectStatus(await call("POST", `/bets/${betA.id}/checkins/${checkinA.id}/review`, { token: outsider.token, body: { approve: true } }), 403, "outsider can't review");
    const r1 = await call("POST", `/bets/${betA.id}/checkins/${checkinA.id}/review`, { token: wit1.token, body: { approve: true } });
    expectStatus(r1, 200, "witness 1 approves");
    assert.strictEqual(r1.json.checkin.status, "pending"); // threshold is 2
    assert.strictEqual(r1.json.bet.status, "ACTIVE");
    const r2 = await call("POST", `/bets/${betA.id}/checkins/${checkinA.id}/review`, { token: wit2.token, body: { approve: true } });
    expectStatus(r2, 200, "witness 2 approves");
    assert.strictEqual(r2.json.checkin.status, "approved");
    assert.strictEqual(r2.json.bet.resolvedWinner, "challenger");
    assert.strictEqual(r2.json.bet.status, "COMPLETED");
    console.log(`  ok  bet A resolvedWinner=challenger (${r2.json.bet.checkinVerdictReason})`);
    const progressA = await call("GET", `/bets/${betA.id}/checkins`, { token: wit1.token });
    expectStatus(progressA, 200, "GET /bets/:id/checkins");
    assert.strictEqual(progressA.json.progress.approved, 1);
    assert.strictEqual(progressA.json.progress.occurrences[0].state, "approved");

    // B: sam (acceptor) is the doer and must hit all 3 days; a rejection makes it impossible.
    const betB = await activeBet("scheduled bet B", { terms: "Sam meditates every day", witnesses: 1, schedule: everyDay, doer: "acceptor" });
    const ciB = await call("POST", `/bets/${betB.id}/checkins`, { token: sam.token, body: { link: "https://example.com/headspace" } });
    expectStatus(ciB, 201, "acceptor-doer checks in with a link");
    const rejB = await call("POST", `/bets/${betB.id}/checkins/${ciB.json.checkin.id}/review`, { token: wit1.token, body: { approve: false } });
    expectStatus(rejB, 200, "witness rejects");
    assert.strictEqual(rejB.json.checkin.status, "rejected");
    assert.strictEqual(rejB.json.bet.resolvedWinner, "challenger");
    console.log("  ok  bet B resolvedWinner=challenger (doer can no longer reach 3/3)");

    // C: inserted with windows that already closed and no check-ins → the crank decides it.
    const pastStart = plusDays(today, -3);
    const pastSchedule = { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: tz, startDate: pastStart, endDate: plusDays(today, -2) };
    const nowMs = Date.now();
    const betC: BetDoc = {
      id: `bet-${nowMs}-crank${RUN.slice(-3)}`, createdAt: nowMs - 4 * 86400000, groupId, type: "PERSONAL",
      challenger: jordan.username, acceptor: sam.username, acceptedBy: sam.username, opponentUsername: sam.username,
      terms: "Jordan journals two days running", stake: "100", currency: "PTS", status: "ACTIVE", witnesses: 1,
      minBettors: 2, groupSize: 5, acceptedAt: nowMs - 4 * 86400000, resolveByDate: nowMs + 86400000, fallbackKind: "return",
      schedule: pastSchedule, requiredCheckins: 2, doer: "challenger",
    };
    await betsCol.insertOne({ ...betC });
    simulated.push(betC.id);
    let decided: BetDoc | null = null;
    for (let i = 0; i < 40 && !decided?.resolvedWinner; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      decided = await betsCol.findOne({ id: betC.id });
    }
    assert.strictEqual(decided?.resolvedWinner, "acceptor", "crankCheckinBets should award the missed habit to the other side");
    assert.strictEqual(decided?.status, "COMPLETED");
    console.log(`  ok  crank decided bet C: resolvedWinner=acceptor (${decided?.checkinVerdictReason})`);

    // ── 3. stats ──────────────────────────────────────────────────────────────
    console.log("stats");
    const st = await call("GET", `/stats/${jordan.username}`, { token: sam.token });
    expectStatus(st, 200, "GET /stats/:username (shared group)");
    const s = st.json.stats;
    assert.strictEqual(s.wins, 2); // A, B
    assert.strictEqual(s.losses, 1); // C
    assert.strictEqual(s.active, 1); // plain
    assert.strictEqual(s.currentWinStreak, 0); // C (newest) was a loss
    assert.strictEqual(s.longestWinStreak, 2);
    // Check-in sequence by window time: C (3 and 2 days ago) missed, missed; A (today) approved.
    assert.strictEqual(s.currentCheckinStreak, 1);
    assert.strictEqual(s.longestCheckinStreak, 1);
    assert.deepStrictEqual(s.checkins, { approved: 1, missed: 2, total: 3 });
    assert.strictEqual(s.headToHead[0].opponent, sam.username);
    assert.strictEqual(s.headToHead[0].played, 3);
    console.log(`  ok  jordan: ${s.wins}W-${s.losses}L, win streak ${s.currentWinStreak}/${s.longestWinStreak}, check-in streak ${s.currentCheckinStreak}/${s.longestCheckinStreak}, vs ${sam.username} ${s.headToHead[0].wins}-${s.headToHead[0].losses}`);
    const hidden = await call("GET", `/stats/${jordan.username}`, { token: outsider.token });
    expectStatus(hidden, 200, "GET /stats/:username as outsider");
    assert.strictEqual(hidden.json.stats.wins + hidden.json.stats.losses + hidden.json.stats.active, 0, "outsider sees no private bets");
    expectStatus(await call("GET", `/stats/nobody-${RUN}`, { token: sam.token }), 404, "unknown user");
    expectStatus(await call("GET", `/stats/${jordan.username}`), 401, "stats require auth");

    console.log(`\nall feature e2e checks passed${simulated.length ? ` (bet state inserted directly for: ${simulated.join(", ")})` : ""}`);
  } finally {
    await mongo.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
