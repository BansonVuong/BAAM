// relayer/checkins.ts
//
// Recurring ("check-in") witness bets. A witness bet created with a `schedule`
// is decided by witness-reviewed check-ins instead of POST /bets/vote:
//   POST /bets/:id/checkins                         doer checks in (with proof) during an open window
//   POST /bets/:id/checkins/:checkinId/review       witness approves/rejects { approve: boolean }
//   GET  /bets/:id/checkins                         check-ins + progress for one bet
//
// Outcome contract (shared with the vote route and the payout cranks): this
// module ONLY sets `resolvedWinner` (+ status COMPLETED) through a conditional
// write on an ACTIVE bet with no winner and no claimed fallback. It never moves
// SOL or points — crankWitnessBets / the points crank pay out from resolvedWinner.
// The decision rules live in the pure relayer/schedule.ts.

import crypto from "crypto";
import type http from "http";

import { bets, checkins, proofs, type BetDoc, type CheckinDoc, type UserDoc } from "./db";
import {
  canViewBetEvidence,
  decodeSegment,
  doerUsername,
  HttpError,
  isBetFinal,
  isBetWitness,
  readBodyBuffer,
  requestPath,
  sameUsername,
  type FeatureContext,
} from "./feature-context";
import { enforceProofRateLimit, loadWitnessBet, MAX_PROOFS_PER_CHECKIN, readProofRequest, storeProof } from "./proofs";
import {
  currentOccurrence,
  decideCheckinStatus,
  evaluateCheckins,
  nextOccurrence,
  scheduleOccurrences,
  validateScheduleInput,
  verdictDeadline,
  type CheckinEvaluation,
  type Occurrence,
} from "./schedule";

// ── bet creation (POST /bets) ───────────────────────────────────────────────────

export interface ScheduledBetInput {
  /** Fields to store on the new bet. */
  fields: Pick<BetDoc, "schedule" | "requiredCheckins" | "doer">;
  /** Server-derived resolve-by date (end of last window + verdict grace). */
  resolveByDate: number;
  /** Client accept-by clamped to the end of the first window (the default when omitted). */
  acceptByDate(clientValue: unknown): number;
}

/**
 * Parse `schedule` / `requiredCheckins` / `doer` from a POST /bets body.
 * null = not a recurring bet. The resolve-by date always comes from the schedule.
 */
export function parseScheduledBetInput(
  body: Record<string, unknown>,
  nowMs: number,
): ScheduledBetInput | { error: string } | null {
  const validated = validateScheduleInput(body, nowMs);
  if (!validated) return null;
  if ("error" in validated) return { error: validated.error };
  return {
    fields: { schedule: validated.schedule, requiredCheckins: validated.requiredCheckins, doer: validated.doer },
    resolveByDate: validated.resolveByDate,
    acceptByDate: (clientValue) => (
      typeof clientValue === "number" && Number.isFinite(clientValue) && clientValue > nowMs
        ? Math.min(clientValue, validated.latestAcceptBy)
        : validated.latestAcceptBy
    ),
  };
}

export function isScheduledBet(bet: Pick<BetDoc, "schedule">): boolean {
  return Boolean(bet.schedule);
}

// ── evaluation ──────────────────────────────────────────────────────────────────

export function betOccurrences(bet: BetDoc): Occurrence[] {
  return bet.schedule ? scheduleOccurrences(bet.schedule) : [];
}

export function evaluateBetCheckins(bet: BetDoc, docs: CheckinDoc[], nowMs: number): CheckinEvaluation | null {
  if (!bet.schedule) return null;
  const occurrences = scheduleOccurrences(bet.schedule);
  const deadline = bet.resolveByDate ?? verdictDeadline(occurrences) ?? 0;
  return evaluateCheckins(occurrences, docs, bet.requiredCheckins ?? occurrences.length, deadline, nowMs);
}

