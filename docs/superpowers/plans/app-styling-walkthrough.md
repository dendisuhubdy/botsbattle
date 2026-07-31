# App-wide styling — walkthrough

Shipped 2026-07-31. Plan: `2026-07-31-app-styling.md`. Spec: `../specs/2026-07-31-app-styling-design.md`.

## What shipped

Ten routes that rendered through 521 bytes of `globals.css` now share the landing page's
design language. 18 commits, 44 files, +1212/−334.

- Ten design tokens moved from `.landing` to `:root`, plus a hand-picked light palette.
- A real element base layer in `globals.css`.
- Seven primitives in `src/components/ui/` — Panel, Tape, Button, Callout, Stat, DataTable,
  EmptyState — each promoted from a class the landing page already had.
- All ten routes rebuilt on those primitives.

Verified at deploy: 247 tests passing, `tsc` clean, production build green, `src/lib/`
untouched across every commit, site back **6 seconds** after container swap, TLS and security
headers intact, worker polling.

## Decisions worth remembering

**The landing page now follows the OS theme.** It used to hard-code the dark tokens on
`.landing`, so it rendered dark everywhere. Inheriting from `:root` means a light-mode
visitor sees it light. Ruled intended, but its hazard-tape art direction was designed against
near-black and has still never been reviewed light.

**Contrast is measured, not eyeballed.** `tests/styles/tokens.test.ts` asserts every token
pair clears WCAG AA in both themes. Three pairs sit just above the floor — dark `--danger`
4.71:1, light `--ok` 4.62:1, light `--hazard` 4.61:1 — and must not be lightened without
re-running that test.

**Measure contrast against the surface a component actually renders on.** The danger Button
was verified at 4.71:1 against `--void` and shipped inside `<Panel tone="danger">`, whose
background is `--void-raised` — where it was really 4.42:1, below AA. Caught in the final
re-review, on the buttons that void fights and reject withdrawals. The page background is not
the surface.

## The bug that nearly shipped

`WithdrawalReviewControls` rendered the destination address inside a `<legend>`:

```jsx
<legend>Review — {amountLabel} to <code>{address}</code></legend>
```

The base layer styles `legend { text-transform: uppercase; letter-spacing: 0.04em }`. TRON
addresses are base58 and **case-sensitive**, so the admin approval screen displayed a
corrupted, invalid address — on the one screen whose entire purpose is verifying an address
before releasing funds. Live from `ea07f56` to `6cd675f`.

The guardrail test could not catch it: it checked that only headings and `legend` carry
uppercase. It had no way to know a `legend` *contained* an address. **The hazard is
content-dependent, not selector-dependent.** The test now matches structurally on rules
declaring a monospace `font-family` and asserts none of them uppercase or letter-space —
across `globals.css` and every `*.module.css`. It was mutation-tested against the real
`.value` rule in `Stat.module.css`, which is monospace but not named `.mono` and which the
earlier version of the test sailed straight past.

## Where information got lost

Three times, planning prose written about files that had not been opened understated what a
page rendered:

- The account bets table has 5 columns; the plan's example listed 4.
- The withdrawal history table has 5; the plan's example listed 4.
- The fight list's `Locks` column, and later its `Est. A`/`Est. B` columns, were dropped
  outright — `estimatedPayoutPerUsdt` was still being computed and thrown away.

All three were caught, by the instruction to read the real `<tr>` and never invent or drop a
column. Describing a file you have not read is how columns disappear.

## Still owed

- **Nobody has looked at this in a browser.** Every check was static analysis, computed
  contrast ratios, or HTTP status codes. The light theme especially, and `/` in light mode
  above all.
- Mobile breakpoints unverified at 375px.
- `/login` and `/signup` got `.narrow` and a bare fieldset rather than the spec's "centred
  Panel with Tape header", and are the only routes with no `<h1>`.
- `td:has(.mono)` needs Safari 16+ / Chrome 105+ / Firefox 121+; degrades harmlessly.
