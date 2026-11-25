# BAAM web app

Bet your friends in the group chat. React + Vite + Tailwind v4, built on the
"Tickets" design system in [`DESIGN.md`](./DESIGN.md): every bet renders as a
ticket. Four screens: Chats, Tickets, Sports and Standings.

## Run

```bash
npm install      # from this app/ directory
npm run dev      # http://localhost:5173
```

From the repo root you can also run `npm run app`.

## Wiring to the relayer

All data comes from the relayer's HTTP API (see `../relayer/index.ts`), wrapped
by `src/lib/relayer.ts`. Start it from the repo root:

```bash
npm run relayer  # http://localhost:8787
```

During local Vite development, the app defaults to `http://localhost:8787`.
Production defaults to the web app's current HTTPS origin. Set
`VITE_RELAYER_URL` only to point at a non-default relayer.

Network and build details (cluster, block height, oracle, commit) live in
Account > About BAAM.

## Where things live

- `src/styles/theme.css`: design tokens (CSS variables exposed to Tailwind via `@theme`).
- `src/app/components/ticket/Ticket.tsx` + `ticket.css`: the only place ticket
  visuals are defined (full and compact variants, stamp motion).
- `src/app/components/ticket/BetTicket.tsx`: maps a relayer `Bet` to ticket props.
- `src/app/data.tsx`: shared polling of groups, bets, unread counts and notifications.
- `src/lib/bets.ts`: bet-state rules shared by every screen.

In development, `/?preview=tickets` renders every ticket state from fixtures.
That page is excluded from production builds.

---

Original Figma project:
https://www.figma.com/design/ZhxChvpt2CublNeyCm3pI3/Design-Social-Prediction-Dashboard
