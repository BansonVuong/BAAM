// relayer/bet-visibility.ts
//
// Which bets a user may see: bets in their web groups (directly or through the
// legacy system-message link), in their iMessage / Discord conversations, plus
// bets they are a party to. Shared by GET /bets and GET /stats/:username.

import type { Filter } from "mongodb";

import { discordConversations, groups, imessageConversations, messages, type BetDoc, type UserDoc } from "./db";

/** Mongo filter matching every bet visible to `user`. */
export async function visibleBetsFilter(user: UserDoc): Promise<Filter<BetDoc>> {
  const [groupsCol, messagesCol, imessageConvCol, discordConvCol] = await Promise.all([
    groups(),
    messages(),
    imessageConversations(),
    discordConversations(),
  ]);
  const memberGroups = groupsCol
    ? await groupsCol.find({}, { projection: { id: 1, memberUsernames: 1 } }).toArray()
    : [];
  const groupIds = memberGroups
    .filter((group) => (
      Array.isArray(group.memberUsernames)
      && group.memberUsernames.some((member) => member.toLowerCase() === user.username.toLowerCase())
    ))
    .map((group) => group.id);
  const legacyBetIds = groupIds.length && messagesCol
    ? await messagesCol.distinct("betId", { groupId: { $in: groupIds }, betId: { $type: "string" } })
    : [];
  const [imessageConversationIds, discordConversationIds] = await Promise.all([
    imessageConvCol ? imessageConvCol.distinct("id", { memberUserIds: user.id }) : [],
    discordConvCol ? discordConvCol.distinct("id", { memberUserIds: user.id }) : [],
  ]);
  const membershipFilters: Filter<BetDoc>[] = [
    ...(groupIds.length ? [
      { groupId: { $in: groupIds } },
      { id: { $in: legacyBetIds } },
    ] : []),
    ...(imessageConversationIds.length ? [
      { source: "imessage" as const, imessageConversationId: { $in: imessageConversationIds } },
    ] : []),
    ...(discordConversationIds.length ? [
      { source: "discord" as const, discordConversationId: { $in: discordConversationIds } },
    ] : []),
  ];
  const usernameFilters: Filter<BetDoc>[] = [
    { challenger: user.username },
    { acceptor: user.username },
    { acceptedBy: user.username },
    { opponentUsername: user.username },
  ];
  return { $or: [...membershipFilters, ...usernameFilters] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mongo filter for bets `username` is a party to (case-insensitive). */
export function involvingUserFilter(username: string): Filter<BetDoc> {
  const exact = new RegExp(`^${escapeRegExp(username)}$`, "i");
  return { $or: [{ challenger: exact }, { acceptor: exact }, { acceptedBy: exact }, { opponentUsername: exact }] };
}
