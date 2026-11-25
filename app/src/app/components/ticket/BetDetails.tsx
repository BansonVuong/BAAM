/**
 * Everything under the ticket in the full-ticket sheet: pending check-ins to
 * review, the day-by-day strip, and the proof gallery. Quiet paper and ink;
 * the ticket above stays the only loud thing.
 */
import { useState } from "react";
import { Check, Clock, ExternalLink, X } from "lucide-react";
import {
  proofImageUrl,
  reviewCheckin,
  type Bet,
  type CheckinOccurrenceState,
  type CheckinSummary,
  type ProofSummary,
} from "../../../lib/relayer";
import {
  formatDeadline,
  formatTimeOfDay,
  friendlyError,
  isBetCompleted,
  opponentName,
  sameName,
  witnessThreshold,
} from "../../../lib/bets";
import {
  checkinDecisionText,
  formatDateKeyWithDay,
  formatWindow,
  occurrenceKind,
  occurrenceStateText,
  parseDateKey,
  timeZoneLabel,
  WEEKDAY_SHORT,
  type OccurrenceKind,
} from "../../../lib/schedule";
import { cn } from "../../../lib/cn";
import { Button, InlineError } from "../primitives";

function when(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function clock(ms: number): string {
  return formatTimeOfDay(ms);
}

function isDecided(bet: Bet): boolean {
  return isBetCompleted(bet) || Boolean(bet.resolvedWinner);
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="mt-7" aria-labelledby={id}>
      <h3 id={id} className="mb-3 text-body font-bold">{title}</h3>
      {children}
    </section>
  );
}

/* ── Proof ─────────────────────────────────────────────────────────────── */

function ProofItem({ proof, viewer, onOpenPerson }: { proof: ProofSummary; viewer: string; onOpenPerson?: (name: string) => void }) {
  const src = proofImageUrl(proof);
  const alt = proof.caption || `Proof from ${proof.uploader}`;
  const mine = sameName(proof.uploader, viewer);
  return (
    <li className="min-w-0">
      {src && (
        <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-rule bg-counter">
          <img src={src} alt={alt} loading="lazy" className="aspect-[4/3] w-full object-cover" />
        </a>
      )}
      {proof.caption && <p className="mt-2 break-words text-label">{proof.caption}</p>}
      {proof.link && (
        <a
          href={proof.link}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex max-w-full items-center gap-1.5 text-label font-semibold underline underline-offset-4"
        >
          <span className="truncate">{proof.link.replace(/^https?:\/\//, "")}</span>
          <ExternalLink size={13} aria-hidden className="shrink-0" />
        </a>
      )}
      <p className="mt-1 text-meta text-ink-soft">
        {mine ? "You" : onOpenPerson ? (
          <button type="button" className="underline underline-offset-4" onClick={() => onOpenPerson(proof.uploader)}>{proof.uploader}</button>
        ) : proof.uploader}
        {", "}{when(proof.createdAt)}
      </p>
    </li>
  );
}

export function ProofGallery({ proofs, viewer, onOpenPerson, title = "Proof" }: {
  proofs: ProofSummary[];
  viewer: string;
  onOpenPerson?: (name: string) => void;
  title?: string;
}) {
  if (proofs.length === 0) return null;
  return (
    <Section title={`${title} (${proofs.length})`} id="details-proof">
      <ul className="grid gap-5 sm:grid-cols-2">
        {[...proofs].sort((a, b) => b.createdAt - a.createdAt).map((proof) => (
          <ProofItem key={proof.id} proof={proof} viewer={viewer} onOpenPerson={onOpenPerson} />
        ))}
      </ul>
    </Section>
  );
}

/* ── Day strip ─────────────────────────────────────────────────────────── */

type StripKind = OccurrenceKind | "skipped";

const KIND_TEXT: Record<StripKind, string> = {
  done: "Done",
  review: "Under review",
  missed: "Missed",
  today: "Today",
  upcoming: "Upcoming",
  skipped: "Not needed",
};

function DayMark({ kind }: { kind: StripKind }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 items-center justify-center rounded-full",
        kind === "done" && "bg-ink text-paper",
        kind === "review" && "border-2 border-dashed border-ink text-ink",
        kind === "missed" && "border border-rule text-ink-soft",
        kind === "today" && "border-[3px] border-ink",
        kind === "upcoming" && "border border-rule",
        kind === "skipped" && "border border-dashed border-ink-soft/50",
      )}
    >
      {kind === "done" && <Check size={17} strokeWidth={3} />}
      {kind === "review" && <Clock size={15} strokeWidth={2.5} />}
      {kind === "missed" && <X size={16} strokeWidth={2.5} />}
    </span>
  );
}

