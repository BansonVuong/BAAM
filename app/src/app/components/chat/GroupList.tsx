import { useState } from "react";
import { Plus, SquarePen } from "lucide-react";
import { createGroup } from "../../../lib/relayer";
import { formatListTime, friendlyError } from "../../../lib/bets";
import { cn } from "../../../lib/cn";
import { useBaamData } from "../../data";
import { Button, CountBadge, Field, Sheet, TextInput, buttonClass, useFieldId } from "../primitives";

/** The list of group chats, used in the desktop rail and as the mobile Chats screen. */
export function GroupList({
  activeGroupId,
  onSelect,
  dense = false,
}: {
  activeGroupId: string | null;
  onSelect: (groupId: string) => void;
  dense?: boolean;
}) {
  const { groups, loaded, error, unreadByGroup } = useBaamData();
  const sorted = [...groups].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (!loaded) return <p className="px-4 py-3 text-label text-ink-soft">Loading chats…</p>;
  if (error && groups.length === 0) return <p className="px-4 py-3 text-label text-danger" role="alert">{error}</p>;
  if (groups.length === 0) {
    return (
      <div className={cn("px-4 py-3", dense ? "" : "py-8")}>
        <p className="text-label font-semibold">No chats yet.</p>
        <p className="mt-0.5 text-label text-ink-soft">Start a group, then invite friends to bet with.</p>
      </div>
    );
  }

  return (
    <ul className={cn(dense ? "space-y-0.5 px-2" : "divide-y divide-rule")} aria-label="Group chats">
      {sorted.map((group) => {
        const unread = unreadByGroup[group.id] ?? 0;
        const active = group.id === activeGroupId;
        return (
          <li key={group.id}>
            <button
              type="button"
              onClick={() => onSelect(group.id)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex w-full items-start gap-3 text-left transition-colors",
                dense ? "min-h-14 rounded-xl px-3 py-2" : "min-h-16 px-4 py-3",
                active ? "bg-ink/[0.07]" : "hover:bg-hover",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-label", unread > 0 || active ? "font-bold" : "font-semibold")}>
                    {group.name}
                  </span>
                  <span className="shrink-0 text-meta text-ink-soft">{formatListTime(group.updatedAt, group.time)}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  {group.pendingBet && (
                    <span className="inline-block h-2.5 w-4 shrink-0 rounded-[3px] bg-stock-offer ring-1 ring-ink/20" title="Bet waiting for a taker" aria-label="Bet waiting for a taker" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-meta text-ink-soft">{group.lastMsg || `${group.members} members`}</span>
                  <CountBadge count={unread} label={`${unread} unread`} />
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function NewGroupButton({ onCreated, variant = "secondary", className, iconOnly = false }: {
  onCreated: (groupId: string) => void;
  variant?: "secondary" | "ghost";
  className?: string;
  iconOnly?: boolean;
}) {
  const { refresh, upsertGroup } = useBaamData();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useFieldId("group-name");

  async function submit(): Promise<void> {
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const { group } = await createGroup({ name: value });
      upsertGroup(group);
      setOpen(false);
      setName("");
      onCreated(group.id);
      void refresh();
    } catch (err) {
      setError(friendlyError(err, "Couldn't create the group. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setError(null); setOpen(true); }}
        className={buttonClass(variant, iconOnly ? "icon" : "sm", className)}
        aria-label={iconOnly ? "New group" : undefined}
      >
        {iconOnly ? <SquarePen size={20} aria-hidden /> : <><Plus size={18} aria-hidden />New group</>}
      </button>
      <Sheet
        open={open}
        onOpenChange={(next) => { if (!busy) setOpen(next); }}
        size="sm"
        title="New group"
        description="A private chat. Only people you invite can see it."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" form="new-group-form" disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create group"}
            </Button>
          </>
        )}
      >
        <form id="new-group-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <Field label="Group name" htmlFor={fieldId} error={error}>
            <TextInput
              id={fieldId}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Gym rats"
              maxLength={60}
              disabled={busy}
            />
          </Field>
        </form>
      </Sheet>
    </>
  );
}
