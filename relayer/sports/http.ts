// relayer/sports/http.ts
//
// Shared HTTP plumbing for sports providers: per-request timeouts, bounded
// retries with exponential backoff, in-flight request de-duplication, a small
// per-provider concurrency cap, and a TTL cache. Error messages never contain
// provider URLs or keys (those are logged server-side only).

const HTTP_TIMEOUT_MS = positiveNumber(process.env.SPORTS_HTTP_TIMEOUT_MS, 8_000);
const HTTP_RETRIES = Math.max(0, Math.floor(positiveNumber(process.env.SPORTS_HTTP_RETRIES, 2, true)));
const MAX_CONCURRENT_PER_PROVIDER = 4;
const USER_AGENT = "baam-relayer/1.0";

export function positiveNumber(raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || (!allowZero && n === 0)) return fallback;
  return n;
}

export type ProviderErrorKind = "timeout" | "network" | "http" | "parse" | "rate_limited" | "not_configured";

/** A provider failure. `message` is safe to log; never return it verbatim to API clients. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface JsonResponse<T> {
  status: number;
  body: T | null;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const semaphores = new Map<string, Semaphore>();
const inFlight = new Map<string, Promise<JsonResponse<unknown>>>();

function semaphoreFor(provider: string): Semaphore {
  let s = semaphores.get(provider);
  if (!s) {
    s = new Semaphore(MAX_CONCURRENT_PER_PROVIDER);
    semaphores.set(provider, s);
  }
  return s;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET a JSON document. Resolves `{ status, body }` for 2xx and 404 (body null on
 * 404) so callers can distinguish "doesn't exist" from "provider is down"; every
 * other outcome throws ProviderError after retries. `logLabel` is what appears in
 * server logs instead of the full URL (which may embed an API key).
 */
export async function getJson<T>(provider: string, url: string, logLabel: string): Promise<JsonResponse<T>> {
  const existing = inFlight.get(url);
  if (existing) return existing as Promise<JsonResponse<T>>;
  const promise = semaphoreFor(provider)
    .run(() => getJsonWithRetry<T>(provider, url, logLabel))
    .finally(() => inFlight.delete(url));
  inFlight.set(url, promise as Promise<JsonResponse<unknown>>);
  return promise;
}

async function getJsonWithRetry<T>(provider: string, url: string, logLabel: string): Promise<JsonResponse<T>> {
  let lastError: ProviderError | null = null;
  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    if (attempt > 0) {
      // 400ms, 1.2s, 3.6s ... plus jitter so parallel callers don't stampede.
      await sleep(400 * 3 ** (attempt - 1) + Math.floor(Math.random() * 200));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      if (res.status === 404) {
        // Drain so the socket can be reused.
        await res.text().catch(() => "");
        return { status: 404, body: null };
      }
      if (!res.ok) {
        await res.text().catch(() => "");
        lastError = new ProviderError(
          provider,
          res.status === 429 ? "rate_limited" : "http",
          `${provider} ${logLabel}: HTTP ${res.status}`,
          res.status,
        );
        if (isRetryableStatus(res.status)) continue;
        throw lastError;
      }
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as T };
      } catch {
        // A truncated / HTML error page is not worth retrying more than the loop does.
        lastError = new ProviderError(provider, "parse", `${provider} ${logLabel}: invalid JSON`);
        continue;
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      lastError = new ProviderError(
        provider,
        aborted ? "timeout" : "network",
        `${provider} ${logLabel}: ${aborted ? `timed out after ${HTTP_TIMEOUT_MS}ms` : (err instanceof Error ? err.message : String(err))}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ProviderError(provider, "network", `${provider} ${logLabel}: request failed`);
}

/** Tiny TTL cache that also remembers when each value was fetched. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; fetchedAtMs: number }>();
  constructor(private readonly maxEntries = 500) {}

  get(key: string, maxAgeMs: number, nowMs = Date.now()): { value: T; fetchedAtMs: number } | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (nowMs - hit.fetchedAtMs > maxAgeMs) return null;
    return hit;
  }

  set(key: string, value: T, fetchedAtMs = Date.now()): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, fetchedAtMs });
  }
}

/** Run `fn` over `items` with at most `limit` concurrent calls; preserves order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
