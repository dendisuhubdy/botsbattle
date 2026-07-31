# App-wide styling — design

Date: 2026-07-31. Status: approved, not yet planned.

## The problem

Ten of the site's eleven routes have no styling. Only `/` has a stylesheet
(`src/app/page.module.css`, 8.2KB). Everything else — `/login`, `/signup`, `/account`,
`/deposit`, `/withdraw`, `/fights`, `/fights/[id]`, `/admin`, `/admin/fights/[id]`,
`/admin/withdrawals` — renders through the whole of `globals.css`, which is 521 bytes:
`system-ui`, a `max-width`, 1px `currentColor` table borders, and two utility classes.

That is browser-default HTML with a hairline border. The landing page shipped with a design
in `d8c7478`; the app pages behind it never got one.

This was diagnosed after a report that the site "still doesn't look nice". It is worth
recording what it is **not**, because the obvious guesses are all wrong and one of them
nearly cost a production rebuild:

- Not a build or deploy failure. Every `/_next/static` asset returns 200, both stylesheets
  included.
- Not a missing `.next/static` copy in the Dockerfile, the usual Next-in-Docker culprit.
- Not a Tailwind misconfiguration. There is no Tailwind in this project — no config file,
  nothing in `package.json`. Styling is CSS Modules plus `globals.css`.

Nothing is broken. The work was never done. A rebuild of the same commit would have produced
a byte-identical application and changed nothing.

## Decisions

**Scope:** all ten unstyled routes.

**Theme:** dark by default, with a working light variant under `prefers-color-scheme: light`.
This roughly doubles the token work, so the token layer is built for two themes from the
start rather than retrofitted.

**Tone:** the landing page's full personality carries into the app — hazard tape, Arial Black
uppercase headings, brutalist framing — on every page including `/deposit` and `/withdraw`.

The risk in that choice was raised and accepted: heavy visual treatment on screens where
people read balances and enter wallet addresses. It is mitigated by the legibility guardrails
below, which are not negotiable within the aesthetic. The look stays aggressive; the
money-critical text stays readable.

**Approach:** a shared base layer plus UI primitives, rather than per-page stylesheets.

The deciding factor is that the primitives already exist. `page.module.css` contains
`.btn`/`.btnPrimary`/`.btnGhost`, `.statTile`/`.statValue`/`.statLabel`,
`.fightCard`/`.fightGrid`, `.notice`/`.noticeTitle`/`.noticeList`, `.tape`,
`.section`/`.sectionHead`/`.sectionTitle`, `.emptyState` and `.mono` — all trapped in module
scope. This is not designing a system; it is promoting a proven vocabulary out of `.landing`
so the rest of the app can reach it.

Per-page CSS Modules were rejected: the app is eleven components sharing one vocabulary
(forms, tables, money, status), so ten parallel stylesheets would restate the same thing ten
times and drift as pages are added. A global base layer alone was rejected because hazard
tape and per-page framing need markup, so it could not deliver the agreed tone.

## Architecture

### Token layer

Move the ten custom properties from `.landing` to `:root` in `globals.css`, values unchanged:

```
--ink #f3efe6   --ink-dim #b8b2a6
--void #0a0a0d  --void-raised #131316  --void-line #232327
--hazard #f4c518  --hazard-ink #1a1500
--danger #e2402c  --danger-panel #2a1310
--ok #4fd67a
```

`.landing` stops redeclaring them and inherits. Because the dark values are byte-identical,
the landing page must be visually unchanged — a claim to verify, not assert.

The light block is genuinely new work and cannot be derived by inversion. `--hazard`
(`#f4c518`) carries text on near-black at acceptable contrast but fails on white, so light
needs its own hand-picked `--hazard` and `--ok`. Every token pair is checked at WCAG AA
(4.5:1 body text) in both themes.

### Element base

`globals.css` grows from 521 bytes into a real base layer covering display type for `h1`–`h3`,
form controls, tables, links, and the focus ring (the landing's existing
`3px solid var(--hazard)`, reused verbatim).

