import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { Bet, BetCurrency, BetSchedule, BetVoteChoice, ScoreboardGame, SportKind } from "../../lib/relayer";
import { friendlyError, sameName } from "../../lib/bets";
import { cn } from "../../lib/cn";
import { normalizeStake, stakeError } from "../../lib/stake";
import { checkScheduleDraft, draftToSchedule } from "../../lib/schedule";
import { CurrencyPicker, StakeInput, useBetCurrency } from "./CurrencyFields";
import { HabitFields, initialHabit, type HabitState } from "./HabitFields";
import {
  Button,
  Field,
  InlineError,
  Segmented,
  Sheet,
  TextArea,
  TextInput,
  buttonClass,
  useFieldId,
} from "./primitives";
import { Ticket } from "./ticket/Ticket";
import { describeBet } from "./ticket/BetTicket";
import { GameList, LEAGUE_LABELS, LeaguePicker, SidePicker, useScoreboard } from "./sports/GamePicker";

export type BetType = "PERSONAL" | "DEV";
export type FallbackKind = "return" | "burn" | "charity";

/** Everything the composer collects; the caller adds the group and posts it. */
export interface NewBet {
  type: BetType;
  /** A member's username, or "anyone" for an open challenge. */
  acceptor: string;
  terms: string;
  stake: string;
  currency: BetCurrency;
  // Witness bets
  witnesses?: number;
  acceptByDate?: number | null;
  resolveByDate?: number;
  fallbackKind?: FallbackKind;
  charityName?: string;
  charityAddress?: string;
  // Sports bets (stored internally as DEV for backwards compatibility)
  sport?: SportKind;
  gameId?: string;
  backsHome?: boolean;
  homeTeam?: string;
  awayTeam?: string;
  // Recurring check-in bets ("Make it a habit"); the relayer sets the verdict deadline.
  habit?: { schedule: BetSchedule; requiredCheckins: number; doer: BetVoteChoice };
}

const TERMS_MIN = 8;
const TERMS_MAX = 200;

function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function roundedHoursFromNow(hours: number): number {
  const ms = Date.now() + hours * 60 * 60 * 1000;
  return Math.ceil(ms / (60 * 60 * 1000)) * 60 * 60 * 1000;
}

