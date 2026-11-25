import { useEffect, useState } from "react";
import { Bell, Coins, Copy, Info, LogOut, Moon, Sun, Trophy } from "lucide-react";
import { PointsSheet } from "./PointsSheet";
import { getProfileSummary, RELAYER_URL, type ProfileSummary } from "../../../lib/relayer";
import { useRelayerHealth } from "../../../lib/useRelayer";
import { formatAmount } from "../../../lib/bets";
import { cn } from "../../../lib/cn";
import { useBaamData } from "../../data";
import {
  Initials,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Sheet,
  buttonClass,
} from "../primitives";

export type Theme = "light" | "dark";

function shorten(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function AboutDetails() {
  const { connected, loading, health } = useRelayerHealth(5000);
  const rows: [string, string][] = [
    ["Network", "Solana devnet (test money only)"],
    ["Server", loading ? "Checking…" : connected ? "Connected" : "Can't reach the server right now"],
    ["Block height", health ? health.slot.toLocaleString() : "—"],
    ["Oracle", health ? shorten(health.oracle) : "—"],
    ["Program", health ? shorten(health.program) : "—"],
    ["Server address", RELAYER_URL.replace(/^https?:\/\//, "")],
  ];
  return (
    <div className="space-y-5">
      <p className="text-body">
        BAAM turns a group chat argument into a bet. Post it, a friend accepts, witnesses in the
        group vote on who won, and the stakes go to the winner.
      </p>
      <dl className="divide-y divide-rule rounded-2xl border border-rule">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-label text-ink-soft">{label}</dt>
            <dd className="text-right text-label font-medium tabular-nums">{value}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 px-4 py-3">
          <dt className="text-label text-ink-soft">Build</dt>
          <dd className="text-label font-medium">
            <a
              className="underline underline-offset-4"
              href={`https://github.com/BansonVuong/solana-BAAM/commit/${__GIT_COMMIT__}`}
              target="_blank"
              rel="noreferrer"
            >
              {__GIT_COMMIT__}
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function AccountMenu({
  theme,
  onToggleTheme,
  onSignOut,
  compact = false,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  /** Avatar only (mobile header) instead of avatar + name (desktop rail). */
  compact?: boolean;
}) {
  const { user, points, pointsEnabled, solEnabled, refreshPoints, openProfile } = useBaamData();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pointsOpen, setPointsOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  function loadProfile(): void {
    setProfileFailed(false);
    getProfileSummary()
      .then(setProfile)
      .catch(() => setProfileFailed(true));
  }

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyWallet(event: Event): Promise<void> {
    event.preventDefault();
    if (!profile?.wallet || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(profile.wallet);
      setCopied(true);
    } catch {
      // Clipboard permission denied; nothing else to do.
    }
  }

  return (
    <>
      <MenuRoot onOpenChange={(open) => { if (open) { loadProfile(); void refreshPoints(); } }}>
        <MenuTrigger
          className={cn(
            compact
              ? buttonClass("ghost", "icon")
              : "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl px-2 text-left hover:bg-hover",
          )}
          aria-label="Account"
        >
          <Initials name={user.username} initials={user.initials} size="sm" />
          {!compact && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-semibold">{user.username}</span>
              <span className="block truncate text-meta text-ink-soft">Account and settings</span>
            </span>
          )}
        </MenuTrigger>
        <MenuContent align={compact ? "end" : "start"} side={compact ? "bottom" : "top"}>
          <div className="px-3 pb-2 pt-2">
            <p className="text-label font-semibold">{profile?.name ?? user.username}</p>
            <p className="truncate text-meta text-ink-soft">{user.email}</p>
            {pointsEnabled && (
              <p className="mt-2 text-label">
                {points
                  ? <><span className="font-extrabold wdth-condensed text-[22px] tabular-nums">{points.balance.toLocaleString()}</span> pts</>
                  : <span className="text-ink-soft">Loading points…</span>}
              </p>
            )}
            {solEnabled && (
              <p className={pointsEnabled ? "text-label" : "mt-2 text-label"}>
                {profile
                  ? <><span className="font-extrabold wdth-condensed text-[22px] tabular-nums">{formatAmount(profile.solBalance, "SOL")}</span> SOL in your wallet</>
                  : profileFailed ? <span className="text-ink-soft">SOL balance unavailable</span>
                  : <span className="text-ink-soft">Loading balance…</span>}
              </p>
            )}
          </div>
          <MenuSeparator />
          {pointsEnabled && (
            <MenuItem onSelect={() => setPointsOpen(true)}>
              <Coins size={18} aria-hidden />
              Points
            </MenuItem>
          )}
          <MenuItem onSelect={() => openProfile(user.username)}>
            <Trophy size={18} aria-hidden />
            Your record
          </MenuItem>
          {solEnabled && (
            <MenuItem onSelect={(event) => { void copyWallet(event); }} disabled={!profile?.wallet}>
              <Copy size={18} aria-hidden />
              {copied ? "Copied" : "Copy wallet address"}
            </MenuItem>
          )}
          <MenuItem onSelect={(event) => { event.preventDefault(); onToggleTheme(); }}>
            {theme === "dark" ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </MenuItem>
          <MenuItem onSelect={() => setAboutOpen(true)}>
            <Info size={18} aria-hidden />
            About BAAM
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={onSignOut}>
            <LogOut size={18} aria-hidden />
            Sign out
          </MenuItem>
        </MenuContent>
      </MenuRoot>
      <Sheet open={aboutOpen} onOpenChange={setAboutOpen} size="sm" title="About BAAM">
        {aboutOpen && <AboutDetails />}
      </Sheet>
      <PointsSheet open={pointsOpen} onOpenChange={setPointsOpen} />
    </>
  );
}

export function NotificationsMenu() {
  const { notifications, unreadNotifications, markNotificationsRead } = useBaamData();
  return (
    <MenuRoot onOpenChange={(open) => { if (open) markNotificationsRead(); }}>
      <MenuTrigger
        className={cn(buttonClass("ghost", "icon"), "relative")}
        aria-label={unreadNotifications > 0 ? `Notifications, ${unreadNotifications} new` : "Notifications"}
      >
        <Bell size={20} aria-hidden />
        {unreadNotifications > 0 && (
          <span className="absolute right-2.5 top-2.5 size-2.5 rounded-full bg-stamp-win ring-2 ring-paper" aria-hidden />
        )}
      </MenuTrigger>
      <MenuContent className="w-80">
        <MenuLabel>Notifications</MenuLabel>
        {notifications.length === 0 ? (
          <p className="px-3 pb-3 text-label text-ink-soft">Nothing new. You'll see it here when someone adds you to a group.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto pb-1">
            {notifications.map((entry) => (
              <li key={`${entry.groupId}-${entry.type}`} className="px-3 py-2">
                <p className="text-label">
                  {entry.type === "left" ? `You left ${entry.groupName}` : `You were added to ${entry.groupName}`}
                </p>
                <p className="text-meta text-ink-soft">
                  {new Date(entry.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </MenuContent>
    </MenuRoot>
  );
}

