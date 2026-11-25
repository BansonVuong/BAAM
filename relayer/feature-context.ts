// relayer/feature-context.ts
//
// Shared plumbing for the proof / check-in / stats routes. index.ts builds one
// FeatureContext from its own helpers (auth, membership, JSON responses) so the
// feature modules never reach into index.ts directly.

import type http from "http";

import type { BetDoc, UserDoc } from "./db";

export interface FeatureContext {
  getAuthenticatedUser(req: http.IncomingMessage): Promise<UserDoc | null>;
  /** Member of the bet's web group / iMessage conversation / Discord conversation. */
  isBetContextMember(user: UserDoc, bet: BetDoc): Promise<boolean>;
  normalizeBetDoc(doc: BetDoc): BetDoc;
  json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void;
  corsHeaders(): Record<string, string>;
  /** Server secret used to sign short-lived proof image URLs. */
  urlSigningSecret: string;
  /** Clock for verdict-deadline decisions: max(wall clock, chain clock). */
  deadlineNowMs(): Promise<number>;
}

export function sameUsername(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Everyone who is a party to the bet (an open "anyone" acceptor slot is not a person). */
export function betParticipantUsernames(bet: BetDoc): string[] {
  const names = [bet.challenger, bet.acceptor, bet.acceptedBy, bet.opponentUsername]
    .filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    .filter((name) => name.trim().toLowerCase() !== "anyone");
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isBetParticipant(bet: BetDoc, username: string): boolean {
  return betParticipantUsernames(bet).some((name) => sameUsername(name, username));
}

/** Username of the opponent once accepted ("anyone" bets adopt the acceptor). */
export function acceptorUsername(bet: BetDoc): string | null {
  const name = bet.acceptedBy ?? bet.opponentUsername ?? bet.acceptor;
  return name && name.toLowerCase() !== "anyone" ? name : null;
}

/** Username of the side doing the habit on a recurring bet. */
export function doerUsername(bet: BetDoc): string | null {
  return (bet.doer ?? "challenger") === "acceptor" ? acceptorUsername(bet) : bet.challenger;
}

/** Participants and context members may see a bet's proofs. */
export async function canViewBetEvidence(ctx: FeatureContext, user: UserDoc, bet: BetDoc): Promise<boolean> {
  return isBetParticipant(bet, user.username) || ctx.isBetContextMember(user, bet);
}

/** Witness eligibility, identical to POST /bets/vote: a context member who isn't a participant. */
export async function isBetWitness(ctx: FeatureContext, user: UserDoc, bet: BetDoc): Promise<boolean> {
  return !isBetParticipant(bet, user.username) && ctx.isBetContextMember(user, bet);
}

export function isBetFinal(bet: BetDoc): boolean {
  return bet.status === "COMPLETED" || bet.status === "RESOLVED"
    || Boolean(bet.resolvedWinner || bet.fallbackApplied || bet.fallbackBlocked || bet.offerExpired);
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Read a request body into memory, rejecting anything over `maxBytes` with a 413. */
export function readBodyBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new HttpError(413, `request body too large (max ${maxBytes} bytes)`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.resume();
        reject(new HttpError(413, `request body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (err) => { if (!done) { done = true; reject(err); } });
  });
}

/** Path (without query) of a request URL. */
export function requestPath(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0] ?? "";
}

export function requestQuery(req: http.IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://relayer.local").searchParams;
}

export function decodeSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = decodeURIComponent(raw).trim();
    return value && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}