/**
 * Evaluate an ACTIVE recurring bet and, when decided, record `resolvedWinner`
 * with the same conditional-write discipline as the vote route. Returns the
 * winning side if this call decided the bet.
 */
export async function recordCheckinOutcome(betId: string, nowMs: number): Promise<"challenger" | "acceptor" | null> {
  const betsCol = await bets();
  const checkinsCol = await checkins();
  if (!betsCol || !checkinsCol) return null;
  const bet = await betsCol.findOne({ id: betId }, { projection: { _id: 0 } });
  if (!bet?.schedule || bet.status !== "ACTIVE" || bet.resolvedWinner || bet.fallbackApplied || bet.fallbackBlocked) {
    return null;
  }
  const docs = await checkinsCol.find({ betId }, { projection: { _id: 0 } }).toArray();
  const evaluation = evaluateBetCheckins(bet, docs, nowMs);
  const decision = evaluation?.decision;
  if (!decision || decision.winner === null) return null;
  const doerSide = bet.doer ?? "challenger";
  const winner = decision.winner === "doer" ? doerSide : doerSide === "challenger" ? "acceptor" : "challenger";
  const write = await betsCol.updateOne(
    {
      id: betId,
      status: "ACTIVE",
      resolvedWinner: { $exists: false },
      fallbackApplied: { $exists: false },
      fallbackBlocked: { $exists: false },
    },
    {
      $set: {
        resolvedWinner: winner,
        status: "COMPLETED",
        resolvedAt: nowMs,
        checkinVerdictReason: `${decision.winner === "doer" ? "doer kept the streak" : "doer fell short"}: ${decision.reason}`,
      },
    },
  );
  if (write.modifiedCount !== 1) return null;
  console.log(`check-in bet ${betId} decided (winner=${winner}): ${decision.reason}`);
  return winner;
}

/** Crank step: decide every ACTIVE recurring bet that has become decidable. Runs before crankWitnessBets. */
export async function crankCheckinBets(ctx: FeatureContext): Promise<void> {
  const betsCol = await bets();
  if (!betsCol) return;
  const nowMs = await ctx.deadlineNowMs();
  const candidates = await betsCol
    .find(
      {
        schedule: { $exists: true },
        status: "ACTIVE",
        resolvedWinner: { $exists: false },
        fallbackApplied: { $exists: false },
        fallbackBlocked: { $exists: false },
      },
      { projection: { id: 1 } },
    )
    .toArray();
  for (const { id } of candidates) {
    try {
      await recordCheckinOutcome(id, nowMs);
    } catch (err) {
      console.error(`check-in crank failed for bet ${id}:`, err);
    }
  }
}

// ── payload views ───────────────────────────────────────────────────────────────

export interface CheckinSummary {
  id: string;
  occurrenceKey: string;
  occurrenceStart: number;
  occurrenceEnd: number;
  doer: string;
  submittedAt: number;
  caption: string | null;
  proofIds: string[];
  status: CheckinDoc["status"];
  reviews: CheckinDoc["reviews"];
  approvals: number;
  rejections: number;
  decidedAt: number | null;
}

export function toCheckinSummary(doc: CheckinDoc): CheckinSummary {
  const approvals = doc.reviews.filter((r) => r.approve).length;
  return {
    id: doc.id,
    occurrenceKey: doc.occurrenceKey,
    occurrenceStart: doc.occurrenceStart,
    occurrenceEnd: doc.occurrenceEnd,
    doer: doc.doer,
    submittedAt: doc.submittedAt,
    caption: doc.caption ?? null,
    proofIds: doc.proofIds,
    status: doc.status,
    reviews: doc.reviews,
    approvals,
    rejections: doc.reviews.length - approvals,
    decidedAt: doc.decidedAt ?? null,
  };
}

type CheckinWindow = { key: string; start: number; end: number };

