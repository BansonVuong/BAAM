// relayer/features.ts
//
// Entry point for the accountability features (proof, recurring check-in bets,
// streaks + head-to-head) so index.ts only needs a few lines of wiring:
//   if (await handleFeatureRoutes(req, res, featureCtx)) return;
//
// Routes handled here:
//   POST /bets/:id/proof                         (relayer/proofs.ts)
//   GET  /proofs/:id                             (relayer/proofs.ts)
//   GET  /bets/:id/checkins                      (relayer/checkins.ts)
//   POST /bets/:id/checkins                      (relayer/checkins.ts)
//   POST /bets/:id/checkins/:checkinId/review    (relayer/checkins.ts)
//   GET  /bets/:id                               one bet, decorated with proofs + check-ins
//   GET  /stats/:username                        record, streaks, head-to-head

import type http from "http";

import { bets, users, type BetDoc, type UserDoc } from "./db";
import { involvingUserFilter, visibleBetsFilter } from "./bet-visibility";
import { checkinProgress, handleCheckinRoutes, loadCheckinsForBets, toCheckinSummary } from "./checkins";
import {
  decodeSegment,
  doerUsername,
  isBetFinal,
  isBetParticipant,
  requestPath,
  sameUsername,
  type FeatureContext,
} from "./feature-context";
import { handleProofRoutes, loadProofsForBets, toProofSummary } from "./proofs";
import { computeUserStats } from "./stats";

export type { FeatureContext } from "./feature-context";
export { crankCheckinBets, isScheduledBet, parseScheduledBetInput } from "./checkins";

/** Message for POST /bets/vote on a recurring bet. */
export const SCHEDULED_BET_VOTE_ERROR =
  "this is a recurring check-in bet: its outcome comes from witness-reviewed check-ins "
  + "(POST /bets/:id/checkins/:checkinId/review), not votes";

// ── bet payload decoration ──────────────────────────────────────────────────────

export interface DecorateOptions {
  /**
   * Whether the viewer is a member of each bet's chat. `true` = the caller already
   * filtered to visible bets (GET /bets), so non-participants are members.
   */
  contextMember: true | ((bet: BetDoc) => Promise<boolean>);
}

/**
 * Add `proofCount`, `proofs`, `checkins`, `checkinProgress` and `viewerActions`
 * to bet payloads. Proof/check-in details are only included when the viewer is a
 * participant or a member of the bet's chat; everyone else just sees counts.
 */
export async function decorateBetsForViewer(
  ctx: FeatureContext,
  viewer: UserDoc,
  docs: BetDoc[],
  options: DecorateOptions,
): Promise<Array<BetDoc & Record<string, unknown>>> {
  const ids = docs.map((d) => d.id);
  const [proofsByBet, checkinsByBet] = await Promise.all([
    loadProofsForBets(ids),
    loadCheckinsForBets(docs.filter((d) => d.schedule).map((d) => d.id)),
  ]);
  const now = Date.now();
  return Promise.all(docs.map(async (doc) => {
    const bet = ctx.normalizeBetDoc(doc);
    const participant = isBetParticipant(bet, viewer.username);
    const member = options.contextMember === true ? true : await options.contextMember(bet);
    const canView = participant || member;
    const proofEntry = proofsByBet.get(bet.id);
    const checkinDocs = checkinsByBet.get(bet.id) ?? [];
    const open = !isBetFinal(bet) && bet.validation !== "sports";
    const beforeDeadline = typeof bet.resolveByDate !== "number" || now < bet.resolveByDate;
    const progress = bet.schedule ? checkinProgress(bet, checkinDocs, now) : null;
    const doer = bet.schedule ? doerUsername(bet) : null;
    return {
      ...bet,
      proofCount: proofEntry?.count ?? 0,
      proofs: canView ? (proofEntry?.items ?? []).map((p) => toProofSummary(ctx, p, viewer)) : [],
      ...(bet.schedule ? {
        checkins: canView ? checkinDocs.map(toCheckinSummary) : [],
        checkinProgress: progress,
      } : {}),
      viewerActions: {
        canAddProof: open && participant,
        canCheckin: Boolean(
          open && bet.status === "ACTIVE" && beforeDeadline
          && doer && sameUsername(doer, viewer.username)
          && progress?.currentWindow
          && !checkinDocs.some((c) => c.occurrenceKey === progress.currentWindow?.key),
        ),
        canReview: Boolean(
          bet.schedule && open && bet.status === "ACTIVE" && beforeDeadline && !participant && member
          && checkinDocs.some((c) => c.status === "pending"),
        ),
        canVote: Boolean(
          !bet.schedule && open && bet.status === "ACTIVE" && beforeDeadline && !participant && member
          && !(bet.onChain && bet.currency === "SOL" && bet.onChainState !== "locked"),
        ),
      },
    };
  }));
}

