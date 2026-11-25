import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Medal, Ticket as TicketIcon, Volleyball, type LucideIcon } from "lucide-react";
import {
  AUTH_TOKEN_STORAGE_KEY,
  DISCORD_ENABLED,
  getBet,
  getCurrentAuthUser,
  linkDiscord,
  type AuthResult,
  type AuthUser,
  type DiscordLinkResult,
} from "../lib/relayer";
import { friendlyError } from "../lib/bets";
import { cn } from "../lib/cn";
import { DataProvider, useBaamData } from "./data";
import { AuthLayout, AuthScreen, Wordmark } from "./components/shell/AuthScreen";
import { AccountMenu, NotificationsMenu, type Theme } from "./components/shell/AccountMenu";
import { YourTicketsRail } from "./components/shell/YourTicketsRail";
import { GroupList, NewGroupButton } from "./components/chat/GroupList";
import { ChatView } from "./components/chat/ChatView";
import { TicketsView, useMyBets } from "./components/TicketsView";
import { SportsView } from "./components/SportsView";
import { StandingsView } from "./components/StandingsView";
import { Button, CountBadge, EmptyState, ScreenTitle, Sheet, buttonClass } from "./components/primitives";
import { BetOverlays } from "./components/shell/BetOverlays";
import { ProfileSheet } from "./components/people/ProfileSheet";

// Dev-only fixtures page (/?preview=tickets). Stripped from production builds.
const TicketPreview = import.meta.env.DEV
  ? lazy(() => import("./components/dev/TicketPreview"))
  : null;

type ViewId = "chats" | "tickets" | "sports" | "standings";

const NAV: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "chats", label: "Chats", Icon: MessageCircle },
  { id: "tickets", label: "Tickets", Icon: TicketIcon },
  { id: "sports", label: "Sports", Icon: Volleyball },
  { id: "standings", label: "Standings", Icon: Medal },
];

const THEME_KEY = "BAAM_theme";

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* per-viewer convenience only */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

function useIsDesktop(): boolean {
  const query = "(min-width: 1024px)";
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return matches;
}

/* ── Signed-in shell ────────────────────────────────────────────────────── */

/** Remove `?bet=` from the address bar once it's been handled. */
function stripBetParam(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("bet")) return;
  params.delete("bet");
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}