export interface CheckinProgress {
  schedule: NonNullable<BetDoc["schedule"]>;
  doer: "challenger" | "acceptor";
  doerUsername: string | null;
  required: number;
  total: number;
  approved: number;
  possible: number;
  submitted: number;
  pendingReview: number;
  verdictDeadline: number | null;
  currentWindow: CheckinWindow | null;
  nextWindow: CheckinWindow | null;
  occurrences: Array<CheckinWindow & { state: string; checkinId: string | null }>;
  decision: CheckinEvaluation["decision"];
  verdictReason: string | null;
}

/** Schedule progress for a recurring bet (no viewer-specific fields). */
export function checkinProgress(bet: BetDoc, docs: CheckinDoc[], nowMs: number): CheckinProgress | null {
  const evaluation = evaluateBetCheckins(bet, docs, nowMs);
  if (!evaluation || !bet.schedule) return null;
  const occurrences = scheduleOccurrences(bet.schedule);
  const current = currentOccurrence(occurrences, nowMs);
  const next = nextOccurrence(occurrences, nowMs);
  const window = (o: Occurrence | null) => (o ? { key: o.key, start: o.start, end: o.end } : null);
  return {
    schedule: bet.schedule,
    doer: bet.doer ?? "challenger",
    doerUsername: doerUsername(bet),
    required: evaluation.required,
    total: evaluation.total,
    approved: evaluation.approved,
    possible: evaluation.possible,
    submitted: docs.length,
    pendingReview: docs.filter((d) => d.status === "pending").length,
    verdictDeadline: bet.resolveByDate ?? null,
    currentWindow: window(current),
    nextWindow: window(next),
    occurrences: evaluation.occurrences.map((o) => ({
      key: o.key, start: o.start, end: o.end, state: o.state, checkinId: o.checkinId ?? null,
    })),
    // Live decision; once the bet is COMPLETED, resolvedWinner on the bet is authoritative.
    decision: evaluation.decision,
    verdictReason: bet.checkinVerdictReason ?? null,
  };
}

export async function loadCheckinsForBets(betIds: string[]): Promise<Map<string, CheckinDoc[]>> {
  const out = new Map<string, CheckinDoc[]>();
  const col = await checkins();
  if (!col || betIds.length === 0) return out;
  const docs = await col.find({ betId: { $in: betIds } }, { projection: { _id: 0 } }).sort({ occurrenceStart: 1 }).toArray();
  for (const doc of docs) {
    const list = out.get(doc.betId) ?? [];
    list.push(doc);
    out.set(doc.betId, list);
  }
  return out;
}

// ── routes ──────────────────────────────────────────────────────────────────────

const CHECKINS_PATH = /^\/bets\/([^/]+)\/checkins$/;
const REVIEW_PATH = /^\/bets\/([^/]+)\/checkins\/([^/]+)\/review$/;
const REVIEW_WRITE_ATTEMPTS = 4;

function requireScheduledActive(bet: BetDoc, action: string): void {
  if (!bet.schedule) throw new HttpError(409, "this bet has no check-in schedule");
  if (isBetFinal(bet)) throw new HttpError(409, `this bet is already decided; ${action} is closed`);
  if (bet.status !== "ACTIVE") throw new HttpError(409, `the bet must be accepted before ${action}`);
}

