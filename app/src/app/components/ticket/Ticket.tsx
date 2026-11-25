import { useEffect, useRef, useState } from "react";
import { CircleCheck, ExternalLink, Gavel, Hourglass, Image as ImageIcon, Lock } from "lucide-react";
import { cn } from "../../../lib/cn";
import "./ticket.css";

/* ── Public API ─────────────────────────────────────────────────────────── */

/** Stock color = state. */
export type TicketStock = "offer" | "live" | "verdict" | "done";
export type TicketCurrency = "SOL" | "PTS";

export interface TicketStamp {
  /** Rendered uppercase, e.g. "Paid to jordan", "Refunded", "Expired", "Void". */
  text: string;
  /** "win" = red PAID/WON ink; "neutral" = blue REFUNDED/VOID ink. */
  tone: "win" | "neutral";
}

export interface TicketAction {
  label: string;
  onClick?: () => void;
  /** External link instead of a button (opens in a new tab). */
  href?: string;
  /** "primary" renders as a filled ink pill; everything else is a text button. */
  emphasis?: "primary" | "plain";
  disabled?: boolean;
  /** Marks a toggle-like choice that's currently selected (e.g. your vote). */
  pressed?: boolean;
}

/** Slot for photo/link proof: a thumbnail plus a count. */
export interface TicketProof {
  href?: string;
  thumbnailUrl?: string;
  /** Alt text for the thumbnail: the caption, or "Proof from <user>". */
  thumbnailAlt?: string;
  /** Defaults to "View proof". */
  label?: string;
  /** Opens the full ticket (proof gallery) instead of following `href`. */
  onOpen?: () => void;
}

/** Slot for recurring check-ins, e.g. 3 of 5 days done. */
export interface TicketCheckIn {
  done: number;
  total: number;
  /** Defaults to "{done} of {total} days done". */
  label?: string;
  /** Opens the full ticket (the day-by-day strip). */
  onOpen?: () => void;
  openLabel?: string;
}

export interface TicketLink {
  label: string;
  href: string;
}

export interface TicketProps {
  /** Stable id (the bet id). Lets the stamp land once per ticket, not on every render. */
  id?: string;
  variant?: "full" | "compact";
  stock: TicketStock;
  /** The bet in the bettor's words. */
  terms: string;
  /** Stake numerals only, e.g. "0.25" or "500". */
  stake: string;
  currency: TicketCurrency;
  /** Small context above the terms, e.g. the group name in lists. */
  context?: string;
  /** "jordan vs maya". */
  parties?: string;
  /** Names inside `parties` that open that person's record when tapped. */
  people?: string[];
  onOpenPerson?: (name: string) => void;
  /** Plain-word detail lines: witnesses, deadlines, fallback. */
  details?: string[];
  /** One status line in plain words: "Waiting for maya to accept". */
  status: string;
  /** Terminal states only: PAID TO JORDAN, REFUNDED, EXPIRED, VOID. */
  stamp?: TicketStamp | null;
  /** Stock the ticket had before it settled; the settle fade starts here. */
  settledFrom?: Exclude<TicketStock, "done">;
  proof?: TicketProof;
  checkIn?: TicketCheckIn;
  /** Text-button actions at the bottom of the body: Accept, Vote, Add proof. */
  actions?: TicketAction[];
  /** Explorer links (on-chain SOL tickets only; ignored for PTS). */
  links?: TicketLink[];
  /** Replaces the actions row while a request is in flight, e.g. "Accepting…". */
  busyLabel?: string | null;
  /** Compact: the whole ticket becomes a button. Full: the terms become a button. */
  onOpen?: () => void;
  openLabel?: string;
  highlighted?: boolean;
  className?: string;
}

/* ── Stamp landing ──────────────────────────────────────────────────────── */

const LANDED_KEY = "BAAM_landed_stamps";