function Shell({ theme, onToggleTheme, onSignOut, linkedBetId }: {
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  /** `?bet=<id>` deep link (iMessage: Add proof, Check in, Review). */
  linkedBetId: string | null;
}) {
  const { groups, loaded, totalUnread, betGroupIds, upsertBet, openDetails } = useBaamData();
  const [linkError, setLinkError] = useState<string | null>(null);
  const handledLinkRef = useRef<string | null>(null);
  const linkContextRef = useRef({ groups, betGroupIds });
  linkContextRef.current = { groups, betGroupIds };
  const isDesktop = useIsDesktop();
  const [view, setView] = useState<ViewId>("chats");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ betId: string; token: number } | null>(null);
  const needsYou = useMyBets().filter((entry) => entry.bucket === "needs-you").length;

  // Desktop always shows a chat; pick the most recent one if none is open.
  useEffect(() => {
    if (!loaded) return;
    if (groupId && !groups.some((g) => g.id === groupId)) setGroupId(null);
    if (isDesktop && !groupId && groups.length > 0) {
      const latest = [...groups].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
      setGroupId(latest.id);
    }
  }, [loaded, groups, groupId, isDesktop]);

  const openGroup = useCallback((id: string) => {
    setGroupId(id);
    setView("chats");
  }, []);

  const openBetInChat = useCallback((id: string, betId: string) => {
    setGroupId(id);
    setView("chats");
    setFocusRequest((prev) => ({ betId, token: (prev?.token ?? 0) + 1 }));
  }, []);

  // Deep link: load the bet, go to its chat (or Tickets), open its full ticket.
  useEffect(() => {
    if (!linkedBetId || !loaded || handledLinkRef.current === linkedBetId) return;
    handledLinkRef.current = linkedBetId;
    getBet(linkedBetId)
      .then(({ bet }) => {
        upsertBet(bet);
        const id = bet.groupId ?? linkContextRef.current.betGroupIds[bet.id];
        if (id && linkContextRef.current.groups.some((g) => g.id === id)) {
          setGroupId(id);
          setView("chats");
        } else {
          setView("tickets");
        }
        openDetails(bet.id);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "";
        setLinkError(/not found|only participants|forbidden|403|404/i.test(message)
          ? "You can only open bets you're in, or bets from chats you're a member of. Ask a friend to add you to the group."
          : friendlyError(err, "Couldn't open that bet right now. Try again in a minute."));
      })
      .finally(stripBetParam);
  }, [linkedBetId, loaded, upsertBet, openDetails]);

  const goToChats = useCallback(() => setView("chats"), []);
  const badges: Partial<Record<ViewId, { count: number; label: string }>> = {
    chats: { count: totalUnread, label: `${totalUnread} unread messages` },
    tickets: { count: needsYou, label: `${needsYou} bets need you` },
  };

  const chatOpen = view === "chats" && groupId !== null;
  const titles: Record<ViewId, string> = { chats: "Chats", tickets: "Tickets", sports: "Sports", standings: "Standings" };

  const accountMenu = <AccountMenu theme={theme} onToggleTheme={onToggleTheme} onSignOut={onSignOut} compact={!isDesktop} />;

  let main;
  if (view === "chats") {
    if (groupId) {
      main = (
        <ChatView
          key={groupId}
          groupId={groupId}
          onBack={isDesktop ? undefined : () => setGroupId(null)}
          focusRequest={focusRequest}
          onLeft={() => setGroupId(null)}
        />
      );
    } else if (isDesktop) {
      main = (
        <div className="h-full bg-paper px-10 py-8">
          {loaded && groups.length === 0 ? (
            <EmptyState
              title="Start your first group."
              body="Make a group chat, invite your friends, then post a bet."
              action={<NewGroupButton onCreated={openGroup} />}
            />
          ) : (
            <p className="text-label text-ink-soft">Pick a chat.</p>
          )}
        </div>
      );
    } else {
      main = (
        <div className="min-h-full bg-paper">
          <GroupList activeGroupId={null} onSelect={openGroup} />
        </div>
      );
    }
  } else if (view === "tickets") {
    main = <TicketsView onOpenBetChat={openBetInChat} onGoToChats={goToChats} />;
  } else if (view === "sports") {
    main = <SportsView onOpenBetChat={openBetInChat} onGoToChats={goToChats} />;
  } else {
    main = <StandingsView onOpenGroup={openGroup} onGoToChats={goToChats} />;
  }

  return (
    <div className="flex h-dvh min-h-0 bg-counter text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-paper focus:px-4 focus:py-2">
        Skip to content
      </a>

      {/* Desktop left rail */}
      {isDesktop && (
        <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-rule bg-paper">
          <div className="px-6 pb-4 pt-6">
            <Wordmark className="text-[28px] leading-none" />
          </div>
          <nav aria-label="Main" className="px-3">
            <ul className="space-y-0.5">
              {NAV.map(({ id, label, Icon }) => {
                const active = view === id;
                const badge = badges[id];
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => setView(id)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-label transition-colors",
                        active ? "bg-ink/[0.07] font-bold" : "font-medium hover:bg-hover",
                      )}
                    >
                      <Icon size={20} aria-hidden />
                      <span className="flex-1">{label}</span>
                      {badge && <CountBadge count={badge.count} label={badge.label} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-rule pt-3">
            <div className="flex items-center justify-between pb-1 pl-5 pr-3">
              <h2 className="text-meta font-semibold text-ink-soft">Your chats</h2>
              <NewGroupButton onCreated={openGroup} variant="ghost" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-3">
              <GroupList activeGroupId={view === "chats" ? groupId : null} onSelect={openGroup} dense />
            </div>
          </div>
          <div className="flex items-center gap-1 border-t border-rule p-3">
            <div className="min-w-0 flex-1">{accountMenu}</div>
            <NotificationsMenu />
          </div>
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile top bar (hidden inside an open chat, which has its own header) */}
        {!isDesktop && !chatOpen && (
          <header className="flex shrink-0 items-center gap-1 border-b border-rule bg-paper py-2 pl-4 pr-2">
            <ScreenTitle>{titles[view]}</ScreenTitle>
            <div className="ml-auto flex items-center">
              {view === "chats" && <NewGroupButton onCreated={openGroup} variant="ghost" iconOnly />}
              <NotificationsMenu />
              {accountMenu}
            </div>
          </header>
        )}

        <div className="flex min-h-0 flex-1">
          <main id="main" className={cn("min-h-0 min-w-0 flex-1", chatOpen ? "flex flex-col" : "overflow-y-auto")}>
            {main}
          </main>
          {isDesktop && view === "chats" && groupId && (
            <div className="hidden w-[320px] shrink-0 border-l border-rule xl:block">
              <YourTicketsRail onSeeAll={() => setView("tickets")} />
            </div>
          )}
        </div>

        {/* Mobile bottom tab bar */}
        {!isDesktop && (
          <nav aria-label="Main" className="shrink-0 border-t border-rule bg-paper pb-[env(safe-area-inset-bottom)]">
            <ul className="grid grid-cols-4">
              {NAV.map(({ id, label, Icon }) => {
                const active = view === id;
                const badge = badges[id];
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (id === "chats" && view === "chats") setGroupId(null);
                        setView(id);
                      }}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[13px] leading-4",
                        active ? "font-bold text-ink" : "font-medium text-ink-soft",
                      )}
                    >
                      <span className="relative">
                        <Icon size={22} aria-hidden />
                        {badge && badge.count > 0 && (
                          <span className="absolute -right-3 -top-1.5"><CountBadge count={badge.count} label={badge.label} /></span>
                        )}
                      </span>
                      {label}
                      {active && <span className="absolute inset-x-6 top-0 h-[3px] rounded-b-full bg-ink" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>

      <BetOverlays onOpenBetChat={openBetInChat} openChatId={view === "chats" ? groupId : null} />
      <ProfileSheet />
      <Sheet
        open={Boolean(linkError)}
        onOpenChange={(open) => { if (!open) setLinkError(null); }}
        size="sm"
        title="Can't open that bet"
        description={linkError ?? undefined}
        footer={<Button variant="primary" onClick={() => setLinkError(null)}>OK</Button>}
      />
    </div>
  );
}

/* ── Discord linking (behind DISCORD_ENABLED) ───────────────────────────── */

function DiscordLinkScreen({
  status,
  result,
  error,
  username,
  onDismiss,
}: {
  status: "pending" | "done" | "error";
  result: DiscordLinkResult | null;
  error: string | null;
  username: string;
  onDismiss: () => void;
}) {
  const linked = status === "done";
  const failed = status === "error";
  return (
    <AuthLayout aside={false}>
      <div className="rounded-[20px] bg-paper p-6 md:p-8" role="status">
        <h1 className="text-title font-bold wdth-title">
          {linked ? "Discord linked" : failed ? "Couldn't link Discord" : "Linking Discord…"}
        </h1>
        <p className="mt-2 text-body text-ink-soft">
          {linked
            ? `Your account ${result?.username ?? username} is connected.${result?.returnUrl ? " Taking you back to Discord…" : " Head back to Discord and use /bet create."}`
            : failed
              ? error ?? "Run /setup in Discord again to get a fresh link."
              : "Connecting your BAAM account to Discord."}
        </p>
        {linked && result?.returnUrl && (
          <a href={result.returnUrl} className={buttonClass("primary", "md", "mt-6 w-full")}>Return to Discord now</a>
        )}
        {(linked || failed) && (
          <Button variant="secondary" className="mt-3 w-full" onClick={onDismiss}>
            {linked ? "Continue to BAAM" : "Dismiss"}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}

/* ── Root ───────────────────────────────────────────────────────────────── */

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<"signup" | "login">("signup");
  const [discordLinkCode, setDiscordLinkCode] = useState<string | null>(null);
  const [discordLinkStatus, setDiscordLinkStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [discordLinkResult, setDiscordLinkResult] = useState<DiscordLinkResult | null>(null);
  const [discordLinkError, setDiscordLinkError] = useState<string | null>(null);

  const preview = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("preview") : null;
  // Kept in the address bar through sign-in; the shell strips it once handled.
  const [linkedBetId] = useState(() => new URLSearchParams(window.location.search).get("bet")?.trim() || null);

  /* Capture a Discord link code (?discord_link=...) and strip it from the address bar. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("discord_link");
    if (!code) return;
    // Strip stale links even while Discord is disabled, but don't act on them.
    if (DISCORD_ENABLED) setDiscordLinkCode(code);
    params.delete("discord_link");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, []);

  /* Once signed in with a pending link code, attach this account to Discord. */
  useEffect(() => {
    if (!authUser || !discordLinkCode || discordLinkStatus !== "idle") return;
    let alive = true;
    setDiscordLinkStatus("pending");
    setDiscordLinkError(null);
    linkDiscord(discordLinkCode)
      .then((result) => {
        if (!alive) return;
        setDiscordLinkResult(result);
        setDiscordLinkStatus("done");
      })
      .catch((err) => {
        if (!alive) return;
        setDiscordLinkError(friendlyError(err, "Run /setup in Discord again to get a fresh link."));
        setDiscordLinkStatus("error");
      });
    return () => { alive = false; };
  }, [authUser, discordLinkCode]);

  /* On a successful link, briefly confirm, then send the user back to Discord. */
  useEffect(() => {
    if (discordLinkStatus !== "done") return;
    const url = discordLinkResult?.returnUrl;
    if (!url) return;
    const timer = window.setTimeout(() => { window.location.href = url; }, 1800);
    return () => window.clearTimeout(timer);
  }, [discordLinkStatus, discordLinkResult]);

  /* Restore the session from the stored token. */
  useEffect(() => {
    let alive = true;
    let token: string | null = null;
    try { token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY); } catch { token = null; }
    if (!token) {
      setAuthReady(true);
      return () => { alive = false; };
    }
    getCurrentAuthUser()
      .then(({ user }) => { if (alive) setAuthUser(user); })
      .catch(() => {
        if (!alive) return;
        try { window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); } catch { /* ignore */ }
      })
      .finally(() => { if (alive) setAuthReady(true); });
    return () => { alive = false; };
  }, []);

  function handleAuthed(result: AuthResult): void {
    try { window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, result.token); } catch { /* session lasts this tab only */ }
    setAuthUser(result.user);
  }

  function signOut(): void {
    try { window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY); } catch { /* ignore */ }
    setAuthUser(null);
    setAuthMode("login");
  }

  if (TicketPreview && preview === "tickets") {
    return (
      <Suspense fallback={null}>
        <TicketPreview theme={theme} onToggleTheme={toggleTheme} />
      </Suspense>
    );
  }

  if (!authReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-counter">
        <p className="text-label text-ink-soft">Signing you in…</p>
      </main>
    );
  }

  if (!authUser) {
    return <AuthScreen key={authMode} initialMode={authMode} onAuthed={handleAuthed} discordLinking={Boolean(discordLinkCode)} />;
  }

  if (discordLinkCode && discordLinkStatus !== "idle") {
    return (
      <DiscordLinkScreen
        status={discordLinkStatus}
        result={discordLinkResult}
        error={discordLinkError}
        username={authUser.username}
        onDismiss={() => {
          setDiscordLinkCode(null);
          setDiscordLinkStatus("idle");
          setDiscordLinkResult(null);
          setDiscordLinkError(null);
        }}
      />
    );
  }

  return (
    <DataProvider key={authUser.id} user={authUser}>
      <Shell theme={theme} onToggleTheme={toggleTheme} onSignOut={signOut} linkedBetId={linkedBetId} />
    </DataProvider>
  );
}
