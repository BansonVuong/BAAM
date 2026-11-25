import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getBets,
  getGroups,
  getMessages,
  type AuthUser,
  type Bet,
  type Group,
} from "../lib/relayer";
import {
  countUnreadGroupNotifications,
  markAllGroupNotificationsRead,
  mergeGroupNotifications,
  parseStoredGroupNotifications,
  parseStoredStringArray,
  type GroupNotification,
} from "../lib/groupNotifications";
import { friendlyError, sameName } from "../lib/bets";

const POLL_MS = 3000;

interface BaamData {
  user: AuthUser;
  groups: Group[];
  bets: Bet[];
  /** True once the first groups/bets fetch has resolved (success or failure). */
  loaded: boolean;
  error: string | null;
  /** Group id for each bet (bet.groupId, else the group whose chat carries it). */
  betGroupIds: Record<string, string>;
  unreadByGroup: Record<string, number>;
  totalUnread: number;
  /** The chat currently on screen; its unread count stays at zero. */
  setOpenGroupId: (groupId: string | null) => void;
  markGroupRead: (groupId: string, readAt?: number) => void;
  refresh: () => Promise<void>;
  upsertBet: (bet: Bet) => void;
  upsertGroup: (group: Group) => void;
  notifications: GroupNotification[];
  unreadNotifications: number;
  markNotificationsRead: () => void;
}

const DataContext = createContext<BaamData | null>(null);

export function useBaamData(): BaamData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useBaamData must be used inside <DataProvider>");
  return value;
}

function readJson(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): unread state just won't persist.
  }
}

function parseReadMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
        .map(([groupId, value]) => [groupId, Number(value)]),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

