# BAAM design system: "Tickets"

BAAM is betting with friends inside a group chat. The interface should feel like
a friendly chat app where every bet is a physical object you can hold: a ticket.
The ticket is the one bold element. Everything around it stays quiet.

Who it's for: friend groups (college, gym, roommates) settling "bet you won't"
arguments. Primary job: make a bet, see where every bet stands, settle it.

## Principles

1. **The ticket is the only loud thing.** Chat text, headers, lists and settings
   are plain ink on paper. Color lives on tickets (their stock) and stamps.
2. **Tickets are paper in every theme.** In dark mode the page goes dark, but a
   ticket keeps its colored stock and dark ink, like a real ticket on a dark table.
3. **State is the stock color + a stamp**, never a badge soup. A reader should
   know a ticket's state from across the room.
4. **One orchestrated motion:** the stamp landing when a ticket settles. Other
   motion only answers a person's action (sheet opens, ticket expands).
5. **No developer chrome.** No block heights, oracle keys, commit hashes, "LIVE
   SYNC" pills or breadcrumbs. Network/build details live in Account > About.
6. **Plain words.** Sentence case everywhere. No all-caps labels (stamps are the
   single exception, because a rubber stamp is literally all caps). No monospace.

## Color

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--counter` | `#E6EAEE` | `#121428` | Page background (the counter the tickets sit on) |
| `--paper` | `#FBFCFD` | `#1B1E36` | Chat pane, sheets, rails |
| `--ink` | `#1A1D35` | `#F1F2F8` | Text, primary buttons |
| `--ink-soft` | `#5A5F7A` | `#A3A8C3` | Secondary text, timestamps |
| `--rule` | `#D3D8E0` | `#2D3150` | Hairlines, input borders |
| `--stock-offer` | `#FFD84D` | `#F2CC45` | Ticket: open offer, waiting for a taker |
| `--stock-live` | `#9FE7C4` | `#8EDBB6` | Ticket: both sides in, in play |
| `--stock-verdict` | `#CBB8FF` | `#BBA6F5` | Ticket: waiting on witnesses / proof |
| `--stock-done` | `#E3E6EA` | `#C9CDD6` | Ticket: settled, refunded, expired |
| `--ticket-ink` | `#1A1D35` | `#1A1D35` | Text on tickets (same in both themes) |
| `--stamp-win` | `#D7263D` | `#D7263D` | PAID / WON stamp |
| `--stamp-neutral` | `#2B4EA2` | `#2B4EA2` | REFUNDED / VOID stamp |

- Primary button: `--ink` background, `--paper` text. Secondary: transparent with
  `--rule` border. Destructive: `--stamp-win` text on transparent.
- Focus: 2px `--ink` outline, 2px offset, plus a `--stock-offer` halo
  (`box-shadow: 0 0 0 5px var(--stock-offer)`). Always visible on keyboard focus.
- Check contrast: `--ink-soft` on `--paper` and `--ticket-ink` on every stock
  must pass WCAG AA for their text sizes.

## Type

One family: **Archivo** (variable, with the `wdth` axis), self-hosted via
`@fontsource-variable/archivo` (use its `wdth` build) — replaces Inter and
JetBrains Mono. Width is the expressive axis: condensed for money, wide for stamps.

| Role | Size / line | Weight | Width | Notes |
| --- | --- | --- | --- | --- |
| Body, chat text | 16 / 24 | 400 | 100 | Line length under 75ch |
| UI label, button | 14 / 20 | 500–600 | 100 | Sentence case |
| Small meta | 13 / 18 | 400 | 100 | Timestamps, helper text |
| Screen title | 22 / 28 | 700 | 112 | |
| Ticket terms | 19 / 26 | 600 | 100 | The bet in the bettor's words |
| Stake numerals | 40 / 40 | 800 | 62 | `font-variant-numeric: tabular-nums` |
| Stamp | 18 / 18 | 900 | 125 | Uppercase, `letter-spacing: .04em`, rotated −8° |

Minimum text size is 13px. Never use monospace.

## The ticket

```
 ╭──────────────────────────────┬─────────╮
 │ Jordan makes every 5am lift  ┊         │
 │ Mon–Fri                      ┊   0.25  │   ← stake, condensed 800
 │                              ┊   SOL   │
 │ jordan  vs  maya             ┊         │
 │ 2 witnesses, decide by Fri   ┊  [ ✓ ]  │   ← state icon / action
 ╰──────────────────────────────┴─────────╯
   main body (terms, people,      stub (stake, currency)
   witnesses, deadline)
```