/** Merge proof + check-in data into a GET /imessage/bets/:id card. */
export async function decorateIMessageCard(
  ctx: FeatureContext,
  viewer: UserDoc,
  bet: BetDoc,
  card: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [decorated] = await decorateBetsForViewer(ctx, viewer, [bet], {
    contextMember: (b) => ctx.isBetContextMember(viewer, b),
  });
  const proofList = decorated.proofs as Array<{ image: { url: string } | null }>;
  const actions = (card.actions ?? {}) as Record<string, unknown>;
  const viewerActions = decorated.viewerActions as Record<string, boolean>;
  return {
    ...card,
    proofCount: decorated.proofCount,
    proofs: proofList,
    firstProofImageUrl: proofList.find((p) => p.image)?.image?.url ?? null,
    checkins: bet.schedule ? decorated.checkinProgress : null,
    actions: {
      ...actions,
      canVote: Boolean(actions.canVote) && !bet.schedule,
      canAddProof: viewerActions.canAddProof,
      canCheckin: viewerActions.canCheckin,
      canReview: viewerActions.canReview,
      proofEndpoint: `/bets/${encodeURIComponent(bet.id)}/proof`,
      checkinEndpoint: `/bets/${encodeURIComponent(bet.id)}/checkins`,
    },
  };
}

// ── routes ──────────────────────────────────────────────────────────────────────

const BET_PATH = /^\/bets\/([^/]+)$/;
const STATS_PATH = /^\/stats\/([^/]+)$/;

export async function handleFeatureRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FeatureContext,
): Promise<boolean> {
  if (await handleProofRoutes(req, res, ctx)) return true;
  if (await handleCheckinRoutes(req, res, ctx)) return true;
  if (req.method !== "GET") return false;
  const path = requestPath(req);

  // GET /bets/:id — participants and chat members only
  const betMatch = BET_PATH.exec(path);
  if (betMatch) {
    const user = await ctx.getAuthenticatedUser(req);
    if (!user) return respond(ctx, res, 401, { error: "unauthorized" });
    const betId = decodeSegment(betMatch[1]);
    const betsCol = await bets();
    if (!betsCol) return respond(ctx, res, 503, { error: "MongoDB not configured. Set MONGODB_URI to enable this route." });
    const doc = betId ? await betsCol.findOne({ id: betId }, { projection: { _id: 0 } }) : null;
    if (!doc) return respond(ctx, res, 404, { error: "bet not found" });
    const bet = ctx.normalizeBetDoc(doc);
    const member = await ctx.isBetContextMember(user, bet);
    if (!member && !isBetParticipant(bet, user.username)) {
      return respond(ctx, res, 403, { error: "only participants and members of this bet's chat can view it" });
    }
    const [decorated] = await decorateBetsForViewer(ctx, user, [bet], { contextMember: async () => member });
    return respond(ctx, res, 200, { bet: decorated });
  }

  // GET /stats/:username — computed only from bets the viewer can already see
  const statsMatch = STATS_PATH.exec(path);
  if (statsMatch) {
    const viewer = await ctx.getAuthenticatedUser(req);
    if (!viewer) return respond(ctx, res, 401, { error: "unauthorized" });
    const username = decodeSegment(statsMatch[1])?.replace(/^@/, "");
    const usersCol = await users();
    const betsCol = await bets();
    if (!usersCol || !betsCol) return respond(ctx, res, 503, { error: "MongoDB not configured. Set MONGODB_URI to enable this route." });
    const target = username ? await usersCol.findOne({ usernameLower: username.toLowerCase() }) : null;
    if (!target) return respond(ctx, res, 404, { error: "user not found" });
    const docs = await betsCol
      .find({ $and: [await visibleBetsFilter(viewer), involvingUserFilter(target.username)] }, { projection: { _id: 0 } })
      .toArray();
    const normalized = docs.map((d) => ctx.normalizeBetDoc(d));
    const checkinsByBet = await loadCheckinsForBets(normalized.filter((b) => b.schedule).map((b) => b.id));
    return respond(ctx, res, 200, {
      stats: computeUserStats(target.username, normalized, checkinsByBet, Date.now()),
      scope: sameUsername(viewer.username, target.username) ? "self" : "shared",
    });
  }

  return false;
}

function respond(ctx: FeatureContext, res: http.ServerResponse, status: number, body: Record<string, unknown>): true {
  ctx.json(res, status, body);
  return true;
}
