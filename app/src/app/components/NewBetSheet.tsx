import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { Bet, ScoreboardGame, SportKind } from "../../lib/relayer";
import { friendlyError, sameName } from "../../lib/bets";
import { cn } from "../../lib/cn";
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
  currency: "SOL";
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

  const backedTeam = game ? (backsHome ? game.homeTeam : game.awayTeam) : "";
  const sportsTerms = game
    ? `${LEAGUE_LABELS[sport]}: ${game.awayTeam} @ ${game.homeTeam} — I back ${backedTeam}. Settled by the final official result.`
    : "";

  const resolveByMs = fromLocalInput(resolveBy);
  const acceptByMs = acceptByMode === "date" ? fromLocalInput(acceptBy) : null;

  const errors: Errors = {};
  const now = Date.now();
  if (isSports) {
    if (!game) errors.game = "Pick a game.";
  } else {
    const length = terms.trim().length;
    if (length < TERMS_MIN) errors.terms = `Write at least ${TERMS_MIN} characters so witnesses know what counts.`;
    else if (length > TERMS_MAX) errors.terms = `Keep it under ${TERMS_MAX} characters.`;
    if (!Number.isInteger(witnesses) || witnesses < limits.min || witnesses > limits.max) {
      errors.witnesses = `Pick between ${limits.min} and ${limits.max}.`;
    }
    if (resolveByMs === null || resolveByMs <= now) errors.resolveBy = "Pick a time in the future.";
    if (acceptByMode === "date") {
      if (acceptByMs === null || acceptByMs <= now) errors.acceptBy = "Pick a time in the future.";
      else if (resolveByMs !== null && acceptByMs > resolveByMs) errors.acceptBy = "Must be on or before the decide-by time.";
    }
    if (fallbackKind === "charity" && !SOLANA_ADDRESS.test(charityAddress.trim())) {
      errors.charityAddress = "Paste the charity's Solana wallet address.";
    }
  }
  const stakeNumber = Number(stake);
  if (!stake.trim() || !Number.isFinite(stakeNumber) || stakeNumber <= 0) errors.stake = "Enter an amount above 0.";
  const valid = Object.keys(errors).length === 0;
  const show = (key: keyof Errors) => (attempted ? errors[key] : undefined);

  const previewBet: Bet = {
    id: "preview",
    type,
    challenger: viewer,
    acceptor,
    terms: isSports ? sportsTerms || "Pick a game" : terms.trim() || "What's the bet?",
    stake: stake.trim() || "0",
    currency: "SOL",
    status: "PENDING",
    witnesses,
    minBettors: 2,
    groupSize: memberCount,
    ...(isSports
      ? { validation: "sports" as const, sport, homeTeam: game?.homeTeam, awayTeam: game?.awayTeam, challengerBacksHome: backsHome }
      : {
          resolveByDate: resolveByMs ?? undefined,
          acceptByDate: acceptByMs,
          fallbackKind,
          charityName: charityName.trim() || undefined,
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
        stake: stake.trim(),
        currency: "SOL",
        ...(isSports && game
          ? { sport, gameId: game.gameId, backsHome, homeTeam: game.homeTeam, awayTeam: game.awayTeam }
          : {
              witnesses,
              acceptByDate: acceptByMs,
              resolveByDate: resolveByMs ?? undefined,
              fallbackKind,
              ...(fallbackKind === "charity"
                ? { charityAddress: charityAddress.trim(), charityName: charityName.trim() || undefined }
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

          <Field
            label="Stake"
            htmlFor={ids.stake}
            error={show("stake")}
            hint="Each side puts this in. It's held on Solana until the bet settles."
          >
            <div className="relative max-w-56">
              <TextInput
                id={ids.stake}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
                placeholder="0.25"
                className="pr-14 text-[22px] font-extrabold wdth-condensed tabular-nums"
                aria-invalid={Boolean(show("stake"))}
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-label font-semibold text-ink-soft">SOL</span>
            </div>
          </Field>

          {!isSports && (
            <>
              <Field
                label="Witnesses"
                error={show("witnesses")}
                hint={memberCount < 3
                  ? "Witnesses are other people in the group. Invite another friend so someone can decide."
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

              <Field label="Accept by" error={show("acceptBy")} htmlFor={ids.acceptBy}>
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

              <Field label="If there's no verdict by then">
                <Segmented
                  label="If there's no verdict by then"
                  value={fallbackKind}
                  onChange={setFallbackKind}
                  size="sm"
                  options={[
                    { value: "return", label: "Everyone gets their stake back" },
                    { value: "burn", label: "Burn the pot" },
                    { value: "charity", label: "Give it to charity" },
                  ]}
                />
              </Field>

              {fallbackKind === "charity" && (
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