- Shape: radius 14px outer; a perforation between body and stub drawn as a
  dashed vertical rule with two semicircle notches (top and bottom) cut out
  using a radial-gradient mask. Subtle paper shadow:
  `0 1px 0 rgba(26,29,53,.08), 0 8px 24px -12px rgba(26,29,53,.35)`.
- Stock color = state (see Color). Stamp overlays the body for terminal states:
  `PAID TO JORDAN`, `REFUNDED`, `EXPIRED`, `VOID`.
- Status line (one line, plain words): "Waiting for maya to accept",
  "In play", "Witnesses deciding: 1 of 2 votes", "Paid to jordan",
  "Refunded: no verdict by the deadline", "Expired: nobody accepted".
- Actions sit at the bottom of the body as text buttons: Accept, Pass, Vote,
  Add proof, View on Solana explorer (only for on-chain tickets).
- Sizes: in chat, max-width 520px; in lists, full width of the column; a compact
  variant (single row, stub on the right) for rails.
- Points vs SOL: the stub shows `PTS` or `SOL`. Points tickets never show
  explorer links.

### The one motion
When a ticket reaches a terminal state while visible (or is opened for the first
time after settling), the stamp lands: from `scale(1.6) rotate(-14deg)` and
opacity 0 to `scale(1) rotate(-8deg)` in ~220ms with a slight overshoot, then
the stock fades to `--stock-done` over 400ms. With `prefers-reduced-motion`,
show the final state with no animation.

## Layout

Left-aligned everywhere. Mobile first.

```
Mobile (<768px)                 Desktop (≥1024px; right rail ≥1280px)
┌──────────────────────┐        ┌────────┬──────────────────────┬──────────┐
│ ‹  Gym rats      ⋯   │        │ BAAM   │ Gym rats         ⋯   │ Your     │
│──────────────────────│        │        │──────────────────────│ tickets  │
│ maya                 │        │ Chats  │ maya                 │ ┌──────┐ │
│ who's hitting 5am?   │        │ Tickets│ who's hitting 5am?   │ │ tick │ │
│ jordan               │        │ Sports │ ╭───────────────┬──╮ │ └──────┘ │
│ ╭────────────────┬─╮ │        │ Stand- │ │ ticket        │  │ │ ┌──────┐ │
│ │ ticket         │ │ │        │  ings  │ ╰───────────────┴──╯ │ │ tick │ │
│ ╰────────────────┴─╯ │        │────────│                      │ └──────┘ │
│ [New bet] Message… ➤ │        │ groups │ [New bet] Message… ➤ │          │
│──────────────────────│        │ list   │                      │          │
│ Chats Tickets Sports │        │        │                      │          │
│ Standings            │        │ you ⚙  │                      │          │
└──────────────────────┘        └────────┴──────────────────────┴──────────┘
```

- Navigation: **Chats, Tickets, Sports, Standings.** Bottom tab bar on mobile,
  left rail on desktop. ("Escrow Card" becomes **Tickets**: every bet you're in.)
- Chat messages are plain rows (name, then text), grouped by sender, no bubbles.
  Tickets break that rhythm on purpose.
- Chat column max width 760px; rails 280px (left) and 320px (right).
- Sheets (new bet, proof, group settings) slide up on mobile and appear as a
  centered panel on desktop.

## Writing

- Name things by what people do: "New bet", "Accept", "Vote", "Add proof",
  "Invite friends". The button that says "Accept" produces "Accepted".
- Empty states invite an action: "No bets in this chat yet. Start one with New
  bet." Never repeat the same empty message in every row of a list.
- Errors say what happened and what to do, without apology and without raw URLs
  or stack traces: "Couldn't load games right now. Try again in a minute."
- Money: "0.25 SOL", "500 pts". No "LAMPORTS", no wallet addresses in body copy.

## Implementation rules

- Tokens live in `src/styles/theme.css` as CSS variables and are exposed to
  Tailwind v4 via `@theme`; components use Tailwind classes, not
  `style={{ … }}` objects.
- One `Ticket` component (with `variant="full" | "compact"`) is the only place
  ticket visuals are defined.
- Respect `prefers-reduced-motion`; keyboard focus always visible; tap targets
  at least 44px on touch.
