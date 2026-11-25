import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Ellipsis, LogOut, SendHorizontal, Ticket as TicketIcon, UserPlus, Archive } from "lucide-react";
import {
  addGroupMemberByUsername,
  createBet,
  createCheckinBet,
  getMessages,
  leaveGroup,
  postMessage,
  type Bet,
  type ChatMessage,
} from "../../../lib/relayer";
import { formatClock, friendlyError, isBetCompleted, sameName } from "../../../lib/bets";
import { cn } from "../../../lib/cn";
import { useBaamData } from "../../data";
import {
  Button,
  EmptyState,
  Field,
  InlineError,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Sheet,
  TextInput,
  buttonClass,
  useFieldId,
} from "../primitives";
import { BetTicket } from "../ticket/BetTicket";
import { useBetActions } from "../ticket/useBetActions";
import { NewBetSheet, type NewBet } from "../NewBetSheet";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

type Row =
  | { kind: "text"; message: ChatMessage; showName: boolean }
  | { kind: "bet"; message: ChatMessage; bet: Bet | undefined }
  | { kind: "system"; message: ChatMessage };

function buildRows(messages: ChatMessage[], betsById: Record<string, Bet>): Row[] {
  const rows: Row[] = [];
  let previous: ChatMessage | null = null;
  for (const message of messages) {
    if (message.betId) {
      rows.push({ kind: "bet", message, bet: betsById[message.betId] });
      previous = null;
      continue;
    }
    if (message.system) {
      rows.push({ kind: "system", message });
      previous = null;
      continue;
    }
    const continues = previous !== null
      && sameName(previous.sender, message.sender)
      && typeof previous.createdAt === "number"
      && typeof message.createdAt === "number"
      && message.createdAt - previous.createdAt < GROUP_WINDOW_MS;
    rows.push({ kind: "text", message, showName: !continues });
    previous = message;
  }
  return rows;
}

type GroupDialog = "invite" | "leave" | "settled" | null;

/** A sender's name; tapping it opens their record. */
function SenderName({ name, self, onOpen }: { name: string; self: boolean; onOpen?: (name: string) => void }) {
  if (!onOpen) return <span className="font-semibold">{self ? "You" : name}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(name)}
      className="rounded-sm font-semibold hover:underline hover:underline-offset-4"
      aria-label={self ? "Your record" : `See ${name}'s record`}
    >
      {self ? "You" : name}
    </button>
  );
}