/** Witnesses are group members who aren't on either side of the bet. */
export function witnessLimits(memberCount: number): { min: number; max: number; preferred: number } {
  const max = Math.max(1, memberCount - 2);
  const preferred = Math.min(max, Math.max(2, Math.ceil(memberCount / 2)));
  return { min: 1, max, preferred };
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Errors {
  game?: string;
  terms?: string;
  stake?: string;
  witnesses?: string;
  acceptBy?: string;
  resolveBy?: string;
  charityAddress?: string;
}

export function NewBetSheet({
  open,
  onOpenChange,
  groupName,
  members,
  memberCount,
  viewer,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  /** Other members (excluding the viewer). */
  members: string[];
  memberCount: number;
  viewer: string;
  onSubmit: (bet: NewBet) => Promise<void>;
}) {
  const limits = witnessLimits(memberCount);
  const [type, setType] = useState<BetType>("PERSONAL");
  const [acceptor, setAcceptor] = useState("anyone");
  const [terms, setTerms] = useState("");
  const [stake, setStake] = useState("");
  const [witnesses, setWitnesses] = useState(limits.preferred);
  const [acceptByMode, setAcceptByMode] = useState<"none" | "date">("none");
  const [acceptBy, setAcceptBy] = useState(() => toLocalInput(roundedHoursFromNow(48)));
  const [resolveBy, setResolveBy] = useState(() => toLocalInput(roundedHoursFromNow(7 * 24)));
  const [fallbackKind, setFallbackKind] = useState<FallbackKind>("return");
  const [charityName, setCharityName] = useState("");
  const [charityAddress, setCharityAddress] = useState("");
  const [sport, setSport] = useState<SportKind>("nba");
  const [game, setGame] = useState<ScoreboardGame | null>(null);
  const [backsHome, setBacksHome] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [habitOn, setHabitOn] = useState(false);
  const [habit, setHabit] = useState<HabitState>(initialHabit);
  const { options: currencyOptions, currency, setCurrency } = useBetCurrency(open);
  const termsRef = useRef<HTMLTextAreaElement>(null);

  const isSports = type === "DEV";
  const board = useScoreboard(sport, open && isSports);
  const ids = {
    terms: useFieldId("terms"),
    stake: useFieldId("stake"),
    acceptBy: useFieldId("accept-by"),
    resolveBy: useFieldId("resolve-by"),
    charityName: useFieldId("charity-name"),
    charityAddress: useFieldId("charity-address"),
    habitLabel: useFieldId("habit-label"),
  };

  const memberOptions = useMemo(() => {
    const seen = new Set<string>();
    return members.filter((name) => {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key) || sameName(name, viewer)) return false;
      seen.add(key);
      return true;
    });
  }, [members, viewer]);

  // Reset after the sheet closes.
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setType("PERSONAL"); setAcceptor("anyone"); setTerms(""); setStake("");
      setWitnesses(witnessLimits(memberCount).preferred);
      setAcceptByMode("none"); setAcceptBy(toLocalInput(roundedHoursFromNow(48)));
      setResolveBy(toLocalInput(roundedHoursFromNow(7 * 24)));
      setFallbackKind("return"); setCharityName(""); setCharityAddress("");
      setSport("nba"); setGame(null); setBacksHome(true);
      setAttempted(false); setPosting(false); setPostError(null);
      setHabitOn(false); setHabit(initialHabit());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, memberCount]);

  useEffect(() => {
    setWitnesses((current) => Math.min(Math.max(current, limits.min), limits.max));
  }, [limits.min, limits.max]);

  useEffect(() => {
    if (acceptor !== "anyone" && !memberOptions.some((name) => sameName(name, acceptor))) setAcceptor("anyone");
  }, [acceptor, memberOptions]);

  useEffect(() => { setGame(null); }, [sport]);
  // Points have no cash value, so there's no charity fallback for them.
  useEffect(() => { if (currency === "PTS" && fallbackKind === "charity") setFallbackKind("return"); }, [currency, fallbackKind]);

  const backedTeam = game ? (backsHome ? game.homeTeam : game.awayTeam) : "";
  const sportsTerms = game
    ? `${LEAGUE_LABELS[sport]}: ${game.awayTeam} @ ${game.homeTeam} — I back ${backedTeam}. Settled by the final official result.`
    : "";

  const resolveByMs = fromLocalInput(resolveBy);
  const acceptByMs = acceptByMode === "date" ? fromLocalInput(acceptBy) : null;

  const errors: Errors = {};
  const now = Date.now();
  const isHabit = !isSports && habitOn;
  const habitCheck = checkScheduleDraft(habit.draft, now);
  const habitErrors = isHabit ? habitCheck.errors : {};
  if (isSports) {
    if (!game) errors.game = "Pick a game.";
  } else {
    const length = terms.trim().length;
    if (length < TERMS_MIN) errors.terms = `Write at least ${TERMS_MIN} characters so witnesses know what counts.`;
    else if (length > TERMS_MAX) errors.terms = `Keep it under ${TERMS_MAX} characters.`;
    if (!Number.isInteger(witnesses) || witnesses < limits.min || witnesses > limits.max) {
      errors.witnesses = `Pick between ${limits.min} and ${limits.max}.`;
    }
    if (!isHabit && (resolveByMs === null || resolveByMs <= now)) errors.resolveBy = "Pick a time in the future.";
    if (acceptByMode === "date") {
      if (acceptByMs === null || acceptByMs <= now) errors.acceptBy = "Pick a time in the future.";
      else if (!isHabit && resolveByMs !== null && acceptByMs > resolveByMs) errors.acceptBy = "Must be on or before the decide-by time.";
    }
    if (currency === "SOL" && fallbackKind === "charity" && !SOLANA_ADDRESS.test(charityAddress.trim())) {
      errors.charityAddress = "Paste the charity's Solana wallet address.";
    }
  }
  const stakeProblem = stakeError(stake, currency);
  if (stakeProblem) errors.stake = stakeProblem;
  const valid = Object.keys(errors).length === 0 && Object.keys(habitErrors).length === 0;
  const habitSchedule = isHabit ? draftToSchedule(habit.draft) : null;
  const acceptorLabel = acceptor === "anyone" ? "Whoever accepts" : acceptor;
  const show = (key: keyof Errors) => (attempted ? errors[key] : undefined);

  const previewBet: Bet = {
    id: "preview",
    type,
    challenger: viewer,
    acceptor,
    terms: isSports ? sportsTerms || "Pick a game" : terms.trim() || "What's the bet?",
    stake: normalizeStake(stake, currency) || "0",
    currency,
    status: "PENDING",
    witnesses,
    minBettors: 2,
    groupSize: memberCount,
    ...(isSports
      ? { validation: "sports" as const, sport, homeTeam: game?.homeTeam, awayTeam: game?.awayTeam, challengerBacksHome: backsHome }
      : {
          resolveByDate: isHabit ? undefined : resolveByMs ?? undefined,
          acceptByDate: acceptByMs,
          fallbackKind,
          charityName: charityName.trim() || undefined,
          ...(habitSchedule
            ? { schedule: habitSchedule, requiredCheckins: habitCheck.required, doer: habit.doer }
            : {}),
        }),
  };
  const preview = describeBet(previewBet, viewer);

  async function submit(): Promise<void> {
    setAttempted(true);
    setPostError(null);
    if (!valid) {
      if (errors.terms) termsRef.current?.focus();
      return;
    }
    setPosting(true);
    try {
      await onSubmit({
        type,
        acceptor,
        terms: isSports ? sportsTerms : terms.trim(),
        stake: normalizeStake(stake, currency),
        currency,
        ...(isSports && game
          ? { sport, gameId: game.gameId, backsHome, homeTeam: game.homeTeam, awayTeam: game.awayTeam }
          : {
              witnesses,
              acceptByDate: acceptByMs,
              resolveByDate: isHabit ? undefined : resolveByMs ?? undefined,
              fallbackKind,
              ...(currency === "SOL" && fallbackKind === "charity"
                ? { charityAddress: charityAddress.trim(), charityName: charityName.trim() || undefined }
                : {}),
              ...(habitSchedule
                ? { habit: { schedule: habitSchedule, requiredCheckins: habitCheck.required, doer: habit.doer } }
                : {}),
            }),
      });
      onOpenChange(false);
    } catch (err) {
      setPostError(friendlyError(err, "Couldn't post this bet. Try again."));
    } finally {
      setPosting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!posting}
      size="lg"
      title="New bet"
      description={`Posting to ${groupName}`}
      initialFocus="none"
      footer={(
        <>
          {postError && <div className="mr-auto basis-full md:basis-auto"><InlineError>{postError}</InlineError></div>}
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={posting}>Cancel</Button>
          <Button variant="primary" onClick={() => { void submit(); }} disabled={posting}>
            {posting ? "Posting…" : "Post bet"}
          </Button>
        </>
      )}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,400px)] md:gap-8">
        {/* Live preview: first on mobile, sticky on the right on desktop. */}
        <div className="md:order-2">
          <div className="md:sticky md:top-0">
            <p className="mb-2 text-meta text-ink-soft" aria-hidden>Preview</p>
            <div aria-live="polite" aria-label="Ticket preview">
              <Ticket {...preview} id={undefined} links={undefined} />
            </div>
          </div>
        </div>

        <form
          className="space-y-6 md:order-1"
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
          noValidate
        >
          <Field label="Kind of bet" hint={isSports ? "The final score decides. No witnesses needed." : "Friends in the group decide who won."}>
            <Segmented
              label="Kind of bet"
              value={type}
              onChange={setType}
              options={[
                { value: "PERSONAL", label: "Friends decide" },
                { value: "DEV", label: "Sports game" },
              ]}
            />
          </Field>

          {isSports && (
            <div className="space-y-3">
              <Field label="League"><LeaguePicker value={sport} onChange={setSport} /></Field>
              <div>
                <p className="mb-1.5 text-label font-semibold">Game</p>
                <GameList
                  sport={sport}
                  board={board}
                  selectedGameId={game?.gameId ?? null}
                  onSelect={(next) => { setGame(next); setBacksHome(true); }}
                  className="max-h-64 overflow-y-auto"
                />
                {show("game") && <p className="mt-1.5 text-meta text-danger" role="alert">{errors.game}</p>}
              </div>
              {game && (
                <Field label="Your side" hint={`Whoever accepts gets ${backsHome ? game.awayTeam : game.homeTeam}.`}>
                  <SidePicker game={game} backsHome={backsHome} onChange={setBacksHome} />
                </Field>
              )}
            </div>
          )}

          {!isSports && (
            <Field
              label="The bet"
              htmlFor={ids.terms}
              error={show("terms")}
              hint={`${terms.trim().length} of ${TERMS_MAX} characters. Be specific: what counts, and by when.`}
            >
              <TextArea
                id={ids.terms}
                ref={termsRef}
                rows={3}
                maxLength={TERMS_MAX + 40}
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                placeholder="Jordan makes every 5am lift Mon–Fri"
                aria-invalid={Boolean(show("terms"))}
              />
            </Field>
          )}

          <Field
            label="Challenge"
            hint={memberOptions.length === 0
              ? "Nobody else is in this group yet, so this posts as an open challenge."
              : acceptor === "anyone" ? "Anyone in the group can accept." : `Only ${acceptor} can accept.`}
          >
            <Segmented
              label="Challenge"
              value={acceptor}
              onChange={setAcceptor}
              size="sm"
              options={[
                { value: "anyone", label: "Anyone" },
                ...memberOptions.map((name) => ({ value: name, label: name })),
              ]}
            />
          </Field>

          <CurrencyPicker options={currencyOptions} value={currency} onChange={setCurrency} />

          <Field
            label="Stake"
            htmlFor={ids.stake}
            error={show("stake")}
            hint={currency === "PTS"
              ? "Each side puts this in. Points are held until the bet settles."
              : "Each side puts this in. It's held on Solana until the bet settles."}
          >
            <StakeInput
              id={ids.stake}
              currency={currency}
              value={stake}
              onChange={setStake}
              invalid={Boolean(show("stake"))}
            />
          </Field>

          {!isSports && (
            <>
              <Field
                label="Witnesses"
                error={show("witnesses")}
                hint={memberCount < 3
                  ? "Witnesses are other people in the group. Invite another friend so someone can decide."
                  : isHabit
                    ? `How many friends must approve each check-in. Up to ${limits.max} in this group.`
                    : `How many friends must agree on the winner. Up to ${limits.max} in this group.`}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={buttonClass("secondary", "icon")}
                    onClick={() => setWitnesses((n) => Math.max(limits.min, n - 1))}
                    disabled={witnesses <= limits.min}
                    aria-label="Fewer witnesses"
                  >
                    <Minus size={18} aria-hidden />
                  </button>
                  <output className="w-10 text-center text-[22px] font-extrabold wdth-condensed tabular-nums" aria-live="polite">
                    {witnesses}
                  </output>
                  <button
                    type="button"
                    className={buttonClass("secondary", "icon")}
                    onClick={() => setWitnesses((n) => Math.min(limits.max, n + 1))}
                    disabled={witnesses >= limits.max}
                    aria-label="More witnesses"
                  >
                    <Plus size={18} aria-hidden />
                  </button>
                </div>
              </Field>

              <div className="rounded-2xl border border-rule p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-label font-semibold" id={ids.habitLabel}>Make it a habit</p>
                    <p className="mt-0.5 text-meta text-ink-soft">
                      Check in with proof on set days. Witnesses approve each check-in instead of voting once.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={habitOn}
                    aria-labelledby={ids.habitLabel}
                    onClick={() => setHabitOn((on) => !on)}
                    className={cn(
                      "relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors",
                      habitOn ? "border-ink bg-ink" : "border-rule bg-counter",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block size-5 rounded-full bg-paper shadow-sm transition-transform",
                        habitOn ? "translate-x-6" : "translate-x-1",
                      )}
                    />
                  </button>
                </div>
                {habitOn && (
                  <div className="mt-5 border-t border-rule pt-5">
                    <HabitFields
                      value={habit}
                      onChange={setHabit}
                      errors={habitCheck.errors}
                      total={habitCheck.total}
                      acceptorLabel={acceptorLabel}
                      show={attempted}
                    />
                  </div>
                )}
              </div>

              <Field
                label="Accept by"
                error={show("acceptBy")}
                htmlFor={ids.acceptBy}
                hint={isHabit ? "With no deadline, they have until the first check-in window closes." : undefined}
              >
                <Segmented
                  label="Accept by"
                  value={acceptByMode}
                  onChange={setAcceptByMode}
                  size="sm"
                  options={[
                    { value: "none", label: "No deadline" },
                    { value: "date", label: "Pick a time" },
                  ]}
                />
                {acceptByMode === "date" && (
                  <TextInput
                    id={ids.acceptBy}
                    type="datetime-local"
                    value={acceptBy}
                    min={toLocalInput(now)}
                    max={resolveBy || undefined}
                    onChange={(event) => setAcceptBy(event.target.value)}
                    className="mt-2 max-w-72"
                    aria-invalid={Boolean(show("acceptBy"))}
                  />
                )}
              </Field>

              {isHabit ? (
                <div>
                  <p className="text-label font-semibold">Verdict</p>
                  <p className="mt-1 text-meta text-ink-soft">
                    Decided automatically from the check-ins. Witnesses get 48 hours after the last day to finish reviewing.
                  </p>
                </div>
              ) : (
                <Field
                  label="Decide by"
                  htmlFor={ids.resolveBy}
                  error={show("resolveBy")}
                  hint="Witnesses vote until this time."
                >
                  <TextInput
                    id={ids.resolveBy}
                    type="datetime-local"
                    value={resolveBy}
                    min={toLocalInput(now)}
                    onChange={(event) => setResolveBy(event.target.value)}
                    className="max-w-72"
                    aria-invalid={Boolean(show("resolveBy"))}
                  />
                </Field>
              )}

              <Field label={isHabit ? "If witnesses never review the check-ins" : "If there's no verdict by then"}>
                <Segmented
                  label="If there's no verdict by then"
                  value={fallbackKind}
                  onChange={setFallbackKind}
                  size="sm"
                  options={[
                    { value: "return", label: "Everyone gets their stake back" },
                    { value: "burn", label: "Burn the pot" },
                    ...(currency === "SOL" ? [{ value: "charity" as const, label: "Give it to charity" }] : []),
                  ]}
                />
              </Field>

              {currency === "SOL" && fallbackKind === "charity" && (
                <div className={cn("grid gap-4 sm:grid-cols-2")}>
                  <Field label="Charity name" htmlFor={ids.charityName} hint="Shown on the ticket.">
                    <TextInput
                      id={ids.charityName}
                      value={charityName}
                      onChange={(event) => setCharityName(event.target.value)}
                      placeholder="Food bank"
                    />
                  </Field>
                  <Field
                    label="Charity wallet"
                    htmlFor={ids.charityAddress}
                    error={show("charityAddress")}
                    hint="Their Solana address."
                  >
                    <TextInput
                      id={ids.charityAddress}
                      value={charityAddress}
                      onChange={(event) => setCharityAddress(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(show("charityAddress"))}
                    />
                  </Field>
                </div>
              )}
            </>
          )}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </div>
    </Sheet>
  );
}