async function submitCheckin(
  ctx: FeatureContext,
  req: http.IncomingMessage,
  user: UserDoc,
  bet: BetDoc,
): Promise<{ status: number; body: Record<string, unknown> }> {
  requireScheduledActive(bet, "checking in");
  const doer = doerUsername(bet);
  if (!doer || !sameUsername(doer, user.username)) {
    throw new HttpError(403, `only the doer (${doer ?? bet.doer ?? "challenger"}) can check in on this bet`);
  }
  const input = await readProofRequest(req);
  const now = Date.now();
  if (typeof bet.resolveByDate === "number" && now >= bet.resolveByDate) {
    throw new HttpError(409, "the verdict deadline has passed; check-ins are closed");
  }
  const occurrences = betOccurrences(bet);
  const occurrence = input.occurrenceKey
    ? occurrences.find((o) => o.key === input.occurrenceKey)
    : currentOccurrence(occurrences, now);
  if (!occurrence) {
    const next = nextOccurrence(occurrences, now);
    throw new HttpError(409, input.occurrenceKey
      ? `${input.occurrenceKey} is not a scheduled day for this bet`
      : `no check-in window is open right now${next ? ` (next opens ${new Date(next.start).toISOString()})` : ""}`);
  }
  if (now < occurrence.start || now >= occurrence.end) {
    throw new HttpError(409, `the ${occurrence.key} check-in window is ${now < occurrence.start ? "not open yet" : "closed"}`);
  }

  const proofsCol = await proofs();
  const checkinsCol = await checkins();
  if (!proofsCol || !checkinsCol) throw new HttpError(503, "MongoDB not configured");
  // Already-uploaded proofs (POST /bets/:id/proof) may be attached instead of / as well as new ones.
  const existingProofs = input.proofIds?.length
    ? await proofsCol.find({ id: { $in: input.proofIds }, betId: bet.id }, { projection: { _id: 0 } }).toArray()
    : [];
  if (input.proofIds && existingProofs.length !== input.proofIds.length) throw new HttpError(404, "proof not found on this bet");
  if (existingProofs.some((p) => !sameUsername(p.uploader, user.username) || p.checkinId)) {
    throw new HttpError(409, "you can only attach your own proofs that aren't already on a check-in");
  }
  const hasNewProof = Boolean(input.image || input.link);
  if (!hasNewProof && existingProofs.length === 0) {
    throw new HttpError(400, "a check-in needs proof: an image, a link, or proofIds of uploaded proofs");
  }
  if (existingProofs.length + (hasNewProof ? 1 : 0) > MAX_PROOFS_PER_CHECKIN) {
    throw new HttpError(400, `a check-in can carry at most ${MAX_PROOFS_PER_CHECKIN} proofs`);
  }
  if (hasNewProof) await enforceProofRateLimit(user, bet.id);

  const checkin: CheckinDoc = {
    id: `chk-${now}-${crypto.randomBytes(5).toString("hex")}`,
    betId: bet.id,
    occurrenceKey: occurrence.key,
    occurrenceStart: occurrence.start,
    occurrenceEnd: occurrence.end,
    doer: user.username,
    submittedAt: now,
    proofIds: [],
    ...(input.caption ? { caption: input.caption } : {}),
    reviews: [],
    status: "pending",
    rev: 0,
  };
  try {
    await checkinsCol.insertOne({ ...checkin });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new HttpError(409, `you already checked in for ${occurrence.key}`);
    }
    throw err;
  }

  const proofIds = existingProofs.map((p) => p.id);
  try {
    if (hasNewProof) {
      const proof = await storeProof(bet, user, { image: input.image, link: input.link, caption: input.caption }, checkin.id);
      proofIds.push(proof.id);
    }
    if (existingProofs.length) {
      await proofsCol.updateMany(
        { id: { $in: existingProofs.map((p) => p.id) }, checkinId: { $exists: false } },
        { $set: { checkinId: checkin.id } },
      );
    }
  } catch (err) {
    await checkinsCol.deleteOne({ id: checkin.id });
    throw err;
  }
  checkin.proofIds = proofIds;
  await checkinsCol.updateOne({ id: checkin.id }, { $set: { proofIds } });
  return { status: 201, body: { checkin: toCheckinSummary(checkin) } };
}

