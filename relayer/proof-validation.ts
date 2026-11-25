// relayer/proof-validation.ts
//
// Pure validation for proof uploads: magic-byte image sniffing (the client's
// declared MIME type is never trusted), data-URL decoding, link and caption
// normalization. No I/O; see relayer/proofs.check.ts.

export type ProofImageType = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

export const PROOF_LIMITS = {
  /** Max decoded image size. */
  maxImageBytes: 2 * 1024 * 1024,
  maxCaptionChars: 280,
  maxLinkLength: 2048,
  /** Burst limit: uploads per user per bet per window. */
  uploadsPerWindow: 10,
  uploadWindowMs: 10 * 60 * 1000,
  /** Storage-abuse backstop across all bets: uploads per user per 24h. */
  uploadsPerUserPerDay: 100,
  /** Lifetime cap of proofs one user can attach to one bet. */
  maxProofsPerUserPerBet: 40,
  /** Proofs listed inline on a bet payload (newest last); proofCount is always the total. */
  maxListedPerBet: 50,
} as const;

// ISO-BMFF brands for HEIF/HEIC stills (incl. Apple's), not AVIF.
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** Detect the real image type from magic bytes; null for anything else. */
export function sniffImageType(buf: Buffer): ProofImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8
    && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (
    buf.length >= 12
    && buf.toString("latin1", 0, 4) === "RIFF"
    && buf.toString("latin1", 8, 12) === "WEBP"
  ) return "image/webp";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    const major = buf.toString("latin1", 8, 12);
    if (HEIF_BRANDS.has(major) && major !== "mif1" && major !== "msf1") return "image/heic";
    // Generic HEIF major brand: require a HEIC compatible brand so AVIF etc. are rejected.
    if (major === "mif1" || major === "msf1") {
      const boxSize = buf.readUInt32BE(0);
      const end = Math.min(buf.length, Math.max(16, boxSize));
      for (let i = 16; i + 4 <= end; i += 4) {
        const brand = buf.toString("latin1", i, i + 4);
        if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx") return "image/heic";
      }
    }
  }
  return null;
}

export function imageExtension(type: ProofImageType): string {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" }[type];
}

/**
 * Decode a `data:<mime>;base64,<data>` URL (or a bare base64 string). The
 * declared MIME type is ignored — callers must sniff the bytes.
 */
export function decodeImagePayload(value: unknown): { bytes: Buffer } | { error: string } {
  if (typeof value !== "string" || !value) return { error: "image must be a base64 data URL" };
  let b64 = value;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma === -1 || !/;base64$/i.test(value.slice(0, comma))) {
      return { error: "image data URL must be base64-encoded" };
    }
    b64 = value.slice(comma + 1);
  }
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return { error: "image is not valid base64" };
  if (Math.floor((b64.length * 3) / 4) > PROOF_LIMITS.maxImageBytes + 3) {
    return { error: `image must be at most ${PROOF_LIMITS.maxImageBytes / (1024 * 1024)} MB` };
  }
  return { bytes: Buffer.from(b64, b64.includes("-") || b64.includes("_") ? "base64url" : "base64") };
}

/** Validate raw image bytes; returns the sniffed type. */
export function validateImageBytes(bytes: Buffer): { type: ProofImageType } | { error: string } {
  if (bytes.length === 0) return { error: "image is empty" };
  if (bytes.length > PROOF_LIMITS.maxImageBytes) {
    return { error: `image must be at most ${PROOF_LIMITS.maxImageBytes / (1024 * 1024)} MB` };
  }
  const type = sniffImageType(bytes);
  if (!type) return { error: "image must be a JPEG, PNG, WebP or HEIC file" };
  return { type };
}

/** Normalize an http(s) link; rejects other schemes and embedded credentials. */
export function normalizeProofLink(value: unknown): { link: string } | { error: string } | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: "link must be a string" };
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > PROOF_LIMITS.maxLinkLength) return { error: `link must be at most ${PROOF_LIMITS.maxLinkLength} characters` };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "link must be a valid http(s) URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "link must use http or https" };
  if (url.username || url.password) return { error: "link must not contain credentials" };
  if (!url.hostname) return { error: "link must include a host" };
  return { link: url.href };
}

/** Trim a caption, strip control characters, enforce the 280-character limit. */
export function normalizeCaption(value: unknown): { caption: string } | { error: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return { error: "caption must be a string" };
  // eslint-disable-next-line no-control-regex
  const caption = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!caption) return null;
  if ([...caption].length > PROOF_LIMITS.maxCaptionChars) {
    return { error: `caption must be at most ${PROOF_LIMITS.maxCaptionChars} characters` };
  }
  return { caption };
}

/** In-memory sliding-window limiter (per relayer process). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records a hit and returns true when under the limit; false (no record) when over. */
  take(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(nowMs);
    return true;
  }

  private prune(nowMs: number): void {
    for (const [key, times] of this.hits) {
      if (!times.some((t) => nowMs - t < this.windowMs)) this.hits.delete(key);
    }
  }
}
