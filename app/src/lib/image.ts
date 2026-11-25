/**
 * Client-side proof image preparation: downscale big photos so uploads stay
 * well under the relayer's 2 MB limit (relayer/proof-validation.ts).
 */

export const PROOF_MAX_EDGE = 1600;
export const PROOF_MAX_BYTES = 2 * 1024 * 1024;
/** Re-encode anything above this even if it's already small enough in pixels. */
export const PROOF_TARGET_BYTES = 1.2 * 1024 * 1024;
export const PROOF_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

const PASSTHROUGH_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Scale (width, height) so the long edge is at most `maxEdge`, keeping aspect ratio. */
export function fitWithin(width: number, height: number, maxEdge = PROOF_MAX_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface DownscalePlan {
  width: number;
  height: number;
  /** False: upload the original bytes untouched. */
  reencode: boolean;
}

/** Decide whether a decoded image needs resizing / re-encoding before upload. */
export function planDownscale(input: { width: number; height: number; bytes: number; type: string }): DownscalePlan {
  const size = fitWithin(input.width, input.height);
  const resized = size.width !== Math.round(input.width) || size.height !== Math.round(input.height);
  const reencode = resized || input.bytes > PROOF_TARGET_BYTES || !PASSTHROUGH_TYPES.has(input.type);
  return { ...size, reencode };
}

/** JPEG qualities to try, best first, until the result fits. */
export const QUALITY_STEPS = [0.86, 0.78, 0.68, 0.56];

export type PreparedImage = { blob: Blob; width: number; height: number; previewUrl: string };

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to <img>, which some browsers decode more formats with (HEIC in Safari).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Downscale to ≤ 1600px on the long edge and re-encode as JPEG when needed.
 * HEIC that the browser can't decode is uploaded as-is if it already fits.
 */
export async function prepareProofImage(file: File): Promise<PreparedImage> {
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    if (file.size <= PROOF_MAX_BYTES) {
      return { blob: file, width: 0, height: 0, previewUrl: URL.createObjectURL(file) };
    }
    throw new Error("This photo couldn't be opened. Try a JPEG or PNG under 2 MB.");
  }
  try {
    const plan = planDownscale({ width: decoded.width, height: decoded.height, bytes: file.size, type: file.type });
    if (!plan.reencode) {
      return { blob: file, width: plan.width, height: plan.height, previewUrl: URL.createObjectURL(file) };
    }
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser can't resize photos. Try a smaller one.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, plan.width, plan.height);
    context.drawImage(decoded.source, 0, 0, plan.width, plan.height);
    for (const quality of QUALITY_STEPS) {
      const blob = await toBlob(canvas, "image/jpeg", quality);
      if (blob && blob.size <= PROOF_TARGET_BYTES) {
        return { blob, width: plan.width, height: plan.height, previewUrl: URL.createObjectURL(blob) };
      }
    }
    const last = await toBlob(canvas, "image/jpeg", 0.5);
    if (last && last.size <= PROOF_MAX_BYTES) {
      return { blob: last, width: plan.width, height: plan.height, previewUrl: URL.createObjectURL(last) };
    }
    throw new Error("This photo is too large even after shrinking it. Try another one.");
  } finally {
    decoded.close();
  }
}