async function reviewCheckin(
  ctx: FeatureContext,
  req: http.IncomingMessage,
  user: UserDoc,
  bet: BetDoc,
  checkinId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = await readBodyBuffer(req, 4096);
  let body: Record<string, unknown>;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof body.approve !== "boolean") throw new HttpError(400, "approve must be true or false");
  requireScheduledActive(bet, "reviewing");
  if (!(await isBetWitness(ctx, user, bet))) {
    throw new HttpError(403, "only witnesses (members of this bet's chat who aren't participants) can review check-ins");
  }
  const now = Date.now();
  if (typeof bet.resolveByDate === "number" && now >= bet.resolveByDate) {
    throw new HttpError(409, "the verdict deadline has passed; reviews are closed");
  }
  const checkinsCol = await checkins();
  if (!checkinsCol) throw new HttpError(503, "MongoDB not configured");
  const threshold = Math.max(1, Number(bet.witnesses) || 1);

  for (let attempt = 0; attempt < REVIEW_WRITE_ATTEMPTS; attempt += 1) {
    const current = await checkinsCol.findOne({ id: checkinId, betId: bet.id }, { projection: { _id: 0 } });
    if (!current) throw new HttpError(404, "check-in not found on this bet");
    if (current.status !== "pending") {
      return { status: 409, body: { error: "this check-in was already decided", checkin: toCheckinSummary(current) } };
    }
    // A witness may change their review while the check-in is still undecided.
    const reviews = [
      ...current.reviews.filter((r) => !sameUsername(r.reviewer, user.username)),
      { reviewer: user.username, approve: body.approve, at: now },
    ];
    const status = decideCheckinStatus(reviews, threshold);
    const write = await checkinsCol.updateOne(
      { id: current.id, status: "pending", rev: current.rev },
      { $set: { reviews, status, rev: current.rev + 1, ...(status !== "pending" ? { decidedAt: now } : {}) } },
    );
    if (write.modifiedCount === 1) {
      const decidedWinner = status === "pending" ? null : await recordCheckinOutcome(bet.id, now);
      const latest = await checkinsCol.findOne({ id: current.id }, { projection: { _id: 0 } });
      return {
        status: 200,
        body: {
          checkin: toCheckinSummary(latest ?? { ...current, reviews, status }),
          betDecided: Boolean(decidedWinner),
          ...(decidedWinner ? { resolvedWinner: decidedWinner } : {}),
        },
      };
    }
  }
  throw new HttpError(409, "this check-in is being reviewed concurrently; try again");
}

export async function handleCheckinRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FeatureContext,
): Promise<boolean> {
  const path = requestPath(req);
  const list = CHECKINS_PATH.exec(path);
  const review = req.method === "POST" ? REVIEW_PATH.exec(path) : null;
  if (!review && !(list && (req.method === "POST" || req.method === "GET"))) return false;

  try {
    const user = await ctx.getAuthenticatedUser(req);
    if (!user) throw new HttpError(401, "unauthorized");
    const betId = decodeSegment((review ?? list)![1]);
    if (!betId) throw new HttpError(400, "bet id is required");
    const bet = await loadWitnessBet(ctx, betId);

    if (review) {
      const checkinId = decodeSegment(review[2]);
      if (!checkinId) throw new HttpError(400, "check-in id is required");
      const result = await reviewCheckin(ctx, req, user, bet, checkinId);
      const latestBet = await (await bets())?.findOne({ id: bet.id }, { projection: { _id: 0 } });
      ctx.json(res, result.status, { ...result.body, ...(latestBet ? { bet: ctx.normalizeBetDoc(latestBet) } : {}) });
      return true;
    }
    if (req.method === "POST") {
      const result = await submitCheckin(ctx, req, user, bet);
      ctx.json(res, result.status, { ...result.body, bet });
      return true;
    }
    // GET /bets/:id/checkins
    if (!(await canViewBetEvidence(ctx, user, bet))) throw new HttpError(403, "only participants and members of this bet's chat can view its check-ins");
    if (!bet.schedule) throw new HttpError(409, "this bet has no check-in schedule");
    const docs = (await loadCheckinsForBets([bet.id])).get(bet.id) ?? [];
    ctx.json(res, 200, {
      checkins: docs.map(toCheckinSummary),
      progress: checkinProgress(bet, docs, Date.now()),
    });
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    ctx.json(res, err.status, { error: err.message });
    return true;
  }
}
