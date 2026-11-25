import { useEffect, useMemo, useState } from "react";
import { createBet, type Bet, type ScoreboardGame, type SportKind } from "../../lib/relayer";
import { friendlyError } from "../../lib/bets";
import { defaultStakeFor, normalizeStake, stakeError } from "../../lib/stake";
import { useBaamData } from "../data";
import { CurrencyPicker, StakeInput, useBetCurrency } from "./CurrencyFields";
import { Button, Field, InlineError, ScreenTitle, Segmented, useFieldId } from "./primitives";
import { Ticket } from "./ticket/Ticket";
import { describeBet } from "./ticket/BetTicket";
import { GameList, LEAGUE_LABELS, LeaguePicker, SidePicker, useScoreboard } from "./sports/GamePicker";

export function SportsView({
  onOpenBetChat,
  onGoToChats,
}: {
  onOpenBetChat: (groupId: string, betId: string) => void;
  onGoToChats: () => void;
}) {
  const { user, groups, loaded, refresh, refreshPoints } = useBaamData();
  const { options: currencyOptions, currency, setCurrency } = useBetCurrency();
  const [sport, setSport] = useState<SportKind>("nba");
  const board = useScoreboard(sport);
  const [game, setGame] = useState<ScoreboardGame | null>(null);
  const [backsHome, setBacksHome] = useState(true);
  const [stake, setStake] = useState(() => defaultStakeFor(currency));
  const [stakeTouched, setStakeTouched] = useState(false);
  // A sensible starting stake for the chosen currency until the person types one.
  useEffect(() => { if (!stakeTouched) setStake(defaultStakeFor(currency)); }, [currency, stakeTouched]);
  const [groupId, setGroupId] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const stakeId = useFieldId("sports-stake");
  const groupSelectId = useFieldId("sports-group");

  useEffect(() => { setGame(null); setPostError(null); }, [sport]);
  useEffect(() => {
    if (!groups.some((g) => g.id === groupId)) setGroupId(groups[0]?.id ?? "");
  }, [groups, groupId]);

  const group = groups.find((g) => g.id === groupId) ?? null;
  const stakeProblem = stakeError(stake, currency);
  const stakeValid = !stakeProblem;
  const canPost = Boolean(group && game && stakeValid && !posting);
  const backedTeam = game ? (backsHome ? game.homeTeam : game.awayTeam) : "";

  const preview = useMemo(() => {
    const bet: Bet = {
      id: "sports-preview",
      type: "DEV",
      challenger: user.username,
      acceptor: "anyone",
      terms: game ? `${game.awayTeam} at ${game.homeTeam}` : "Pick a game",
      stake: normalizeStake(stake, currency) || "0",
      currency,
      status: "PENDING",
      witnesses: 1,
      minBettors: 2,
      groupSize: group?.members ?? 1,
      validation: "sports",
      sport,
      homeTeam: game?.homeTeam,
      awayTeam: game?.awayTeam,
      challengerBacksHome: backsHome,
    };
    return describeBet(bet, user.username);
  }, [user.username, game, stake, currency, group?.members, sport, backsHome]);

  async function post(): Promise<void> {
    if (!group || !game || !canPost) return;
    setPosting(true);
    setPostError(null);
    try {
      const { bet } = await createBet({
        groupId: group.id,
        type: "DEV",
        acceptor: "anyone",
        terms: `${LEAGUE_LABELS[sport]}: ${game.awayTeam} @ ${game.homeTeam} — ${user.username} backs ${backedTeam}.`,
        stake: normalizeStake(stake, currency),
        currency,
        witnesses: Math.max(2, Math.ceil(group.members / 2)),
        minBettors: 2,
        sport,
        gameId: game.gameId,
        backsHome,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
      });
      void refresh();
      void refreshPoints();
      onOpenBetChat(group.id, bet.id);
    } catch (err) {
      setPostError(friendlyError(err, "Couldn't post this bet. Try again."));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="px-4 py-5 lg:px-10 lg:py-8">
      <div className="hidden lg:block">
        <ScreenTitle>Sports</ScreenTitle>
        <p className="mt-1 text-label text-ink-soft">Pick a game and a side, then post it to a group. The final score settles it.</p>
      </div>

      <div className="mt-0 grid max-w-[1080px] gap-8 lg:mt-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section aria-labelledby="sports-games" className="min-w-0">
          <h2 id="sports-games" className="sr-only">Games</h2>
          <LeaguePicker value={sport} onChange={setSport} />
          <GameList
            sport={sport}
            board={board}
            selectedGameId={game?.gameId ?? null}
            onSelect={(next) => { setGame(next); setBacksHome(true); setPostError(null); }}
            className="mt-4 bg-paper"
          />
        </section>

        <section aria-labelledby="sports-post" className="lg:sticky lg:top-8 lg:self-start">
          <h2 id="sports-post" className="mb-3 text-body font-bold">Your ticket</h2>
          <Ticket {...preview} id={undefined} />

          <div className="mt-6 space-y-5 rounded-[20px] bg-paper p-5">
            {game ? (
              <Field label="Your side" hint={`Whoever accepts gets ${backsHome ? game.awayTeam : game.homeTeam}.`}>
                <SidePicker game={game} backsHome={backsHome} onChange={setBacksHome} />
              </Field>
            ) : (
              <p className="text-label text-ink-soft">Pick a game to choose your side.</p>
            )}

            <CurrencyPicker options={currencyOptions} value={currency} onChange={setCurrency} />

            <Field
              label="Stake"
              htmlFor={stakeId}
              hint={currency === "PTS" ? "Each side puts this in. Points are held until the game is final." : "Each side puts this in."}
              error={stake && stakeProblem ? stakeProblem : undefined}
            >
              <StakeInput
                id={stakeId}
                currency={currency}
                value={stake}
                onChange={(next) => { setStakeTouched(true); setStake(next); }}
                invalid={Boolean(stake && stakeProblem)}
              />
            </Field>

            {loaded && groups.length === 0 ? (
              <div>
                <p className="text-label font-semibold">Post it to a group</p>
                <p className="mt-0.5 text-label text-ink-soft">You're not in any groups yet.</p>
                <Button size="sm" className="mt-2" onClick={onGoToChats}>Start a group</Button>
              </div>
            ) : groups.length <= 4 ? (
              <Field label="Post to">
                <Segmented
                  label="Post to"
                  value={groupId}
                  onChange={setGroupId}
                  size="sm"
                  options={groups.map((g) => ({ value: g.id, label: g.name }))}
                />
              </Field>
            ) : (
              <Field label="Post to" htmlFor={groupSelectId}>
                <select
                  id={groupSelectId}
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                  className="block min-h-12 w-full rounded-xl border border-rule bg-paper px-3 text-body"
                >
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
            )}

            {postError && <InlineError>{postError}</InlineError>}
            <Button variant="primary" className="w-full" disabled={!canPost} onClick={() => { void post(); }}>
              {posting ? "Posting…" : group ? `Post to ${group.name}` : "Post bet"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
