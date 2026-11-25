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
# List today's games + ESPN ids (soccer accepts a league, e.g. worldcup)
curl 'http://localhost:8787/scoreboard?sport=soccer&league=worldcup'
curl 'http://localhost:8787/scoreboard?sport=nba'

# Inspect one game's result (null until final)
curl 'http://localhost:8787/game?sport=nba&id=401584793'

# List all on-chain sports bets, or force a settlement sweep (operator-only)
curl  http://localhost:8787/sports-bets
curl -X POST -H "authorization: Bearer $OPERATOR_TOKEN" http://localhost:8787/settle-bet
```

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

## Proof, recurring check-in bets, stats

Witness (non-sports) bets can carry evidence and can be recurring habits. The
logic lives in `relayer/features.ts` (routing), `proofs.ts`, `checkins.ts`,
`schedule.ts` (pure schedule math) and `stats.ts` (pure stats). These modules
only ever decide outcomes by setting `resolvedWinner` (conditional write, like
the vote route); the payout cranks move the money.

- `POST /bets/:id/proof` — participant attaches an image (JSON
  `{ image: "data:…;base64,…" }` or a raw `image/*` body; ≤ 2 MB, JPEG/PNG/WebP/HEIC
  verified by magic bytes), an http(s) `link` and/or a `caption` (≤ 280 chars).
  Images are stored in the GridFS bucket `proofs`.
- `GET /proofs/:id` — streams an image to participants and chat members (bearer
  token, or the signed `?sig=` URL included in bet payloads for `<img src>`).
- `GET /bets/:id` — one bet with `proofs`, `proofCount`, `checkins`,
  `checkinProgress` and `viewerActions` (also added to `GET /bets` and the
  iMessage/Discord cards).
- `POST /bets` with `schedule` `{ daysOfWeek, timezone, startDate, endDate,
  windowStart?, windowEnd? }`, `requiredCheckins?`, `doer?` creates a recurring bet;
  `resolveByDate` is set to the last window's end + 48h.
- `POST /bets/:id/checkins` — the doer checks in (with proof) during an open window.
- `POST /bets/:id/checkins/:checkinId/review { approve }` — witnesses review; the
  bet's `witnesses` count is the threshold. `POST /bets/vote` returns 409 for
  recurring bets.
- `GET /stats/:username` — record, win/check-in streaks and head-to-head, from
  bets the viewer can already see.

Checks (no framework):

```bash
for f in schedule stats proofs witness-fallback; do
  TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/$f.check.ts
done
# Against a LOCAL relayer started with the same throwaway DB (it inserts test bets):
E2E_BASE=http://127.0.0.1:8787 MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB=baam-e2e \
  TS_NODE_TRANSPILE_ONLY=1 npx ts-node relayer/features.e2e.ts
```