function readLanded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(LANDED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function markLanded(key: string): void {
  try {
    const next = [...readLanded(), key].slice(-400);
    window.localStorage.setItem(LANDED_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the stamp simply lands again next time.
  }
}

type LandPhase = "static" | "pending" | "landing";

/**
 * The stamp lands when a ticket reaches a terminal state while visible, or the
 * first time it is seen after settling. Reduced motion is handled in CSS.
 */
function useStampLanding(id: string | undefined, stampText: string | null) {
  const ref = useRef<HTMLElement>(null);
  const previous = useRef<string | null | undefined>(undefined);
  const [phase, setPhase] = useState<LandPhase>("static");

  useEffect(() => {
    const first = previous.current === undefined;
    const changed = previous.current !== stampText;
    previous.current = stampText;
    if (!stampText || !changed || !id) {
      if (!stampText) setPhase("static");
      return;
    }
    const key = `${id}:${stampText}`;
    if (first && readLanded().has(key)) {
      setPhase("static");
      return;
    }
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      markLanded(key);
      setPhase("landing");
      return;
    }
    setPhase("pending");
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      markLanded(key);
      setPhase("landing");
    }, { threshold: 0.6 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, stampText]);

  return { ref, phase };
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function StateIcon({ stock, size }: { stock: TicketStock; size: number }) {
  const props = { size, strokeWidth: 2.25, "aria-hidden": true } as const;
  if (stock === "offer") return <Hourglass {...props} />;
  if (stock === "live") return <Lock {...props} />;
  if (stock === "verdict") return <Gavel {...props} />;
  return <CircleCheck {...props} />;
}

function Stamp({ stamp, compact }: { stamp: TicketStamp; compact: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ticket-stamp pointer-events-none absolute z-10 inline-block rounded-[5px] border-[3px] border-current font-black uppercase wdth-wide tracking-[0.04em] whitespace-nowrap",
        compact
          ? "right-2 top-1/2 -mt-3 border-2 px-1.5 py-1 text-[13px] leading-[13px]"
          : "right-3 top-1/2 -mt-5 px-2.5 py-2 text-stamp",
        stamp.tone === "win" ? "text-stamp-win" : "text-stamp-neutral",
      )}
    >
      {stamp.text}
    </span>
  );
}

function CheckInProgress({ checkIn }: { checkIn: TicketCheckIn }) {
  const total = Math.max(1, Math.floor(checkIn.total));
  const done = Math.min(total, Math.max(0, Math.floor(checkIn.done)));
  const label = checkIn.label ?? `${done} of ${total} days done`;
  const bar = (
    <span className="flex gap-1" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2 flex-1 rounded-full",
            index < done ? "bg-ticket-ink" : "bg-ticket-ink/15",
          )}
        />
      ))}
    </span>
  );
  if (checkIn.onOpen) {
    return (
      <button
        type="button"
        onClick={checkIn.onOpen}
        className="group mt-3 block w-full rounded-md text-left"
        aria-label={checkIn.openLabel ? `${label}. ${checkIn.openLabel}` : label}
      >
        {bar}
        <span className="mt-1.5 block text-meta text-ticket-ink-soft">
          {label}
          {checkIn.openLabel && (
            <span className="ml-2 font-semibold text-ticket-ink underline decoration-ticket-ink/35 underline-offset-4 group-hover:decoration-ticket-ink">
              {checkIn.openLabel}
            </span>
          )}
        </span>
      </button>
    );
  }
  return (
    <div className="mt-3">
      {bar}
      <p className="mt-1.5 text-meta text-ticket-ink-soft">{label}</p>
    </div>
  );
}

function ProofSlot({ proof }: { proof: TicketProof }) {
  const label = proof.label ?? "View proof";
  const body = (
    <>
      {proof.thumbnailUrl ? (
        <img
          src={proof.thumbnailUrl}
          alt={proof.thumbnailAlt ?? ""}
          className="size-12 rounded-md object-cover ring-1 ring-ticket-ink/15"
        />
      ) : (
        <span className="flex size-12 items-center justify-center rounded-md bg-ticket-ink/10">
          <ImageIcon size={18} aria-hidden />
        </span>
      )}
      <span className="text-label font-semibold underline decoration-ticket-ink/40 underline-offset-4">{label}</span>
    </>
  );
  if (proof.onOpen) {
    return (
      <button type="button" onClick={proof.onOpen} className="mt-3 flex w-fit items-center gap-3 rounded-md text-left">
        {body}
      </button>
    );
  }
  if (!proof.href) return <div className="mt-3 flex items-center gap-3">{body}</div>;
  return (
    <a href={proof.href} target="_blank" rel="noreferrer" className="mt-3 flex w-fit items-center gap-3 rounded-md">
      {body}
    </a>
  );
}