`Nav` is included here. It is currently `<Link>` elements joined by literal `·` separators and
terminated by an `<hr>`; it becomes a proper navigation bar.

### Primitives

New, in `src/components/ui/`. Each is promoted from an existing landing class rather than
invented:

| Primitive | Promoted from | Consumers |
|---|---|---|
| `Panel` | `.section`, `.sectionHead`, `.sectionTitle` | every page |
| `Tape` | `.tape` | page headers, danger zones |
| `Button` | `.btn`, `.btnPrimary`, `.btnGhost` | all forms |
| `Callout` | `.notice`, `.noticeTitle`, `.noticeList` | the 11 `.error` sites, locked accounts |
| `Stat` | `.statTile`, `.statValue`, `.statLabel` | balances, amounts |
| `DataTable` | new, built on the `table` base | fights, withdrawals, admin queues |
| `EmptyState` | `.emptyState` | "No withdrawals yet" and similar |

`Money` and `DepositAddressPanel` adopt `.mono`, which already exists.

## Per-page treatment

| Route | Treatment |
|---|---|
| `/login`, `/signup` | Centred `Panel` with `Tape` header, primary `Button`, `Callout` for errors |
| `/account` | Balance as `Stat`, bets as `DataTable`, `EmptyState` when none |
| `/deposit` | Address in `.mono` at generous size; confirmations explained in a `Callout` |
| `/withdraw` | Locked account as danger `Callout`; TOTP enrolment and form in `Panel`; history as `DataTable` |
| `/fights`, `/fights/[id]` | Reuses the landing's `.fightCard`/`.fightGrid`, now unscoped; odds as `Stat` |
| `/admin`, `/admin/fights/[id]`, `/admin/withdrawals` | `Panel` sections, `DataTable` queues, destructive controls behind `Tape`-marked danger framing |

## Guardrails

Two are load-bearing consequences of carrying full personality onto money screens:

1. **Never uppercase or letter-space a TRON address, email, or amount.**
   `text-transform: uppercase` in Arial Black makes a deposit address impossible to
   proofread, and sending USDT to a mistyped address is irreversible. Uppercase applies to
   headings only.
2. **`.mono` and `tabular-nums` on every amount and address**, so digits align in tables and
   `0`/`O` stay distinguishable.

Also required:

- The `3px solid var(--hazard)` focus ring is never removed, only restyled.
- `prefers-reduced-motion` is respected; the landing's `.liveDot` pulse is the existing case.
- Contrast verified at WCAG AA in both themes.

## Out of scope

No redesign of the landing page: it already has one, and the only change it sees is
inheriting tokens instead of declaring them. No new routes, no copy rewrites, no changes to
logic, queries, validation, or request handlers. No component library dependency — the
primitives are local CSS Modules. No dark/light toggle UI; the theme follows
`prefers-color-scheme`.

Deliberately excluded: a copy-to-clipboard button on the deposit address. It is an obvious
improvement and worth doing, but it is *behaviour*, not presentation. Admitting it here would
break the invariant the whole verification story rests on — that nothing but markup and
styles changed, so the 223 existing tests are a sufficient regression net. It should be its
own change, with its own test.

## Verification

Every change is presentational. No logic, query, or handler is edited, so the existing **223
tests must stay green** — that is the regression net for the withdrawal and admin paths,
which is why the plan must not touch anything but markup and styles.

Docker Desktop does not start on the development machine (it crashes when launched from a
shell), so as with Slice 4 the build and test run happen on the droplet.

Landing-page parity after the token move is verified explicitly rather than assumed, since it
is the one page that currently looks correct and therefore the one with something to lose.

Unlike the earlier no-op rebuild, deploying this does require a genuine rebuild and redeploy.

## Risks

- **Token relocation regresses the landing page.** Mitigated by identical dark values and an
  explicit parity check.
- **Presentational edits to `/withdraw` and `/admin/withdrawals` touch money paths.** Mitigated
  by changing only markup and styles, and by the test suite.
- **The light theme is under-tested** relative to dark, since dark is the default and the one
  most likely to be reviewed. Contrast checking both themes is a plan step, not an
  afterthought.
