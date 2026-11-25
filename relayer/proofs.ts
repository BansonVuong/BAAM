// relayer/proofs.ts
//
// Proof attachments on witness bets: images (GridFS bucket `proofs`), links and
// short captions. Routes:
//   POST /bets/:id/proof   attach evidence (participants only)
//   GET  /proofs/:id       stream a proof image (participants + context members)
//
// Images are accepted as a JSON body `{ image: "data:image/png;base64,…" }` or
// as a raw body with an image content-type (caption/link/checkinId in the query
// string). The declared MIME type is ignored: bytes are sniffed and only JPEG,
// PNG, WebP and HEIC are stored, served back with the sniffed type and
// `X-Content-Type-Options: nosniff`.

import crypto from "crypto";
import type http from "http";
import { ObjectId } from "mongodb";

import { bets, checkins, proofBucket, proofs, users, type BetDoc, type ProofDoc, type UserDoc } from "./db";
import {
  canViewBetEvidence,
  decodeSegment,
  HttpError,
  isBetFinal,
  isBetParticipant,
  readBodyBuffer,
  requestPath,
  requestQuery,
  sameUsername,
  type FeatureContext,
} from "./feature-context";
import {
  decodeImagePayload,
  imageExtension,
  normalizeCaption,
  normalizeProofLink,
  PROOF_LIMITS,
  SlidingWindowLimiter,
  validateImageBytes,
  type ProofImageType,
} from "./proof-validation";

/** Proofs a single check-in can carry. */
export const MAX_PROOFS_PER_CHECKIN = 5;
/** Lifetime of a signed proof-image URL (rounded to hour buckets so URLs stay cacheable). */
const PROOF_URL_TTL_MS = 60 * 60 * 1000;
// JSON bodies carry base64 (4/3 overhead) plus a few small fields.
const MAX_JSON_BODY_BYTES = Math.ceil(PROOF_LIMITS.maxImageBytes * 1.4) + 16 * 1024;

const uploadLimiter = new SlidingWindowLimiter(PROOF_LIMITS.uploadsPerWindow, PROOF_LIMITS.uploadWindowMs);
const dailyUploadLimiter = new SlidingWindowLimiter(PROOF_LIMITS.uploadsPerUserPerDay, 24 * 60 * 60 * 1000);

// ── request parsing ─────────────────────────────────────────────────────────────

export interface ProofInput {
  image?: { bytes: Buffer; type: ProofImageType };
  link?: string;
  caption?: string;
  /** Attach to an existing check-in (POST /bets/:id/proof). */
  checkinId?: string;
  /** Target occurrence (POST /bets/:id/checkins). */
  occurrenceKey?: string;
  /** Previously uploaded, unattached proofs to attach to a new check-in. */
  proofIds?: string[];
}

/** Parse a proof upload (JSON with a data-URL image, or a raw image body). */
export async function readProofRequest(req: http.IncomingMessage): Promise<ProofInput> {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const isRaw = contentType.startsWith("image/") || contentType === "application/octet-stream";
  const input: ProofInput = {};
  let fields: Record<string, unknown>;
  if (isRaw) {
    const bytes = await readBodyBuffer(req, PROOF_LIMITS.maxImageBytes);
    const query = requestQuery(req);
    fields = Object.fromEntries(query.entries());
    if (bytes.length) {
      const checked = validateImageBytes(bytes);
      if ("error" in checked) throw new HttpError(415, checked.error);
      input.image = { bytes, type: checked.type };
    }
  } else {
    const body = await readBodyBuffer(req, MAX_JSON_BODY_BYTES);
    try {
      fields = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new HttpError(400, "body must be a JSON object");
    if (fields.image !== undefined && fields.image !== null && fields.image !== "") {
      const decoded = decodeImagePayload(fields.image);
      if ("error" in decoded) throw new HttpError(400, decoded.error);
      const checked = validateImageBytes(decoded.bytes);
      if ("error" in checked) throw new HttpError(415, checked.error);
      input.image = { bytes: decoded.bytes, type: checked.type };
    }
  }

  const link = normalizeProofLink(fields.link);
  if (link) {
    if ("error" in link) throw new HttpError(400, link.error);
    input.link = link.link;
  }
  const caption = normalizeCaption(fields.caption);
  if (caption) {
    if ("error" in caption) throw new HttpError(400, caption.error);
    input.caption = caption.caption;
  }
  if (typeof fields.checkinId === "string" && fields.checkinId.trim()) input.checkinId = fields.checkinId.trim().slice(0, 128);
  const occurrence = fields.occurrenceKey ?? fields.occurrence;
  if (typeof occurrence === "string" && occurrence.trim()) input.occurrenceKey = occurrence.trim().slice(0, 10);
  const rawIds = typeof fields.proofIds === "string" ? fields.proofIds.split(",") : fields.proofIds;
  if (Array.isArray(rawIds)) {
    input.proofIds = [...new Set(rawIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()))]
      .slice(0, MAX_PROOFS_PER_CHECKIN);
  }
  return input;
}