function ActionButton({ action }: { action: TicketAction }) {
  const primary = action.emphasis === "primary";
  const className = cn(
    "inline-flex min-h-11 items-center gap-1.5 rounded-full text-label font-semibold transition-colors md:min-h-9",
    primary
      ? "bg-ticket-ink px-4 text-ticket-paper hover:bg-ticket-ink/85"
      : "-mx-1 px-2 underline decoration-ticket-ink/35 decoration-2 underline-offset-4 hover:bg-ticket-ink/8 hover:decoration-ticket-ink",
    action.pressed && !primary && "bg-ticket-ink/10 no-underline",
    action.disabled && !action.pressed && "cursor-not-allowed opacity-55 hover:bg-transparent",
    action.disabled && action.pressed && "cursor-default",
  );
  if (action.href) {
    return (
      <a href={action.href} target="_blank" rel="noreferrer" className={className}>
        {action.label}
        <ExternalLink size={13} aria-hidden />
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={action.onClick}
      disabled={action.disabled}
      aria-pressed={action.pressed}
    >
      {action.label}
    </button>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split "jordan vs maya" into plain text and tappable names. */
export function splitParties(parties: string, people: string[]): { text: string; person?: string }[] {
  const names = [...new Set(people.filter((name) => {
    const key = name.trim().toLowerCase();
    return key && key !== "you" && key !== "anyone";
  }))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ text: parties }];
  const pattern = new RegExp(`(^|[^\\w])(${names.map(escapeRegExp).join("|")})(?=$|[^\\w])`, "g");
  const out: { text: string; person?: string }[] = [];
  let last = 0;
  for (const match of parties.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1]!.length;
    if (start > last) out.push({ text: parties.slice(last, start) });
    out.push({ text: match[2]!, person: match[2]! });
    last = start + match[2]!.length;
  }
  if (last < parties.length) out.push({ text: parties.slice(last) });
  return out;
}

function Parties({ parties, people, onOpenPerson }: {
  parties: string;
  people?: string[];
  onOpenPerson?: (name: string) => void;
}) {
  if (!onOpenPerson || !people?.length) return <p className="mt-2 text-label font-medium">{parties}</p>;
  return (
    <p className="mt-2 text-label font-medium">
      {splitParties(parties, people).map((part, index) => (part.person ? (
        <button
          key={index}
          type="button"
          onClick={() => onOpenPerson(part.person!)}
          className="rounded-sm underline decoration-ticket-ink/30 underline-offset-4 hover:decoration-ticket-ink"
          aria-label={`See ${part.person}'s record`}
        >
          {part.text}
        </button>
      ) : <span key={index}>{part.text}</span>))}
    </p>
  );
}

function stakeSizeClass(stake: string, compact: boolean): string {
  const length = stake.replace(/[^\d.]/g, "").length;
  if (compact) return length > 5 ? "text-[22px] leading-[22px]" : "text-[28px] leading-[28px]";
  if (length > 6) return "text-[28px] leading-[28px]";
  if (length > 4) return "text-[34px] leading-[34px]";
  return "text-stake";
}

/* ── Ticket ─────────────────────────────────────────────────────────────── */

export function Ticket({
  id,
  variant = "full",
  stock,
  terms,
  stake,
  currency,
  context,
  parties,
  people,
  onOpenPerson,
  details,
  status,
  stamp,
  settledFrom,
  proof,
  checkIn,
  actions,
  links,
  busyLabel,
  onOpen,
  openLabel,
  highlighted,
  className,
}: TicketProps) {
  const compact = variant === "compact";
  const { ref, phase } = useStampLanding(id, stamp ? stamp.text : null);
  const shownLinks = currency === "SOL" ? links ?? [] : [];
  const visibleActions = actions?.filter(Boolean) ?? [];

  const stub = (
    <div className="ticket-stub relative flex shrink-0 flex-col items-center justify-between gap-2 px-2 py-4 text-center">
      <span className="ticket-perf" aria-hidden />
      <div className="flex flex-col items-center">
        <span className={cn("font-extrabold wdth-condensed tabular-nums tracking-tight", stakeSizeClass(stake, compact))}>
          {stake || "0"}
        </span>
        <span className={cn("mt-1 font-semibold", compact ? "text-[13px] leading-4" : "text-label")}>{currency}</span>
      </div>
      {!compact && (
        <span className="flex size-9 items-center justify-center rounded-full bg-ticket-ink/10">
          <StateIcon stock={stock} size={17} />
        </span>
      )}
    </div>
  );

  if (compact) {
    const inner = (
      <div className="ticket-paper flex min-h-16 text-left">
        <div className="relative min-w-0 flex-1 px-3.5 py-2.5">
          {context && <p className="truncate text-meta text-ticket-ink-soft">{context}</p>}
          <p className="truncate text-label font-semibold">{terms}</p>
          <p className={cn("truncate text-meta text-ticket-ink-soft", stamp && "pr-20")}>{status}</p>
          {stamp && <Stamp stamp={stamp} compact />}
        </div>
        {stub}
      </div>
    );
    return (
      <article
        ref={ref}
        className={cn("ticket w-full", highlighted && "ticket-highlight", className)}
        data-variant="compact"
        data-stock={stock}
        data-from={stamp ? settledFrom ?? "live" : undefined}
        data-landing={phase === "landing" ? "" : undefined}
        data-pending-land={phase === "pending" ? "" : undefined}
        aria-label={`${terms}. ${stake} ${currency}. ${status}`}
      >
        {onOpen ? (
          <button type="button" onClick={onOpen} className="block w-full rounded-[14px] text-left" aria-label={openLabel ?? `Open bet: ${terms}`}>
            {inner}
          </button>
        ) : inner}
      </article>
    );
  }

  return (
    <article
      ref={ref}
      className={cn("ticket w-full", highlighted && "ticket-highlight", className)}
      data-variant="full"
      data-stock={stock}
      data-from={stamp ? settledFrom ?? "live" : undefined}
      data-landing={phase === "landing" ? "" : undefined}
      data-pending-land={phase === "pending" ? "" : undefined}
    >
      <div className="ticket-paper flex">
        <div className="relative min-w-0 flex-1 px-4 pb-3 pt-4 sm:px-5">
          {context && <p className="mb-1 truncate text-meta text-ticket-ink-soft">{context}</p>}
          {onOpen ? (
            <button type="button" onClick={onOpen} className="block rounded-sm text-left text-terms font-semibold hover:underline" aria-label={openLabel}>
              {terms}
            </button>
          ) : (
            <p className="text-terms font-semibold break-words">{terms}</p>
          )}
          {parties && <Parties parties={parties} people={people} onOpenPerson={onOpenPerson} />}
          {details && details.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {details.map((line) => (
                <p key={line} className="text-meta text-ticket-ink-soft">{line}</p>
              ))}
            </div>
          )}
          {checkIn && <CheckInProgress checkIn={checkIn} />}
          {proof && <ProofSlot proof={proof} />}

          <p className={cn("mt-3 text-label font-semibold", stamp && "pr-2")} role="status">
            {status}
          </p>

          {busyLabel ? (
            <p className="mt-1 flex min-h-11 items-center text-label text-ticket-ink-soft md:min-h-9">{busyLabel}</p>
          ) : (visibleActions.length > 0 || shownLinks.length > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {visibleActions.map((action) => <ActionButton key={action.label} action={action} />)}
              {shownLinks.length === 1 && (
                <ActionButton action={{ label: "View on Solana explorer", href: shownLinks[0]!.href }} />
              )}
              {shownLinks.length > 1 && (
                <span className="inline-flex flex-wrap items-center gap-x-2 text-label">
                  <span className="text-ticket-ink-soft">Solana explorer:</span>
                  {shownLinks.map((link) => (
                    <ActionButton key={link.href + link.label} action={{ label: link.label, href: link.href }} />
                  ))}
                </span>
              )}
            </div>
          )}

          {stamp && <Stamp stamp={stamp} compact={false} />}
        </div>
        {stub}
      </div>
    </article>
  );
}
