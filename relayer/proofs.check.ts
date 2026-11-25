// Plain assertion script for relayer/proof-validation.ts (no test framework):
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/proofs.check.ts
import assert from "assert";

import {
  decodeImagePayload,
  normalizeCaption,
  normalizeProofLink,
  PROOF_LIMITS,
  SlidingWindowLimiter,
  sniffImageType,
  validateImageBytes,
} from "./proof-validation";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const PNG = hex("89504e470d0a1a0a 0000000d49484452");
const JPEG = hex("ffd8ffe000104a464946");
const WEBP = Buffer.concat([Buffer.from("RIFF"), hex("24000000"), Buffer.from("WEBPVP8 ")]);
const ftyp = (major: string, ...compat: string[]) => {
  const body = Buffer.concat([Buffer.from("ftyp"), Buffer.from(major), hex("00000000"), ...compat.map((c) => Buffer.from(c))]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length + 4);
  return Buffer.concat([size, body]);
};

// ── magic bytes ────────────────────────────────────────────────────────────────
assert.strictEqual(sniffImageType(PNG), "image/png");
assert.strictEqual(sniffImageType(JPEG), "image/jpeg");
assert.strictEqual(sniffImageType(WEBP), "image/webp");
assert.strictEqual(sniffImageType(ftyp("heic", "mif1", "heic")), "image/heic");
assert.strictEqual(sniffImageType(ftyp("mif1", "mif1", "heic")), "image/heic"); // iPhone-style generic brand
assert.strictEqual(sniffImageType(ftyp("avif", "mif1", "avif")), null);
assert.strictEqual(sniffImageType(ftyp("mif1", "mif1", "avif")), null);
assert.strictEqual(sniffImageType(Buffer.from("GIF89a....")), null);
assert.strictEqual(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
assert.strictEqual(sniffImageType(Buffer.from("<html><script>alert(1)</script>")), null);
assert.strictEqual(sniffImageType(Buffer.alloc(0)), null);
assert.match((validateImageBytes(Buffer.alloc(0)) as { error: string }).error, /empty/);
assert.match((validateImageBytes(Buffer.concat([PNG, Buffer.alloc(PROOF_LIMITS.maxImageBytes)])) as { error: string }).error, /2 MB/);

// ── data URLs: the declared MIME type is ignored ───────────────────────────────
const asDataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString("base64")}`;
const decoded = decodeImagePayload(asDataUrl("image/gif", PNG));
assert.ok("bytes" in decoded && decoded.bytes.equals(PNG));
assert.strictEqual(sniffImageType((decoded as { bytes: Buffer }).bytes), "image/png");
assert.ok("bytes" in decodeImagePayload(PNG.toString("base64"))); // bare base64
assert.ok("error" in decodeImagePayload("data:image/png,rawtext"));
assert.ok("error" in decodeImagePayload("data:image/png;base64,***"));
assert.ok("error" in decodeImagePayload(42));
assert.ok("error" in decodeImagePayload(`data:image/png;base64,${"A".repeat(Math.ceil(PROOF_LIMITS.maxImageBytes * 1.4))}`));

// ── links + captions ───────────────────────────────────────────────────────────
assert.deepStrictEqual(normalizeProofLink("https://strava.com/activities/1"), { link: "https://strava.com/activities/1" });
assert.deepStrictEqual(normalizeProofLink(" http://Example.com/a b "), { link: "http://example.com/a%20b" });
assert.strictEqual(normalizeProofLink(""), null);
assert.strictEqual(normalizeProofLink(undefined), null);
assert.ok("error" in normalizeProofLink("javascript:alert(1)")!);
assert.ok("error" in normalizeProofLink("data:text/html,hi")!);
assert.ok("error" in normalizeProofLink("ftp://x.com/file")!);
assert.ok("error" in normalizeProofLink("https://user:pw@x.com/")!);
assert.ok("error" in normalizeProofLink("not a url")!);
assert.ok("error" in normalizeProofLink(`https://x.com/${"a".repeat(PROOF_LIMITS.maxLinkLength)}`)!);
assert.deepStrictEqual(normalizeCaption("  5am lift done \u0007 "), { caption: "5am lift done" });
assert.strictEqual(normalizeCaption("   "), null);
assert.ok("caption" in normalizeCaption("🏋️".repeat(140))!); // counted in code points
assert.ok("error" in normalizeCaption("x".repeat(281))!);
assert.ok("error" in normalizeCaption(5)!);

// ── rate limiter ───────────────────────────────────────────────────────────────
const limiter = new SlidingWindowLimiter(2, 1000);
assert.strictEqual(limiter.take("u:b", 0), true);
assert.strictEqual(limiter.take("u:b", 10), true);
assert.strictEqual(limiter.take("u:b", 20), false);
assert.strictEqual(limiter.take("u:other", 20), true);
assert.strictEqual(limiter.take("u:b", 1000), true); // first hit aged out
assert.strictEqual(limiter.take("u:b", 1001), false);

console.log("proof validation checks passed");