// ── rate limits + storage ───────────────────────────────────────────────────────

/** Throws 429 when `user` is over the per-bet upload limits. */
export async function enforceProofRateLimit(user: UserDoc, betId: string, nowMs = Date.now()): Promise<void> {
  const col = await proofs();
  if (!col) throw new HttpError(503, "MongoDB not configured");
  const total = await col.countDocuments({ betId, uploader: user.username });
  if (total >= PROOF_LIMITS.maxProofsPerUserPerBet) {
    throw new HttpError(429, `you can attach at most ${PROOF_LIMITS.maxProofsPerUserPerBet} proofs to one bet`);
  }
  if (!uploadLimiter.take(`${user.id}:${betId}`, nowMs)) {
    throw new HttpError(429, "too many proof uploads for this bet; try again in a few minutes");
  }
  if (!dailyUploadLimiter.take(user.id, nowMs)) {
    throw new HttpError(429, "daily proof upload limit reached; try again tomorrow");
  }
}

/** Store one proof (image in GridFS + metadata row). Requires an image or a link. */
export async function storeProof(
  bet: BetDoc,
  uploader: UserDoc,
  input: Pick<ProofInput, "image" | "link" | "caption">,
  checkinId?: string,
): Promise<ProofDoc> {
  if (!input.image && !input.link && !input.caption) throw new HttpError(400, "attach an image, a link, or a caption");
  const col = await proofs();
  const bucket = await proofBucket();
  if (!col || !bucket) throw new HttpError(503, "MongoDB not configured");
  const now = Date.now();
  const proof: ProofDoc = {
    id: `prf-${now}-${crypto.randomBytes(6).toString("hex")}`,
    betId: bet.id,
    uploader: uploader.username,
    createdAt: now,
    ...(checkinId ? { checkinId } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
    ...(input.link ? { link: input.link } : {}),
  };
  let fileId: ObjectId | null = null;
  if (input.image) {
    const { bytes, type } = input.image;
    fileId = new ObjectId();
    await new Promise<void>((resolve, reject) => {
      const stream = bucket.openUploadStreamWithId(fileId!, `${proof.id}.${imageExtension(type)}`, {
        metadata: { proofId: proof.id, betId: bet.id, uploader: uploader.username, contentType: type },
      });
      stream.once("finish", () => resolve());
      stream.once("error", reject);
      stream.end(bytes);
    });
    proof.image = {
      fileId: fileId.toHexString(),
      contentType: type,
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }
  try {
    await col.insertOne({ ...proof });
  } catch (err) {
    if (fileId) await bucket.delete(fileId).catch(() => undefined);
    throw err;
  }
  return proof;
}

// ── signed image URLs ───────────────────────────────────────────────────────────

function signingKey(ctx: FeatureContext): Buffer {
  return crypto.createHmac("sha256", ctx.urlSigningSecret).update("baam-proof-url-v1").digest();
}

function proofUrlMac(ctx: FeatureContext, proofId: string, uid: string, exp: number): string {
  return crypto.createHmac("sha256", signingKey(ctx)).update(`${proofId}\n${uid}\n${exp}`).digest("base64url").slice(0, 32);
}

/**
 * Relative URL for `<img src>` (browsers can't attach a bearer token). The
 * signature binds proof id + viewer id + expiry; access is re-checked on fetch.
 */
export function signedProofImagePath(ctx: FeatureContext, proofId: string, viewer: UserDoc, nowMs = Date.now()): string {
  const exp = Math.ceil((nowMs + PROOF_URL_TTL_MS) / PROOF_URL_TTL_MS) * PROOF_URL_TTL_MS;
  const sig = `${viewer.id}.${exp}.${proofUrlMac(ctx, proofId, viewer.id, exp)}`;
  return `/proofs/${encodeURIComponent(proofId)}?sig=${encodeURIComponent(sig)}`;
}

async function userFromProofSignature(ctx: FeatureContext, proofId: string, sig: string | null): Promise<UserDoc | null> {
  if (!sig) return null;
  const parts = sig.split(".");
  if (parts.length !== 3) return null;
  const [uid, expRaw, mac] = parts;
  const exp = Number(expRaw);
  if (!uid || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = Buffer.from(proofUrlMac(ctx, proofId, uid, exp));
  const provided = Buffer.from(mac);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
  const col = await users();
  return col ? col.findOne({ id: uid }) : null;
}

// ── summaries for bet payloads ──────────────────────────────────────────────────

export interface ProofSummary {
  id: string;
  uploader: string;
  createdAt: number;
  checkinId: string | null;
  caption: string | null;
  link: string | null;
  image: { url: string; contentType: string; bytes: number } | null;
}

export function toProofSummary(ctx: FeatureContext, proof: ProofDoc, viewer: UserDoc): ProofSummary {
  return {
    id: proof.id,
    uploader: proof.uploader,
    createdAt: proof.createdAt,
    checkinId: proof.checkinId ?? null,
    caption: proof.caption ?? null,
    link: proof.link ?? null,
    image: proof.image
      ? { url: signedProofImagePath(ctx, proof.id, viewer), contentType: proof.image.contentType, bytes: proof.image.bytes }
      : null,
  };
}

/** Proof counts + newest proofs (oldest first, capped) for many bets in one query each. */
export async function loadProofsForBets(betIds: string[]): Promise<Map<string, { count: number; items: ProofDoc[] }>> {
  const out = new Map<string, { count: number; items: ProofDoc[] }>();
  const col = await proofs();
  if (!col || betIds.length === 0) return out;
  const docs = await col
    .find({ betId: { $in: betIds } }, { projection: { _id: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
  for (const doc of docs) {
    const entry = out.get(doc.betId) ?? { count: 0, items: [] };
    entry.count += 1;
    entry.items.push(doc);
    if (entry.items.length > PROOF_LIMITS.maxListedPerBet) entry.items.shift();
    out.set(doc.betId, entry);
  }
  return out;
}

// ── routes ──────────────────────────────────────────────────────────────────────

function errorStatus(err: unknown): { status: number; error: string } | null {
  if (err instanceof HttpError) return { status: err.status, error: err.message };
  return null;
}

/** Loads a witness (non-sports) bet or throws an HttpError. */
export async function loadWitnessBet(ctx: FeatureContext, betId: string): Promise<BetDoc> {
  const col = await bets();
  if (!col) throw new HttpError(503, "MongoDB not configured. Set MONGODB_URI to enable this route.");
  const doc = await col.findOne({ id: betId }, { projection: { _id: 0 } });
  if (!doc) throw new HttpError(404, "bet not found");
  const bet = ctx.normalizeBetDoc(doc);
  if (bet.validation === "sports") throw new HttpError(409, "proof and check-ins apply to witness bets only, not sports bets");
  return bet;
}

const PROOF_UPLOAD_PATH = /^\/bets\/([^/]+)\/proofs?$/;
const PROOF_IMAGE_PATH = /^\/proofs\/([^/]+)$/;

export async function handleProofRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FeatureContext,
): Promise<boolean> {
  const path = requestPath(req);

  // POST /bets/:id/proof — JSON { image?: dataURL, link?, caption?, checkinId? } or raw image body
  const upload = req.method === "POST" ? PROOF_UPLOAD_PATH.exec(path) : null;
  if (upload) {
    try {
      const user = await ctx.getAuthenticatedUser(req);
      if (!user) throw new HttpError(401, "unauthorized");
      const betId = decodeSegment(upload[1]);
      if (!betId) throw new HttpError(400, "bet id is required");
      const bet = await loadWitnessBet(ctx, betId);
      if (!isBetParticipant(bet, user.username)) throw new HttpError(403, "only the bet's participants can attach proof");
      if (isBetFinal(bet)) throw new HttpError(409, "this bet is already decided; proof is closed");
      const input = await readProofRequest(req);
      if (!input.image && !input.link && !input.caption) throw new HttpError(400, "attach an image, a link, or a caption");

      let checkinId: string | undefined;
      if (input.checkinId) {
        const checkinsCol = await checkins();
        const checkin = await checkinsCol?.findOne({ id: input.checkinId, betId: bet.id });
        if (!checkin) throw new HttpError(404, "check-in not found on this bet");
        if (!sameUsername(checkin.doer, user.username)) throw new HttpError(403, "only the doer can add proof to their check-in");
        if (checkin.status !== "pending") throw new HttpError(409, "this check-in was already reviewed");
        if (checkin.proofIds.length >= MAX_PROOFS_PER_CHECKIN) {
          throw new HttpError(409, `a check-in can carry at most ${MAX_PROOFS_PER_CHECKIN} proofs`);
        }
        checkinId = checkin.id;
      }
      await enforceProofRateLimit(user, bet.id);
      const proof = await storeProof(bet, user, input, checkinId);
      if (checkinId) {
        await (await checkins())?.updateOne({ id: checkinId }, { $push: { proofIds: proof.id } });
      }
      ctx.json(res, 201, { proof: toProofSummary(ctx, proof, user) });
    } catch (err) {
      const known = errorStatus(err);
      if (!known) throw err;
      ctx.json(res, known.status, { error: known.error });
    }
    return true;
  }

  // GET /proofs/:id — bearer auth, or the signed ?sig= from a bet payload's image.url
  const image = req.method === "GET" || req.method === "HEAD" ? PROOF_IMAGE_PATH.exec(path) : null;
  if (image) {
    const proofId = decodeSegment(image[1]);
    if (!proofId) {
      ctx.json(res, 404, { error: "proof not found" });
      return true;
    }
    const user = (await ctx.getAuthenticatedUser(req))
      ?? (await userFromProofSignature(ctx, proofId, requestQuery(req).get("sig")));
    if (!user) {
      ctx.json(res, 401, { error: "unauthorized" });
      return true;
    }
    const proofsCol = await proofs();
    const bucket = await proofBucket();
    const betsCol = await bets();
    if (!proofsCol || !bucket || !betsCol) {
      ctx.json(res, 503, { error: "MongoDB not configured. Set MONGODB_URI to enable this route." });
      return true;
    }
    const proof = await proofsCol.findOne({ id: proofId }, { projection: { _id: 0 } });
    const betDoc = proof ? await betsCol.findOne({ id: proof.betId }, { projection: { _id: 0 } }) : null;
    if (!proof || !betDoc) {
      ctx.json(res, 404, { error: "proof not found" });
      return true;
    }
    if (!(await canViewBetEvidence(ctx, user, ctx.normalizeBetDoc(betDoc)))) {
      ctx.json(res, 403, { error: "only participants and members of this bet's chat can view its proof" });
      return true;
    }
    if (!proof.image) {
      ctx.json(res, 404, { error: "this proof has no image" });
      return true;
    }
    const etag = `"${proof.image.sha256.slice(0, 32)}"`;
    const headers: Record<string, string> = {
      ...ctx.corsHeaders(),
      "content-type": proof.image.contentType,
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="proof-${proof.id}.${imageExtension(proof.image.contentType)}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      // Access-controlled: browsers may cache, shared caches may not.
      "cache-control": "private, max-age=3600",
      etag,
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, { ...headers, "content-length": String(proof.image.bytes) });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    const stream = bucket.openDownloadStream(new ObjectId(proof.image.fileId));
    stream.on("error", (err) => {
      console.error(`proof ${proof.id}: image stream failed:`, err);
      res.destroy(err);
    });
    stream.pipe(res);
    return true;
  }

  return false;
}