export function ChatView({
  groupId,
  onBack,
  focusRequest,
  onLeft,
}: {
  groupId: string;
  onBack?: () => void;
  focusRequest?: { betId: string; token: number } | null;
  onLeft: () => void;
}) {
  const {
    user, groups, bets, setOpenGroupId, markGroupRead, refresh, refreshPoints, upsertGroup, openProfile, openDetails,
  } = useBaamData();
  const group = groups.find((g) => g.id === groupId) ?? null;
  const { handlers, dialogs: betDialogs } = useBetActions();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [betSheetOpen, setBetSheetOpen] = useState(false);
  const [dialog, setDialog] = useState<GroupDialog>(null);
  const [inviteName, setInviteName] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const [highlightedBetId, setHighlightedBetId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const pendingFocusRef = useRef<string | null>(null);
  const handledFocusTokenRef = useRef<number | null>(null);
  const inviteId = useFieldId("invite");

  const betsById = useMemo(
    () => Object.fromEntries(bets.map((bet) => [bet.id, bet])) as Record<string, Bet>,
    [bets],
  );
  const rows = useMemo(() => buildRows(messages, betsById), [messages, betsById]);
  const chatBets = useMemo(() => {
    const ids = new Set(messages.map((m) => m.betId).filter((id): id is string => Boolean(id)));
    return [...ids].map((id) => betsById[id]).filter((bet): bet is Bet => Boolean(bet));
  }, [messages, betsById]);
  const openBetCount = chatBets.filter((bet) => !isBetCompleted(bet)).length;
  const settledBets = chatBets.filter((bet) => isBetCompleted(bet));

  const otherMembers = useMemo(
    () => (group?.memberUsernames ?? []).filter((name) => !sameName(name, user.username)),
    [group?.memberUsernames, user.username],
  );

  // Messages for the open chat, polled. Mark the chat read while it's open.
  useEffect(() => {
    let alive = true;
    setMessages([]);
    setMessagesLoaded(false);
    setMessagesError(null);
    nearBottomRef.current = true;
    setOpenGroupId(groupId);

    async function load(): Promise<void> {
      try {
        const { messages: next } = await getMessages(groupId);
        if (!alive) return;
        setMessages(next);
        setMessagesError(null);
        const latest = next.reduce((max, m) => Math.max(max, m.createdAt ?? 0), Date.now());
        markGroupRead(groupId, latest);
      } catch (err) {
        if (!alive) return;
        setMessagesError(friendlyError(err, "Couldn't load messages. Retrying…"));
      } finally {
        if (alive) setMessagesLoaded(true);
      }
    }
    void load();
    const interval = window.setInterval(() => { void load(); }, 2000);
    return () => {
      alive = false;
      window.clearInterval(interval);
      setOpenGroupId(null);
    };
  }, [groupId, setOpenGroupId, markGroupRead]);

  // Keep the view pinned to the newest message unless the reader scrolled up.
  useEffect(() => {
    const node = listRef.current;
    if (!node || pendingFocusRef.current) return;
    if (nearBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [rows.length, groupId]);

  // "Open in chat" from elsewhere: scroll to the bet and flash it.
  useEffect(() => {
    if (!focusRequest || handledFocusTokenRef.current === focusRequest.token) return;
    handledFocusTokenRef.current = focusRequest.token;
    pendingFocusRef.current = focusRequest.betId;
  }, [focusRequest]);

  useEffect(() => {
    const targetId = pendingFocusRef.current;
    if (!targetId || !messages.some((m) => m.betId === targetId)) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-bet-id="${CSS.escape(targetId)}"]`);
    if (!node) return;
    pendingFocusRef.current = null;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    setHighlightedBetId(targetId);
    const timer = window.setTimeout(() => setHighlightedBetId((id) => (id === targetId ? null : id)), 1800);
    return () => window.clearTimeout(timer);
  }, [messages]);

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await postMessage({ groupId, text });
      setDraft("");
      nearBottomRef.current = true;
      const { messages: next } = await getMessages(groupId);
      setMessages(next);
      void refresh();
    } catch (err) {
      setSendError(friendlyError(err, "Couldn't send. Try again."));
    } finally {
      setSending(false);
    }
  }

  async function postBet(bet: NewBet): Promise<void> {
    if (!group) throw new Error("This chat isn't available anymore.");
    const acceptor = otherMembers.find((name) => sameName(name, bet.acceptor)) ?? "anyone";
    const common = {
      groupId,
      type: bet.type,
      acceptor,
      terms: bet.terms.trim(),
      stake: bet.stake.trim(),
      currency: bet.currency,
      minBettors: 2,
    };
    if (bet.habit) {
      await createCheckinBet({
        ...common,
        witnesses: bet.witnesses,
        acceptByDate: bet.acceptByDate ?? null,
        fallbackKind: bet.fallbackKind,
        schedule: bet.habit.schedule,
        requiredCheckins: bet.habit.requiredCheckins,
        doer: bet.habit.doer,
      });
    } else await createBet({
      ...common,
      ...(bet.sport
        ? {
            // Kept for parity with older clients; sports bets don't use witnesses.
            witnesses: Math.max(2, Math.ceil(group.members / 2)),
            sport: bet.sport,
            gameId: bet.gameId,
            backsHome: bet.backsHome,
            homeTeam: bet.homeTeam,
            awayTeam: bet.awayTeam,
          }
        : {
            witnesses: bet.witnesses,
            resolveByDate: bet.resolveByDate,
            acceptByDate: bet.acceptByDate ?? null,
            fallbackKind: bet.fallbackKind,
            charityName: bet.charityName,
            charityAddress: bet.charityAddress,
          }),
    });
    nearBottomRef.current = true;
    const { messages: next } = await getMessages(groupId);
    setMessages(next);
    void refresh();
    void refreshPoints();
  }

  function openDialog(next: GroupDialog): void {
    setDialogError(null);
    setInviteResult(null);
    setInviteName("");
    setDialog(next);
  }

  async function invite(): Promise<void> {
    const name = inviteName.trim().replace(/^@/, "");
    if (!name) return;
    setDialogBusy(true);
    setDialogError(null);
    setInviteResult(null);
    try {
      const result = await addGroupMemberByUsername(groupId, name);
      upsertGroup(result.group);
      setInviteResult(result.alreadyMember
        ? `${result.addedUsername} is already in ${result.group.name}.`
        : `Added ${result.addedUsername}. They can see ${result.group.name} now.`);
      setInviteName("");
    } catch (err) {
      setDialogError(friendlyError(err, "Couldn't add them. Check the username and try again."));
    } finally {
      setDialogBusy(false);
    }
  }

  async function leave(): Promise<void> {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await leaveGroup(groupId);
      await refresh();
      setDialog(null);
      onLeft();
    } catch (err) {
      setDialogError(friendlyError(err, "Couldn't leave the group. Try again."));
    } finally {
      setDialogBusy(false);
    }
  }

  const subtitle = group
    ? [
        `${group.members} ${group.members === 1 ? "member" : "members"}`,
        openBetCount > 0 ? `${openBetCount} open ${openBetCount === 1 ? "bet" : "bets"}` : null,
      ].filter(Boolean).join(", ")
    : "";

  return (
    <section className="flex h-full min-h-0 flex-col bg-paper" aria-labelledby="chat-title">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-1 border-b border-rule px-2 py-2 lg:px-6 lg:py-3">
        {onBack && (
          <button type="button" onClick={onBack} className={buttonClass("ghost", "icon", "lg:hidden")} aria-label="Back to chats">
            <ChevronLeft size={24} aria-hidden />
          </button>
        )}
        <div className="min-w-0 flex-1 px-1">
          <h1 id="chat-title" className="truncate text-[19px] font-bold leading-[26px] wdth-title lg:text-title">
            {group?.name ?? "Chat"}
          </h1>
          {subtitle && <p className="truncate text-meta text-ink-soft">{subtitle}</p>}
        </div>
        <MenuRoot>
          <MenuTrigger className={buttonClass("ghost", "icon")} aria-label="Group options">
            <Ellipsis size={22} aria-hidden />
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => openDialog("invite")}><UserPlus size={18} aria-hidden />Invite friends</MenuItem>
            <MenuItem onSelect={() => openDialog("settled")}>
              <Archive size={18} aria-hidden />
              Settled bets{settledBets.length > 0 ? ` (${settledBets.length})` : ""}
            </MenuItem>
            <MenuSeparator />
            <MenuItem destructive onSelect={() => openDialog("leave")}><LogOut size={18} aria-hidden />Leave group</MenuItem>
          </MenuContent>
        </MenuRoot>
      </header>

      {/* Messages */}
      <div
        ref={listRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-label={`Messages in ${group?.name ?? "this chat"}`}
      >
        <div className="max-w-[760px] px-4 py-4 lg:px-6 lg:py-6">
          {messagesLoaded && rows.length === 0 && !messagesError && (
            <EmptyState
              title="No bets in this chat yet."
              body="Say hi, or start one with New bet."
              action={<Button variant="primary" onClick={() => setBetSheetOpen(true)}>New bet</Button>}
            />
          )}
          {messagesError && <div className="py-2"><InlineError>{messagesError}</InlineError></div>}
          {!messagesLoaded && <p className="py-6 text-label text-ink-soft">Loading messages…</p>}
          <ol className="space-y-0.5">
            {rows.map((row, index) => {
              const time = formatClock(row.message.createdAt, row.message.ts);
              if (row.kind === "bet") {
                const poster = row.bet ? row.bet.challenger : "Someone";
                return (
                  <li key={row.message.id} data-bet-id={row.message.betId} className="py-3 first:pt-0">
                    <p className="mb-2 text-label">
                      <SenderName name={poster} self={sameName(poster, user.username)} onOpen={row.bet ? openProfile : undefined} />
                      <span className="text-ink-soft"> posted a bet</span>
                      <time className="ml-2 text-meta text-ink-soft">{time}</time>
                    </p>
                    <div className="max-w-[520px]">
                      {row.bet ? (
                        <BetTicket
                          bet={row.bet}
                          viewer={user.username}
                          handlers={handlers}
                          highlighted={highlightedBetId === row.bet.id}
                          onOpen={() => openDetails(row.bet!.id)}
                          openLabel={`Open bet: ${row.bet.terms}`}
                        />
                      ) : (
                        <p className="text-label text-ink-soft">Loading bet…</p>
                      )}
                    </div>
                  </li>
                );
              }
              if (row.kind === "system") {
                return (
                  <li key={row.message.id} className="py-2 text-meta text-ink-soft">
                    {row.message.text} <time className="ml-1">{time}</time>
                  </li>
                );
              }
              const mine = sameName(row.message.sender, user.username);
              return (
                <Fragment key={row.message.id}>
                  <li className={cn(row.showName && index > 0 && "pt-3")}>
                    {row.showName && (
                      <p className="text-label">
                        <SenderName name={row.message.sender} self={mine} onOpen={openProfile} />
                        <time className="ml-2 text-meta text-ink-soft">{time}</time>
                      </p>
                    )}
                    <p className="max-w-[68ch] whitespace-pre-wrap break-words text-body">{row.message.text}</p>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-rule px-3 py-2.5 lg:px-6 lg:py-3">
        <form
          className="flex max-w-[760px] items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); void send(); }}
        >
          <Button variant="secondary" onClick={() => setBetSheetOpen(true)} disabled={!group} className="px-4">
            <TicketIcon size={18} aria-hidden className="text-ink" />
            New bet
          </Button>
          <label htmlFor="chat-draft" className="sr-only">Message</label>
          <TextInput
            id="chat-draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message…"
            autoComplete="off"
            disabled={!group}
            className="min-h-11 flex-1 rounded-full bg-counter/60 px-4"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className={buttonClass(draft.trim() ? "primary" : "ghost", "icon")}
            aria-label="Send message"
          >
            <SendHorizontal size={20} aria-hidden />
          </button>
        </form>
        {sendError && <div className="mt-1.5 max-w-[760px]"><InlineError>{sendError}</InlineError></div>}
      </div>

      <NewBetSheet
        open={betSheetOpen}
        onOpenChange={setBetSheetOpen}
        groupName={group?.name ?? "this chat"}
        members={otherMembers}
        memberCount={group?.members ?? 1}
        viewer={user.username}
        onSubmit={postBet}
      />

      <Sheet
        open={dialog === "invite"}
        onOpenChange={(open) => { if (!open && !dialogBusy) setDialog(null); }}
        size="sm"
        title="Invite friends"
        description={`Add someone to ${group?.name ?? "this group"} by their BAAM username.`}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={dialogBusy}>Done</Button>
            <Button variant="primary" type="submit" form="invite-form" disabled={!inviteName.trim() || dialogBusy}>
              {dialogBusy ? "Adding…" : "Add"}
            </Button>
          </>
        )}
      >
        <form id="invite-form" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
          <Field label="Username" htmlFor={inviteId} error={dialogError} hint={inviteResult ?? undefined}>
            <TextInput
              id={inviteId}
              autoFocus
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="maya"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={dialogBusy}
            />
          </Field>
        </form>
      </Sheet>

      <Sheet
        open={dialog === "leave"}
        onOpenChange={(open) => { if (!open && !dialogBusy) setDialog(null); }}
        size="sm"
        title={`Leave ${group?.name ?? "this group"}?`}
        description="You'll lose the chat and its history until someone adds you back. Bets you're in keep going."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={dialogBusy}>Cancel</Button>
            <Button variant="destructive" onClick={() => { void leave(); }} disabled={dialogBusy}>
              {dialogBusy ? "Leaving…" : "Leave group"}
            </Button>
          </>
        )}
      >
        {dialogError && <InlineError>{dialogError}</InlineError>}
      </Sheet>

      <Sheet
        open={dialog === "settled"}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        size="md"
        title="Settled bets"
        description={group ? `Everything that's finished in ${group.name}.` : undefined}
      >
        {settledBets.length === 0 ? (
          <p className="text-label text-ink-soft">Nothing has settled here yet.</p>
        ) : (
          <ul className="space-y-3 pt-1">
            {settledBets.map((bet) => (
              <li key={bet.id}>
                <BetTicket
                  bet={bet}
                  viewer={user.username}
                  variant="compact"
                  onOpen={() => { setDialog(null); openDetails(bet.id); }}
                />
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      {betDialogs}
    </section>
  );
}