export function DataProvider({ user, children }: { user: AuthUser; children: ReactNode }) {
  const username = user.username;
  const userKey = username.toLowerCase();
  const lastReadKey = `BAAM_last_read_by_group_${userKey}`;
  const notificationsKey = `BAAM_group_notifications_${userKey}`;
  const seenGroupsKey = `BAAM_seen_group_ids_${userKey}`;

  const [groups, setGroups] = useState<Group[]>([]);
  const [bets, setBets] = useState<Bet[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [betGroupIdsFromMessages, setBetGroupIdsFromMessages] = useState<Record<string, string>>({});
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>({});
  const [notifications, setNotifications] = useState<GroupNotification[]>(
    () => parseStoredGroupNotifications(readJson(notificationsKey)),
  );

  const lastReadRef = useRef<Record<string, number>>(parseReadMap(readJson(lastReadKey)));
  const openGroupRef = useRef<string | null>(null);
  const seenGroupIdsRef = useRef<Set<string>>(new Set(parseStoredStringArray(readJson(seenGroupsKey))));
  const restoredNotificationCountRef = useRef(notifications.length);
  const aliveRef = useRef(true);

  const markGroupRead = useCallback((groupId: string, readAt = Date.now()) => {
    if (!groupId) return;
    const previous = lastReadRef.current[groupId] ?? 0;
    if (readAt > previous) {
      lastReadRef.current = { ...lastReadRef.current, [groupId]: readAt };
      writeJson(lastReadKey, lastReadRef.current);
    }
    setUnreadByGroup((prev) => (prev[groupId] ? { ...prev, [groupId]: 0 } : prev));
  }, [lastReadKey]);

  const setOpenGroupId = useCallback((groupId: string | null) => {
    openGroupRef.current = groupId;
    if (groupId) markGroupRead(groupId);
  }, [markGroupRead]);

  const refreshMessagesMeta = useCallback(async (nextGroups: Group[]) => {
    const results = await Promise.allSettled(nextGroups.map(async (group) => {
      const { messages } = await getMessages(group.id);
      return { group, messages };
    }));
    if (!aliveRef.current) return;
    const nextUnread: Record<string, number> = {};
    const nextBetGroups: Record<string, string> = {};
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { group, messages } = result.value;
      const lastRead = lastReadRef.current[group.id] ?? 0;
      let unread = 0;
      for (const message of messages) {
        if (message.betId && !nextBetGroups[message.betId]) nextBetGroups[message.betId] = group.id;
        const createdAt = typeof message.createdAt === "number" ? message.createdAt : 0;
        if (createdAt > lastRead && !sameName(message.sender, username)) unread += 1;
      }
      nextUnread[group.id] = openGroupRef.current === group.id ? 0 : unread;
    }
    setUnreadByGroup(nextUnread);
    setBetGroupIdsFromMessages(nextBetGroups);
  }, [username]);

  const applyNotifications = useCallback((nextGroups: Group[]) => {
    const seen = seenGroupIdsRef.current;
    const isFirstSync = seen.size === 0 && restoredNotificationCountRef.current === 0;
    setNotifications((prev) => {
      const next = mergeGroupNotifications(prev, nextGroups, isFirstSync, seen);
      writeJson(notificationsKey, next.slice(0, 50));
      return next;
    });
    for (const group of nextGroups) seen.add(group.id);
    restoredNotificationCountRef.current = Math.max(restoredNotificationCountRef.current, 1);
    writeJson(seenGroupsKey, Array.from(seen));
  }, [notificationsKey, seenGroupsKey]);

  const refresh = useCallback(async () => {
    try {
      const [groupsRes, betsRes] = await Promise.all([getGroups(), getBets()]);
      if (!aliveRef.current) return;
      setGroups(groupsRes.groups);
      setBets(betsRes.bets);
      setError(null);
      applyNotifications(groupsRes.groups);
      void refreshMessagesMeta(groupsRes.groups).catch(() => {});
    } catch (err) {
      if (!aliveRef.current) return;
      setError(friendlyError(err, "Couldn't load your chats. Try again in a minute."));
    } finally {
      if (aliveRef.current) setLoaded(true);
    }
  }, [applyNotifications, refreshMessagesMeta]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const upsertBet = useCallback((nextBet: Bet) => {
    setBets((prev) => (prev.some((bet) => bet.id === nextBet.id)
      ? prev.map((bet) => (bet.id === nextBet.id ? nextBet : bet))
      : [...prev, nextBet]));
  }, []);

  const upsertGroup = useCallback((nextGroup: Group) => {
    setGroups((prev) => (prev.some((group) => group.id === nextGroup.id)
      ? prev.map((group) => (group.id === nextGroup.id ? nextGroup : group))
      : [nextGroup, ...prev]));
  }, []);

  const markNotificationsRead = useCallback(() => {
    setNotifications((prev) => {
      const { notifications: next, changed } = markAllGroupNotificationsRead(prev);
      if (changed) writeJson(notificationsKey, next);
      return changed ? next : prev;
    });
  }, [notificationsKey]);

  const betGroupIds = useMemo(() => {
    const map: Record<string, string> = { ...betGroupIdsFromMessages };
    for (const bet of bets) if (bet.groupId) map[bet.id] = bet.groupId;
    return map;
  }, [bets, betGroupIdsFromMessages]);

  const value = useMemo<BaamData>(() => ({
    user,
    groups,
    bets,
    loaded,
    error,
    betGroupIds,
    unreadByGroup,
    totalUnread: Object.values(unreadByGroup).reduce((sum, count) => sum + count, 0),
    setOpenGroupId,
    markGroupRead,
    refresh,
    upsertBet,
    upsertGroup,
    notifications: [...notifications].sort((a, b) => b.createdAt - a.createdAt),
    unreadNotifications: countUnreadGroupNotifications(notifications),
    markNotificationsRead,
  }), [
    user, groups, bets, loaded, error, betGroupIds, unreadByGroup, setOpenGroupId, markGroupRead,
    refresh, upsertBet, upsertGroup, notifications, markNotificationsRead,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