function DayStrip({ bet }: { bet: Bet }) {
  const progress = bet.checkinProgress;
  if (!progress) return null;
  const decided = isDecided(bet);
  const kindOf = (state: CheckinOccurrenceState): StripKind => {
    const kind = occurrenceKind(state);
    return decided && (kind === "upcoming" || kind === "today") ? "skipped" : kind;
  };
  const used = new Set(progress.occurrences.map((o) => kindOf(o.state)));
  return (
    <div>
      <ol className="-mx-1 flex flex-wrap gap-x-1 gap-y-3" aria-label="Check-in days">
        {progress.occurrences.map((occurrence) => {
          const kind = kindOf(occurrence.state);
          const parsed = parseDateKey(occurrence.key);
          const weekday = parsed ? WEEKDAY_SHORT[new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 12)).getUTCDay()] : "";
          const text = kind === "skipped" ? KIND_TEXT.skipped : occurrenceStateText(occurrence.state);
          return (
            <li
              key={occurrence.key}
              className="flex w-12 flex-col items-center gap-1"
              aria-label={`${formatDateKeyWithDay(occurrence.key)}: ${text}`}
              title={`${formatDateKeyWithDay(occurrence.key)}: ${text}`}
            >
              <DayMark kind={kind} />
              <span className={cn("text-meta", kind === "today" ? "font-bold" : "text-ink-soft")} aria-hidden>
                {weekday} {parsed?.d}
              </span>
            </li>
          );
        })}
      </ol>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-meta text-ink-soft" aria-hidden>
        {(["done", "review", "today", "missed", "upcoming", "skipped"] as const).filter((kind) => used.has(kind)).map((kind) => (
          <li key={kind} className="flex items-center gap-1.5">
            <span className="scale-[0.6] -m-2"><DayMark kind={kind} /></span>
            {KIND_TEXT[kind]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScheduleFacts({ bet, viewer }: { bet: Bet; viewer: string }) {
  const progress = bet.checkinProgress;
  const schedule = bet.schedule;
  if (!progress || !schedule) return null;
  const doerName = progress.doerUsername ?? (bet.doer === "acceptor" ? opponentName(bet) : bet.challenger) ?? "the doer";
  const doer = sameName(doerName, viewer) ? "You" : doerName;
  const dailyWindow = formatWindow(schedule);
  const decided = isDecided(bet);
  const lines: string[] = [];
  if (!decided) {
    if (progress.currentWindow) {
      const today = progress.occurrences.find((o) => o.key === progress.currentWindow!.key);
      lines.push(today?.state === "open"
        ? `Today's check-in is open until ${formatTimeOfDay(progress.currentWindow.end)}.`
        : `Today's check-in: ${today ? occurrenceStateText(today.state).toLowerCase() : "in"}.`);
    }
    if (progress.nextWindow) {
      lines.push(dailyWindow
        ? `Next check-in: ${formatDateKeyWithDay(progress.nextWindow.key)}, ${clock(progress.nextWindow.start)} to ${formatTimeOfDay(progress.nextWindow.end)}.`
        : `Next check-in day: ${formatDateKeyWithDay(progress.nextWindow.key)}.`);
    }
    lines.push(`${doer} ${doer === "You" ? "need" : "needs"} ${progress.required} of ${progress.total} days approved. ${progress.approved} so far.`);
    if (progress.verdictDeadline) {
      const verdict = formatDeadline(progress.verdictDeadline);
      lines.push(`Verdict by ${verdict.startsWith("end of") ? "the " : ""}${verdict}. Witnesses have until then to review the last check-ins.`);
    }
    lines.push(`Times are in ${timeZoneLabel(schedule.timezone)}${dailyWindow ? `, ${dailyWindow}` : ", any time of day"}.`);
  }
  const reason = decided || progress.decision.winner !== null || progress.decision.reason === "witnesses-silent"
    ? checkinDecisionText(progress, doerName)
    : null;
  return (
    <div className="mt-4 space-y-1.5">
      {reason && <p className="text-label font-semibold">{reason}</p>}
      {lines.map((line) => <p key={line} className="text-label text-ink-soft">{line}</p>)}
    </div>
  );
}

/* ── Check-ins to review ───────────────────────────────────────────────── */

function PendingCheckin({ bet, checkin, proofs, viewer, canReview, onReviewed }: {
  bet: Bet;
  checkin: CheckinSummary;
  proofs: ProofSummary[];
  viewer: string;
  canReview: boolean;
  onReviewed: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const need = witnessThreshold(bet);
  const mine = checkin.reviews.find((review) => sameName(review.reviewer, viewer));

  async function review(approve: boolean): Promise<void> {
    setBusy(approve ? "approve" : "reject");
    setError(null);
    try {
      await reviewCheckin(bet.id, checkin.id, approve);
      onReviewed();
    } catch (err) {
      setError(friendlyError(err, "Couldn't send your review. Try again."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-2xl border border-rule p-4">
      <p className="text-label">
        <span className="font-semibold">{sameName(checkin.doer, viewer) ? "You" : checkin.doer}</span>
        {" checked in for "}{formatDateKeyWithDay(checkin.occurrenceKey)}
        <span className="text-ink-soft">, {clock(checkin.submittedAt)}</span>
      </p>
      {proofs.length > 0 && (
        <ul className="mt-3 grid gap-4 sm:grid-cols-2">
          {proofs.map((proof) => <ProofItem key={proof.id} proof={proof} viewer={viewer} />)}
        </ul>
      )}
      {checkin.caption && proofs.every((proof) => proof.caption !== checkin.caption) && (
        <p className="mt-2 text-label">{checkin.caption}</p>
      )}
      <p className="mt-3 text-meta text-ink-soft">
        {checkin.approvals} of {need} {need === 1 ? "approval" : "approvals"}
        {checkin.rejections > 0 ? `, ${checkin.rejections} ${checkin.rejections === 1 ? "rejection" : "rejections"}` : ""}
        {mine ? `. You ${mine.approve ? "approved" : "rejected"} it.` : ""}
      </p>
      {canReview && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mine?.approve ? "secondary" : "primary"}
            onClick={() => { void review(true); }}
            disabled={Boolean(busy) || mine?.approve === true}
          >
            {busy === "approve" ? "Approving…" : mine?.approve ? "Approved" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { void review(false); }}
            disabled={Boolean(busy) || mine?.approve === false}
          >
            {busy === "reject" ? "Rejecting…" : mine && !mine.approve ? "Rejected" : "Reject"}
          </Button>
        </div>
      )}
      {error && <div className="mt-2"><InlineError>{error}</InlineError></div>}
    </li>
  );
}

export function BetDetails({ bet, viewer, onChanged, onOpenPerson }: {
  bet: Bet;
  viewer: string;
  onChanged: () => void;
  onOpenPerson?: (name: string) => void;
}) {
  const proofs = bet.proofs ?? [];
  const checkins = bet.checkins ?? [];
  const pending = checkins.filter((checkin) => checkin.status === "pending");
  const canReview = Boolean(bet.viewerActions?.canReview);
  const checkinProofIds = new Set(checkins.flatMap((checkin) => checkin.proofIds));
  const looseProofs = proofs.filter((proof) => !proof.checkinId && !checkinProofIds.has(proof.id));
  const checkinProofs = proofs.filter((proof) => proof.checkinId || checkinProofIds.has(proof.id));

  return (
    <div>
      {pending.length > 0 && (
        <Section title={canReview ? "Check-ins to review" : "Under review"} id="details-review">
          {!canReview && (
            <p className="-mt-1 mb-3 text-label text-ink-soft">Witnesses in the chat approve or reject each check-in.</p>
          )}
          <ul className="space-y-3">
            {pending.map((checkin) => (
              <PendingCheckin
                key={checkin.id}
                bet={bet}
                checkin={checkin}
                proofs={proofs.filter((proof) => proof.checkinId === checkin.id || checkin.proofIds.includes(proof.id))}
                viewer={viewer}
                canReview={canReview}
                onReviewed={onChanged}
              />
            ))}
          </ul>
        </Section>
      )}

      {bet.schedule && bet.checkinProgress && (
        <Section title="Days" id="details-days">
          <DayStrip bet={bet} />
          <ScheduleFacts bet={bet} viewer={viewer} />
        </Section>
      )}

      <ProofGallery proofs={looseProofs} viewer={viewer} onOpenPerson={onOpenPerson} />
      <ProofGallery
        proofs={checkinProofs.filter((proof) => !pending.some((c) => c.id === proof.checkinId || c.proofIds.includes(proof.id)))}
        viewer={viewer}
        onOpenPerson={onOpenPerson}
        title="Check-in proof"
      />
    </div>
  );
}
