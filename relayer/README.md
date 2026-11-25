# Accountability relayer

The relayer uses its configured keypair as both transaction payer and commitment
oracle. Commitments must store this keypair's public key as `oracle_pubkey`.

```bash
export ORACLE_KEYPAIR=~/.config/solana/id.json
export SOLANA_RPC_URL=https://api.devnet.solana.com
yarn relayer
```

The shared deployment is available at `https://66.42.115.38.nip.io` (which
resolves to `66.42.115.38`). It runs behind Caddy, and
`deploy/relayer/accountabilibuddy-update.timer` checks the GitHub `main` branch
every minute. See `deploy/relayer/README.md` for provisioning and operations.

Resolve a commitment successfully (operator-only: requires `OPERATOR_TOKEN` to be
set on the relayer; the route returns 404 when it is unset):

```bash
curl -X POST http://localhost:8787/verify \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"commitmentId":"COMMITMENT_PDA"}'
```

The process also scans active commitments every 15 seconds and submits
permissionless `timeout` transactions for expired commitments.

## Sports bets (ESPN-settled, no witness)

1v1 and group-chat wagers on real game results. Both sides stake an equal
amount; the winner takes the pot once the relayer scrapes the final score from
ESPN. No witness is needed — the outcome is publicly verifiable.

On-chain instructions (`programs/accountability`):

- `create_bet` — creator stakes and picks a game, side (home/away), kickoff and
  settle time.
- `accept_bet` — opponent matches the stake and takes the other side (locks it).
- `cancel_bet` — creator reclaims their stake while the bet is still **open**.
- `back_out` — either party mutually cancels a **locked** bet, refunding both.
  Allowed only up to **5 minutes before kickoff** — never after.
- `settle_bet(home_won)` — oracle-only payout from the scraped result
  (`true`=home, `false`=away, `null`=draw → both refunded).

The relayer polls and settles locked bets whose `settle_after` has passed.

```bash
# List upcoming games + ESPN ids (soccer accepts a league: epl, laliga, seriea, bundesliga, ligue1, mls, ucl, worldcup)
curl 'http://localhost:8787/scoreboard?sport=soccer&league=epl'
curl 'http://localhost:8787/scoreboard?sport=nba'

# Inspect one game's result (null until final)
curl 'http://localhost:8787/game?sport=nba&id=401584793'

# List all on-chain sports bets, or force a settlement sweep (operator-only)
curl  http://localhost:8787/sports-bets
curl -X POST -H "authorization: Bearer $OPERATOR_TOKEN" http://localhost:8787/settle-bet
```

### Sports data providers (`relayer/sports/`)

- **ESPN** (default, `SPORTS_PROVIDER=espn`): the keyless public JSON API
  (`site.api.espn.com/apis/site/v2/sports/.../scoreboard?dates=YYYYMMDD` and
  `.../summary?event=<id>`). It is **unofficial**: ESPN publishes no terms for
  third-party use, there is no SLA, and it can change or block access at any
  time. Fine for devnet; get a licensed feed before settling real money on
  mainnet.
- **TheSportsDB** stays only for legacy bets (created when it was primary; their
  `espnGameId` holds a TheSportsDB id) and as an optional cross-check. The old
  public key `3` is permanently disabled (HTTP 403). Legacy bets settle only when
  `SPORTSDB_API_KEY` is set (the free test key `123` covers single-event lookups);
  otherwise the relayer logs once and leaves them for `refund_stale_bet`.

Bets store `sportsProvider` + `sportsEventId` (+ league and team ids). Kickoff,
teams and league always come from the provider at creation, and accepting
re-checks that the game hasn't started.

Settlement rules (`relayer/sports/settlement.ts`, `decideSportsSettlement`):

- Pays out only on an unambiguous **final** from a snapshot at most
  `SPORTS_RESULT_MAX_AGE_MS` old. If scores and the provider's winner flags
  disagree, the result is treated as unknown and the bet keeps waiting.
- Draws/ties refund both sides. In soccer the score is regular + extra time.
  Shootouts pay the shootout winner (`SPORTS_SOCCER_SHOOTOUT=winner`, the default)
  or refund (`=draw`).
- **Postponed/cancelled/abandoned** games refund both sides only once
  `SPORTS_CANCEL_GRACE_HOURS` (default 48) have passed since the scheduled
  kickoff. A replayed game that goes final inside the window settles normally.
- If the bet was accepted at or after the provider's actual kickoff (for example
  because the game was moved earlier), both sides are refunded.
- With `SPORTS_SECONDARY_PROVIDER` set, a final result needs the secondary to
  agree. On a disagreement, a team change, or no confirmation by the end of the
  grace window, the bet is flagged `sportsSettlementBlocked` with a reason and
  `OPERATOR ACTION REQUIRED` is logged. Unset the flag to retry.
- Anything else (pending, unknown, provider down) waits. If the oracle never
  settles a bet, the permissionless `refund_stale_bet` refunds it.

Fixture-based checks: `TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/sports/sports.check.ts`.

Drive the full lifecycle from the CLI (`yarn bet <cmd>`):

```bash
# Creator backs the home team of an NBA game
yarn bet create --sport nba --game 401584793 --side home --amount 0.1

# Opponent (different keypair) matches the stake
yarn bet accept --creator <creatorPubkey> --game 401584793 --keypair ~/opp.json

# Back out of a locked bet (>5 min before kickoff) — both refunded
yarn bet backout --creator <creatorPubkey> --game 401584793 --keypair ~/opp.json

yarn bet list
```

## Points mode (PTS, play money)

`POST /bets` accepts `currency: "PTS" | "SOL"`; `BET_CURRENCIES` (default
`PTS,SOL`, first entry = default when omitted) controls what's allowed. Points
have no cash value: no purchase, transfer, withdrawal, or SOL conversion exists.
PTS bets are escrowed off-chain by `relayer/points.ts` (`onChain: false`,
`pointsState: open | held | settled | refunded | burned`):

- Witness bets hold both stakes at acceptance; the crank pays the pot once
  `resolvedWinner` is set, or applies the return/burn fallback after the
  resolve-by date (charity is rejected for PTS).
- Sports bets hold the challenger at creation and the acceptor at acceptance
  (before kickoff); unaccepted at kickoff → refund; final result → payout, draw → refund.
- Balances live in `pointsBalances`, every movement in the append-only
  `pointsLedger` (unique idempotency `key`), so retries never double-pay and
  debits never overdraw.

```bash
curl -H "authorization: Bearer $TOKEN" http://localhost:8787/points          # balance, held, top-up, ledger
curl -X POST -H "authorization: Bearer $TOKEN" http://localhost:8787/points/topup
curl -H "authorization: Bearer $TOKEN" 'http://localhost:8787/leaderboard?currency=PTS'
curl -X POST -H "authorization: Bearer $OPERATOR_TOKEN" http://localhost:8787/points/crank  # operator-only

# checks (pure logic, then end-to-end against a throwaway local relayer + DB)
TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/points.check.ts
npx ts-node -T relayer/points.e2e.ts   # see the header of points.e2e.ts for the env it needs
```
