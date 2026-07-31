# App-Wide Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ten unstyled app routes the landing page's visual language, via a shared token layer and a small set of UI primitives.

**Architecture:** Promote the design tokens and component classes that already exist inside `src/app/page.module.css` (scoped to `.landing`) into `:root` and a shared `src/components/ui/` layer, then compose the ten routes from those primitives. Dark is the default theme; a light variant is provided under `prefers-color-scheme: light`. Every change is presentational — no logic, query, or handler is touched.

**Tech Stack:** Next.js App Router, React server components, CSS Modules, plain `globals.css`, Vitest (node environment).

**Spec:** `docs/superpowers/specs/2026-07-31-app-styling-design.md`

## Global Constraints

- **Presentation only.** No edits to logic, queries, validation, or request handlers. The existing 223 tests are the regression net and must stay green.
- **Never uppercase or letter-space a TRON address, email, or amount.** `text-transform: uppercase` applies to headings only.
- **Every amount and address renders in `.mono` with `font-variant-numeric: tabular-nums`.**
- **The focus ring `outline: 3px solid var(--hazard)` with `outline-offset: 2px` is never removed**, only restyled.
- **`prefers-reduced-motion: reduce` disables all animation**, including the landing's existing `.liveDot` pulse.
- **All token pairs meet WCAG AA (4.5:1) for body text in both themes.**
- **No new runtime dependencies.** Primitives are local CSS Modules.
- **Dark token values are byte-identical to the current `.landing` values.** The landing page is therefore unchanged *in dark mode*.
- **The landing page now follows the OS theme.** It previously hard-coded the dark tokens on `.landing` and rendered dark everywhere; inheriting from `:root` means a light-mode visitor now sees it light. This was ruled intended on 2026-07-31 after the consequence was raised explicitly. Consequence to carry forward: the landing's hazard-tape and "void" art direction was designed against near-black and has never been seen light, so Task 10's visual pass must include `/` in light mode and treat it as unreviewed design rather than a known-good page.
- **The test suite runs locally.** Docker is running on the dev machine this session, so `npm run db:up && npm run db:migrate` brings up the dev Postgres on port 5434 and `npx vitest run` gives 223 passing. Verified before Task 1. If the database is not up, 20 test files fail with `ECONNREFUSED 127.0.0.1:5434` — that is a missing database, not a regression. Only the production image build and deploy (Task 10) need the droplet.

---

## File Structure

**Created:**
- `tests/styles/helpers/css.ts` — parse custom properties out of a CSS file; compute WCAG contrast
- `tests/styles/tokens.test.ts` — token presence, both themes, contrast floors
- `tests/styles/guardrails.test.ts` — uppercase/mono rules that protect addresses and amounts
- `src/components/ui/Panel.tsx` + `Panel.module.css`
- `src/components/ui/Tape.tsx` + `Tape.module.css`
- `src/components/ui/Button.tsx` + `Button.module.css`
- `src/components/ui/Callout.tsx` + `Callout.module.css`
- `src/components/ui/Stat.tsx` + `Stat.module.css`
- `src/components/ui/DataTable.tsx` + `DataTable.module.css`
- `src/components/ui/EmptyState.tsx` + `EmptyState.module.css`
- `src/components/ui/index.ts` — single import surface

**Modified:**
- `src/app/globals.css` — tokens at `:root`, light block, element base layer
- `src/app/page.module.css` — `.landing` stops redeclaring tokens
- `src/components/Nav.tsx`, `Money.tsx`, `AuthForm.tsx`, `WithdrawForm.tsx`, `TotpEnrolment.tsx`, `DepositAddressPanel.tsx`, `BetForm.tsx`, `CreditForm.tsx`, `CreateFightForm.tsx`, `FightAdminControls.tsx`, `WithdrawalReviewControls.tsx`
- The ten route `page.tsx` files

**A note on testing styles.** There is no DOM test harness in this repo — all 223 tests are node-environment logic tests, and adding React Testing Library is out of scope. So the tests in this plan assert what can silently break and is checkable as data: token presence, contrast ratios, and the uppercase guardrail. Visual composition is verified by explicit human review steps, not by tests that would only assert that a file contains a string. Where a task has no meaningful automated test, it says so rather than inventing one.

---

### Task 1: Token layer and contrast harness

**Files:**
- Create: `tests/styles/helpers/css.ts`, `tests/styles/tokens.test.ts`
- Modify: `src/app/globals.css`, `src/app/page.module.css:7-25`

**Interfaces:**
- Consumes: nothing.
- Produces: `readCustomProperties(css: string, selector: string): Record<string, string>` and `contrastRatio(hexA: string, hexB: string): number` from `tests/styles/helpers/css.ts`. Ten CSS custom properties at `:root` — `--ink`, `--ink-dim`, `--void`, `--void-raised`, `--void-line`, `--hazard`, `--hazard-ink`, `--danger`, `--danger-panel`, `--ok` — available to every later task.

- [ ] **Step 1: Write the helper**

Create `tests/styles/helpers/css.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readCss(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

/** Custom properties declared in the first block matching `selector`. */
export function readCustomProperties(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (!block) return {}
  const out: Record<string, string> = {}
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim()
  }
  return out
}

/**
 * Body of the first `@media <query>` block, brace-balanced.
 *
 * A media query wraps its rules in their own braces, so the naive `[^}]*` match
 * above stops at the first inner `}` and returns nothing useful. Nested blocks
 * need real brace counting.
 */
export function readMediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = channel(parseInt(full.slice(0, 2), 16))
  const g = channel(parseInt(full.slice(2, 4), 16))
  const b = channel(parseInt(full.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA)
  const b = relativeLuminance(hexB)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/styles/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { contrastRatio, readCss, readCustomProperties, readMediaBlock } from './helpers/css'

const TOKENS = [
  '--ink', '--ink-dim', '--void', '--void-raised', '--void-line',
  '--hazard', '--hazard-ink', '--danger', '--danger-panel', '--ok',
]

const globals = readCss('src/app/globals.css')
const landing = readCss('src/app/page.module.css')

const darkTokens = () => readCustomProperties(globals, ':root')
const lightTokens = () =>
  readCustomProperties(readMediaBlock(globals, '(prefers-color-scheme: light)'), ':root')

describe('design tokens', () => {
  it('declares every token at :root', () => {
    const root = darkTokens()
    for (const token of TOKENS) expect(root, token).toHaveProperty(token)
  })

  it('keeps the dark values byte-identical to the landing page originals', () => {
    const root = darkTokens()
    expect(root['--void']).toBe('#0a0a0d')
    expect(root['--ink']).toBe('#f3efe6')
    expect(root['--hazard']).toBe('#f4c518')
    expect(root['--danger']).toBe('#e2402c')
    expect(root['--ok']).toBe('#4fd67a')
  })

  it('no longer redeclares tokens inside .landing', () => {
    expect(readCustomProperties(landing, '.landing')).toEqual({})
  })

  it('declares a light variant for every token', () => {
    const light = lightTokens()
    for (const token of TOKENS) expect(light, token).toHaveProperty(token)
  })

  it('gives light its own values rather than reusing the dark ones', () => {
    expect(lightTokens()['--hazard']).not.toBe(darkTokens()['--hazard'])
  })
})

describe('contrast', () => {
  const pairs: Array<[string, string]> = [
    ['--ink', '--void'],
    ['--ink', '--void-raised'],
    ['--ink-dim', '--void'],
    ['--hazard', '--void'],
    ['--danger', '--void'],
    ['--ok', '--void'],
  ]

  it.each(['dark', 'light'])('meets AA in the %s theme', (theme) => {
    const t = theme === 'dark' ? darkTokens() : lightTokens()
    expect(Object.keys(t).length, `${theme} tokens were not found`).toBeGreaterThan(0)
    for (const [fg, bg] of pairs) {
      expect(contrastRatio(t[fg], t[bg]), `${fg} on ${bg} (${theme})`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
```

The light tokens are read via `readMediaBlock`, which brace-balances the `@media` wrapper. The dark tokens come from the first top-level `:root`. Both `:root` blocks may therefore coexist in the file without the test confusing one for the other.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/styles/tokens.test.ts`
Expected: FAIL — `:root` has no tokens yet, and there is no light block.

- [ ] **Step 4: Move the tokens and add the light theme**

In `src/app/globals.css`, replace the first line (`:root { color-scheme: light dark; }`) with:

```css
:root {
  color-scheme: dark light;

  --ink: #f3efe6;
  --ink-dim: #b8b2a6;
  --void: #0a0a0d;
  --void-raised: #131316;
  --void-line: #232327;
  --hazard: #f4c518;
  --hazard-ink: #1a1500;
  --danger: #e2402c;
  --danger-panel: #2a1310;
  --ok: #4fd67a;
}

@media (prefers-color-scheme: light) {
  :root {
    --ink: #14140f;
    --ink-dim: #55524a;
    --void: #f7f4ec;
    --void-raised: #ffffff;
    --void-line: #ddd8cb;
    --hazard: #8a6a00;
    --hazard-ink: #fffaf0;
    --danger: #b3261e;
    --danger-panel: #fbeae8;
    --ok: #157f3c;
  }
}
```

The media query wraps `:root` in its own braces. `@media (prefers-color-scheme: light) :root { … }` is **invalid CSS** — a parser rejects it with an unexpected-token error — so do not flatten it.

The light values are not inversions. `--hazard: #f4c518` scores 12.1:1 on `--void` but only 1.6:1 on white, so light gets a darkened amber (`#8a6a00`, 4.6:1 on `#f7f4ec`). Likewise `--ok` and `--danger` are darkened. `--hazard-ink` and `--danger-panel` flip role: on light they are the pale surface behind hazard/danger text rather than a near-black one.

Every pair above was computed against the AA floor before this plan was written. All twelve pass, but three have almost no headroom and must not be lightened without re-running the test:

| Pair | Ratio |
|---|---|
| `--danger` on `--void` (dark) | 4.71:1 |
| `--ok` on `--void` (light) | 4.62:1 |
| `--hazard` on `--void` (light) | 4.61:1 |

The remaining nine sit between 5.9:1 and 18.5:1 — the lowest of them being light `--danger` on `--void` at 5.95:1.

In `src/app/page.module.css`, delete the ten custom-property declarations from the `.landing` block (lines 8–17), keeping every other declaration in that block. Update the comment above it to say the tokens now live in `globals.css`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/styles/tokens.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Verify the landing page is visually unchanged**

Run `npm run dev`, open `/`, and confirm in both themes that background, heading colour, hazard tape and button colours are as before. This is the one page that currently looks right, so it is the one with something to lose. If anything shifted, a declaration was deleted that was not a token.

- [ ] **Step 7: Commit**

```bash
git add src/app/globals.css src/app/page.module.css tests/styles/
git commit -m "style: lift design tokens to :root and add a light theme"
```

---

### Task 2: Element base layer

**Files:**
- Create: `tests/styles/guardrails.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: tokens at `:root` from Task 1.
- Produces: styled bare elements (`h1`–`h3`, `a`, `table`, `th`, `td`, `input`, `select`, `button`, `fieldset`, `label`, `legend`), plus global `.mono`, `.error`, `.estimate` classes. Later tasks assume unstyled semantic HTML already looks correct.

- [ ] **Step 1: Write the failing guardrail test**

Create `tests/styles/guardrails.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readCss } from './helpers/css'

const globals = readCss('src/app/globals.css')

/**
 * Selectors of every rule containing a declaration matching `declaration`.
 *
 * Walks back from each match to the `{` that opens its block, then to the
 * previous brace, so nested `@media` wrappers do not corrupt the selector.
 */
function selectorsDeclaring(css: string, declaration: RegExp): string[] {
  const out: string[] = []
  for (const match of css.matchAll(new RegExp(declaration.source, 'g'))) {
    const before = css.slice(0, match.index)
    const open = before.lastIndexOf('{')
    if (open === -1) continue
    const prev = Math.max(before.lastIndexOf('{', open - 1), before.lastIndexOf('}', open))
    out.push(before.slice(prev + 1, open).trim())
  }
  return out
}

const UPPERCASE = /text-transform\s*:\s*uppercase/
const ALLOWED_UPPERCASE = /^(h1|h2|h3|legend)(\s*,\s*(h1|h2|h3|legend))*$/

describe('legibility guardrails', () => {
  it('only uppercases headings and legends', () => {
    const selectors = selectorsDeclaring(globals, UPPERCASE)
    expect(selectors.length, 'expected at least one uppercase rule').toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector, `"${selector}" must not uppercase non-heading text`).toMatch(ALLOWED_UPPERCASE)
    }
  })

  it('never uppercases or tracks out monospace text', () => {
    for (const selector of selectorsDeclaring(globals, UPPERCASE)) {
      expect(selector).not.toContain('.mono')
    }
    for (const selector of selectorsDeclaring(globals, /letter-spacing\s*:/)) {
      expect(selector).not.toContain('.mono')
    }
  })

  it('renders monospace text with tabular numerals', () => {
    const mono = selectorsDeclaring(globals, /font-variant-numeric\s*:\s*tabular-nums/)
    expect(mono).toContain('.mono')
  })

  it('keeps a visible focus ring', () => {
    expect(globals).toMatch(/outline\s*:\s*3px solid var\(--hazard\)/)
  })

  it('respects reduced motion', () => {
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/styles/guardrails.test.ts`
Expected: FAIL — there is no `.mono`, no focus ring and no reduced-motion block in `globals.css` yet.

- [ ] **Step 3: Write the base layer**

Append to `src/app/globals.css`, replacing the existing bare element rules:

```css
body {
  margin: 0;
  padding: 0;
  background: var(--void);
  color: var(--ink);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  line-height: 1.5;
}

main {
  max-width: 60rem;
  margin: 0 auto;
  padding: 1.5rem;
}

h1, h2, h3 {
  font-family: 'Arial Black', 'Helvetica Neue', system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: -0.01em;
  line-height: 1.05;
  margin: 0 0 0.75rem;
}

h1 { font-size: clamp(1.75rem, 4vw, 2.5rem); }
h2 { font-size: 1.35rem; }
h3 { font-size: 1.1rem; }

a { color: var(--hazard); text-decoration: none; }
a:hover { text-decoration: underline; }

:focus-visible {
  outline: 3px solid var(--hazard);
  outline-offset: 2px;
}

.mono {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

table { border-collapse: collapse; width: 100%; }

th, td {
  border-bottom: 1px solid var(--void-line);
  padding: 0.6rem 0.75rem;
  text-align: left;
}

th {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  color: var(--ink-dim);
  border-bottom-color: var(--hazard);
}

td:has(.mono), td.numeric { font-variant-numeric: tabular-nums; }

fieldset {
  border: 1px solid var(--void-line);
  background: var(--void-raised);
  margin: 1rem 0;
  padding: 1rem;
}

legend {
  font-family: 'Arial Black', 'Helvetica Neue', system-ui, sans-serif;
  text-transform: uppercase;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  padding: 0 0.4rem;
}

label { display: block; margin: 0.75rem 0; color: var(--ink-dim); font-size: 0.85rem; }

input, select {
  display: block;
  width: 100%;
  margin-top: 0.3rem;
  font: inherit;
  padding: 0.55rem 0.7rem;
  color: var(--ink);
  background: var(--void);
  border: 1px solid var(--void-line);
}

input:focus, select:focus { border-color: var(--hazard); }

button { font: inherit; cursor: pointer; }
button:disabled { opacity: 0.55; cursor: not-allowed; }

.error {
  color: var(--danger);
  background: var(--danger-panel);
  border-left: 3px solid var(--danger);
  padding: 0.6rem 0.8rem;
}

.estimate { color: var(--ink-dim); font-size: 0.9em; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Note `main` now owns the page padding that `body` used to have. `.landing` compensates with `margin: -1.5rem`, which still matches this padding — do not change that value without changing `.landing` too.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/styles/guardrails.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: all existing tests still pass. Nothing here touches logic, so a failure means something unrelated broke.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css tests/styles/guardrails.test.ts
git commit -m "style: element base layer with legibility guardrails"
```

---

### Task 3: Panel, Tape and Button primitives

**Files:**
- Create: `src/components/ui/Panel.tsx`, `Panel.module.css`, `Tape.tsx`, `Tape.module.css`, `Button.tsx`, `Button.module.css`, `index.ts`

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces:
  - `<Panel title?: string, tone?: 'default' | 'danger', children: ReactNode>`
  - `<Tape />` — no props
  - `<Button variant?: 'primary' | 'ghost' | 'danger', ...ButtonHTMLAttributes>`
  - `src/components/ui/index.ts` re-exports all three.

There is no automated test for this task: these are presentational wrappers with no logic, and a test asserting a component renders a class name would only restate the implementation. Correctness is verified visually in Task 5 when the first page consumes them.

- [ ] **Step 1: Create Tape**

`src/components/ui/Tape.module.css` — lifted from `.tape` in `page.module.css`:

```css
.tape {
  height: 0.6rem;
  background: repeating-linear-gradient(
    -45deg,
    var(--hazard),
    var(--hazard) 1.2rem,
    var(--hazard-ink) 1.2rem,
    var(--hazard-ink) 2.4rem
  );
}
```

`src/components/ui/Tape.tsx`:

```tsx
import styles from './Tape.module.css'

export function Tape() {
  return <div className={styles.tape} aria-hidden="true" />
}
```

`aria-hidden` matters: it is decoration, and without it screen readers announce an empty element.

- [ ] **Step 2: Create Panel**

`src/components/ui/Panel.module.css`:

```css
.panel {
  background: var(--void-raised);
  border: 1px solid var(--void-line);
  margin: 1.5rem 0;
}

.danger { border-color: var(--danger); }

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0.9rem 1.1rem;
  border-bottom: 1px solid var(--void-line);
}

.danger .head { border-bottom-color: var(--danger); }

.title {
  font-family: 'Arial Black', 'Helvetica Neue', system-ui, sans-serif;
  text-transform: uppercase;
  font-size: 0.9rem;
  letter-spacing: 0.03em;
  margin: 0;
}

.body { padding: 1.1rem; }
```

`src/components/ui/Panel.tsx`:

```tsx
import type { ReactNode } from 'react'
import styles from './Panel.module.css'

export function Panel({
  title,
  tone = 'default',
  children,
}: {
  title?: string
  tone?: 'default' | 'danger'
  children: ReactNode
}) {
  return (
    <section className={`${styles.panel} ${tone === 'danger' ? styles.danger : ''}`}>
      {title && (
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  )
}
```

- [ ] **Step 3: Create Button**

`src/components/ui/Button.module.css` — lifted from `.btn`, `.btnPrimary`, `.btnGhost`:

```css
.btn {
  display: inline-block;
  font-family: 'Arial Black', 'Helvetica Neue', system-ui, sans-serif;
  text-transform: uppercase;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  padding: 0.7rem 1.2rem;
  border: 1px solid transparent;
  background: none;
  color: var(--ink);
  cursor: pointer;
}

.primary { background: var(--hazard); color: var(--hazard-ink); }
.primary:hover:not(:disabled) { filter: brightness(1.1); }

.ghost { border-color: var(--void-line); color: var(--ink); }
.ghost:hover:not(:disabled) { border-color: var(--hazard); }

.danger { background: var(--danger); color: var(--ink); }
.danger:hover:not(:disabled) { filter: brightness(1.1); }
```

`src/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
}

export function Button({ variant = 'primary', className = '', ...rest }: Props) {
  return <button className={`${styles.btn} ${styles[variant]} ${className}`} {...rest} />
}
```

Uppercase here is safe — button labels are never addresses or amounts.

- [ ] **Step 4: Create the import surface**

`src/components/ui/index.ts`:

```ts
export { Panel } from './Panel'
export { Tape } from './Tape'
export { Button } from './Button'
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/
git commit -m "feat: Panel, Tape and Button primitives"
```

---

### Task 4: Callout, Stat, DataTable and EmptyState primitives

**Files:**
- Create: `src/components/ui/Callout.tsx`, `Callout.module.css`, `Stat.tsx`, `Stat.module.css`, `DataTable.tsx`, `DataTable.module.css`, `EmptyState.tsx`, `EmptyState.module.css`
- Modify: `src/components/ui/index.ts`

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces:
  - `<Callout tone: 'info' | 'danger' | 'ok', title?: string, children: ReactNode>`
  - `<Stat label: string, children: ReactNode>` — value rendered in `.mono`
  - `<DataTable headers: string[], children: ReactNode>` — `children` are `<tr>` rows
  - `<EmptyState children: ReactNode>`
  - All exported from `src/components/ui/index.ts`.

As in Task 3, no automated test: presentational wrappers, verified visually when consumed.

- [ ] **Step 1: Create Callout**

`src/components/ui/Callout.module.css` — from `.notice`, `.noticeTitle`:

```css
.callout {
  border-left: 3px solid var(--ink-dim);
  background: var(--void-raised);
  padding: 0.9rem 1.1rem;
  margin: 1rem 0;
}

.info { border-left-color: var(--hazard); }
.danger { border-left-color: var(--danger); background: var(--danger-panel); }
.ok { border-left-color: var(--ok); }

.title {
  font-family: 'Arial Black', 'Helvetica Neue', system-ui, sans-serif;
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  margin: 0 0 0.4rem;
}

.body { margin: 0; color: var(--ink); }
```

`src/components/ui/Callout.tsx`:

```tsx
import type { ReactNode } from 'react'
import styles from './Callout.module.css'

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'danger' | 'ok'
  title?: string
  children: ReactNode
}) {
  return (
    <div className={`${styles.callout} ${styles[tone]}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <p className={styles.title}>{title}</p>}
      <div className={styles.body}>{children}</div>
    </div>
  )
}
```

`role="alert"` on the danger tone means a locked-account or failed-withdrawal message is announced rather than silently appearing.

- [ ] **Step 2: Create Stat**

`src/components/ui/Stat.module.css` — from `.statTile`, `.statValue`, `.statLabel`:

```css
.stat {
  background: var(--void-raised);
  border: 1px solid var(--void-line);
  padding: 1rem 1.1rem;
}

.label {
  display: block;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-dim);
  margin-bottom: 0.35rem;
}

.value {
  display: block;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: clamp(1.25rem, 3vw, 1.75rem);
  color: var(--ink);
}
```

The label is uppercase; the value is monospace and never uppercase, because values are amounts.

`src/components/ui/Stat.tsx`:

```tsx
import type { ReactNode } from 'react'
import styles from './Stat.module.css'

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{children}</span>
    </div>
  )
}
```

- [ ] **Step 3: Create DataTable**

`src/components/ui/DataTable.module.css`:

```css
.wrap { overflow-x: auto; }

.table { width: 100%; border-collapse: collapse; }
.table tbody tr:hover { background: var(--void-raised); }
```

Horizontal scroll is required: the withdrawal and admin tables carry TRON addresses, which do not wrap and will otherwise force the whole page sideways on a phone.

`src/components/ui/DataTable.tsx`:

```tsx
import type { ReactNode } from 'react'
import styles from './DataTable.module.css'

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Create EmptyState**

`src/components/ui/EmptyState.module.css` — from `.emptyState`:

```css
.empty {
  border: 1px dashed var(--void-line);
  color: var(--ink-dim);
  padding: 2rem 1rem;
  text-align: center;
}
```

`src/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>
}
```

- [ ] **Step 5: Extend the import surface**

Replace `src/components/ui/index.ts` with:

```ts
export { Panel } from './Panel'
export { Tape } from './Tape'
export { Button } from './Button'
export { Callout } from './Callout'
export { Stat } from './Stat'
export { DataTable } from './DataTable'
export { EmptyState } from './EmptyState'
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/
git commit -m "feat: Callout, Stat, DataTable and EmptyState primitives"
```

---

### Task 5: Nav, Money and the auth pages

**Files:**
- Create: `src/components/Nav.module.css`
- Modify: `src/components/Nav.tsx`, `src/components/Money.tsx`, `src/components/AuthForm.tsx`, `src/app/login/page.tsx`, `src/app/signup/page.tsx`

**Interfaces:**
- Consumes: `Button`, `Callout`, `Panel`, `Tape` from `@/components/ui`.
- Produces: `Money` and `Multiplier` render inside `.mono`, which every later task depends on for amount legibility.

- [ ] **Step 1: Put money in monospace**

Replace `src/components/Money.tsx`:

```tsx
import { formatUsdt } from '@/lib/money/units'

export function Money({ micros }: { micros: string | bigint | null }) {
  if (micros === null) return <span className="mono">—</span>
  return <span className="mono">{formatUsdt(BigInt(micros))} USDT</span>
}

export function Multiplier({ micros }: { micros: string | bigint | null }) {
  if (micros === null) return <span className="mono">—</span>
  return <span className="mono">{formatUsdt(BigInt(micros))}×</span>
}
```

The formatting logic is untouched — only the wrapping element gains a class.

- [ ] **Step 2: Rebuild Nav as a bar**

`src/components/Nav.module.css`:

```css
.bar {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
  padding: 0.9rem 1.5rem;
  background: var(--void-raised);
  border-bottom: 1px solid var(--void-line);
}

.link {
  font-family: 'Arial Black', 'Helvetica Neue', system-ui, sans-serif;
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  color: var(--ink);
  text-decoration: none;
}

.link:hover { color: var(--hazard); }

.spacer { margin-left: auto; }

.identity {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  color: var(--ink-dim);
}
```

`.identity` is not uppercase, because it contains an email address and a balance.

Replace the `return` in `src/components/Nav.tsx` (leave the data fetching above it exactly as it is):

```tsx
  return (
    <>
      <nav className={styles.bar}>
        <Link className={styles.link} href="/fights">Fights</Link>
        {user ? (
          <>
            <Link className={styles.link} href="/deposit">Deposit</Link>
            <Link className={styles.link} href="/withdraw">Withdraw</Link>
            <Link className={styles.link} href="/account">Account</Link>
            {user.isAdmin && <Link className={styles.link} href="/admin">Admin</Link>}
            <span className={`${styles.identity} ${styles.spacer}`}>
              <span>{user.email}</span>
              <Money micros={balance} />
            </span>
          </>
        ) : (
          <span className={styles.spacer}>
            <Link className={styles.link} href="/login">Log in</Link>
            {' '}
            <Link className={styles.link} href="/signup">Sign up</Link>
          </span>
        )}
      </nav>
      <Tape />
    </>
  )
```

Add to the imports: `import styles from './Nav.module.css'` and `import { Tape } from './ui'`. The `·` separators and the `<hr>` are gone — the bar and the tape replace them.

- [ ] **Step 3: Restyle AuthForm**

In `src/components/AuthForm.tsx`, keep every line of state and the `submit` handler exactly as they are. Replace only the returned markup:

```tsx
  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>{mode === 'login' ? 'Log in' : 'Sign up'}</legend>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'signup' ? 10 : 1}
            required
          />
        </label>
        {mode === 'signup' && <p className="estimate">At least 10 characters.</p>}
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
        </Button>
      </fieldset>
    </form>
  )
```

Add `import { Button, Callout } from '@/components/ui'`. The `<p className="error">` becomes a `Callout`, which also gains `role="alert"` — a login failure is now announced.

- [ ] **Step 4: Centre the auth pages**

In both `src/app/login/page.tsx` and `src/app/signup/page.tsx`, wrap the existing content so the form does not stretch to 60rem. Add to `globals.css`:

```css
.narrow { max-width: 26rem; margin: 3rem auto; }
```

and wrap each page's returned content in `<div className="narrow">…</div>`.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — no errors.
Run: `npx vitest run` — 223 tests still pass.
Run `npm run dev` and check `/login` and `/signup` in both themes: the nav is a bar with a hazard tape beneath it, the form sits in a narrow column, and a bad password shows a red callout.

- [ ] **Step 6: Commit**

```bash
git add src/components/ src/app/login src/app/signup src/app/globals.css
git commit -m "style: nav bar, monospace money, and styled auth pages"
```

---

### Task 6: Account and deposit pages

**Files:**
- Modify: `src/app/account/page.tsx`, `src/app/deposit/page.tsx`, `src/components/DepositAddressPanel.tsx`

**Interfaces:**
- Consumes: `Panel`, `Stat`, `DataTable`, `EmptyState`, `Callout` from `@/components/ui`; `Money` from Task 5.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Restyle the account page**

In `src/app/account/page.tsx`, keep every query and `await` exactly as written. Wrap the balance in a `Stat`, the bets in `Panel` + `DataTable`, and show an `EmptyState` when there are no bets:

```tsx
      <h1>Account</h1>

      <Stat label="Balance">
        <Money micros={balance} />
      </Stat>

      <Panel title="Bets">
        {bets.length === 0 ? (
          <EmptyState>No bets yet.</EmptyState>
        ) : (
          <DataTable headers={['Fight', 'Side', 'Stake', 'Payout']}>
            {bets.map((bet) => (
              /* keep the existing <tr> contents unchanged */
            ))}
          </DataTable>
        )}
      </Panel>
```

Match the header list to the columns the page actually renders; do not invent columns. Add `import { DataTable, EmptyState, Panel, Stat } from '@/components/ui'`.

- [ ] **Step 2: Make the deposit address unmistakable**

In `src/components/DepositAddressPanel.tsx`, keep all logic. Render the address at generous size in monospace, and never uppercase it:

```tsx
<Panel title="Your deposit address">
  <p className="mono depositAddress">{address}</p>
  <Callout tone="info" title="Before you send">
    USDT on the TRON network (TRC-20) only. Sending any other asset or using any
    other network will lose the funds permanently. Deposits credit after the
    required confirmations.
  </Callout>
</Panel>
```

Add to `globals.css`:

```css
.depositAddress {
  font-size: clamp(0.95rem, 2.6vw, 1.25rem);
  word-break: break-all;
  line-height: 1.4;
  padding: 0.9rem;
  background: var(--void);
  border: 1px solid var(--hazard);
  margin: 0 0 1rem;
}
```

`word-break: break-all` is deliberate: a TRON address must wrap rather than overflow, and it has no natural break points.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` and `npx vitest run` — clean, 223 passing.
Visually confirm on `/deposit` that the address is monospace, lower-case preserved, fully visible at 375px width, and not clipped.

- [ ] **Step 4: Commit**

```bash
git add src/app/account src/app/deposit src/components/DepositAddressPanel.tsx src/app/globals.css
git commit -m "style: account balance and deposit address presentation"
```

---

### Task 7: Withdraw page

**Files:**
- Modify: `src/app/withdraw/page.tsx`, `src/components/WithdrawForm.tsx`, `src/components/TotpEnrolment.tsx`

**Interfaces:**
- Consumes: `Panel`, `Callout`, `DataTable`, `EmptyState`, `Button`, `Stat` from `@/components/ui`.
- Produces: nothing later tasks depend on.

This page moves real money. Change markup and class names only — no edits to `MIN_WITHDRAWAL_MICROS` handling, balance checks, TOTP verification, or submission.

- [ ] **Step 1: Restyle the page shell**

In `src/app/withdraw/page.tsx`, keep the queries and the `row.locked` / `row.enabled` branching exactly as written. Replace the presentation:

```tsx
      <h1>Withdraw</h1>

      <Stat label="Available">
        <Money micros={balance} />
      </Stat>

      {row.locked ? (
        <Callout tone="danger" title="Withdrawals locked">
          Withdrawals are currently locked on this account. Contact support.
        </Callout>
      ) : row.enabled ? (
        <Panel title="Request a withdrawal">
          <WithdrawForm
            availableMicros={balance.toString()}
            minimumMicros={MIN_WITHDRAWAL_MICROS.toString()}
          />
        </Panel>
      ) : (
        <Panel title="Two-factor required">
          <TotpEnrolment />
        </Panel>
      )}

      <Panel title="History">
        {withdrawals.length === 0 ? (
          <EmptyState>No withdrawals yet.</EmptyState>
        ) : (
          <DataTable headers={['Requested', 'Amount', 'Destination', 'Status']}>
            {withdrawals.map((w) => (
              /* keep the existing <tr> contents unchanged */
            ))}
          </DataTable>
        )}
      </Panel>
```

Match headers to the columns actually rendered. Destination addresses must carry `className="mono"`.

- [ ] **Step 2: Restyle the forms**

In `WithdrawForm.tsx` and `TotpEnrolment.tsx`, swap `<button>` for `<Button>` and `<p className="error">` for `<Callout tone="danger">`. Leave state, validation and submission untouched. Any rendered amount or address gains `className="mono"`.

- [ ] **Step 3: Verify**

Run: `npx vitest run` — 223 tests pass. The withdrawal tests are the safety net for this task specifically; if any fail, logic was changed and must be reverted.
Run: `npx tsc --noEmit` — clean.
Visually confirm: a locked account shows a red callout, the amount field accepts input, and history addresses are monospace.

- [ ] **Step 4: Commit**

```bash
git add src/app/withdraw src/components/WithdrawForm.tsx src/components/TotpEnrolment.tsx
git commit -m "style: withdrawal request and history presentation"
```

---

### Task 8: Fights pages

**Files:**
- Create: `src/app/fights/fights.module.css`
- Modify: `src/app/fights/page.tsx`, `src/app/fights/[id]/page.tsx`, `src/components/BetForm.tsx`

**Interfaces:**
- Consumes: `Panel`, `Stat`, `Button`, `Callout`, `EmptyState` from `@/components/ui`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Port the landing page's fight card**

Copy the `.fightCard`, `.fightGrid`, `.fightNames`, `.fightMeta`, `.fightLeague`, `.liveBadge` and `.liveDot` rules from `src/app/page.module.css` into `src/app/fights/fights.module.css`, unchanged apart from removing any `.landing ` prefix. They already reference the tokens, which are now global, so they work unmodified.

Do not delete them from `page.module.css` — the landing page still uses them, and duplicating ~40 lines is cheaper than coupling the marketing page to the app's stylesheet.

- [ ] **Step 2: Render the fight list as cards**

In `src/app/fights/page.tsx`, keep the query. Replace the `<table>` with the card grid, showing an `EmptyState` when there are no fights. Each card links to `/fights/{id}` and shows the two names, the league, and the pool total via `<Money>`.

- [ ] **Step 3: Restyle the fight detail page**

In `src/app/fights/[id]/page.tsx`, keep all queries and settlement logic. Present pool totals and odds as `Stat` tiles, and wrap `BetForm` in a `Panel`. In `BetForm.tsx`, swap `<button>` for `<Button>` and `<p className="error">` for `<Callout tone="danger">`; leave bet placement logic untouched.

- [ ] **Step 4: Verify**

Run: `npx vitest run` and `npx tsc --noEmit` — clean.
Visually confirm the fight grid reflows to one column at 375px and that odds are monospace.

- [ ] **Step 5: Commit**

```bash
git add src/app/fights src/components/BetForm.tsx
git commit -m "style: fight list cards and fight detail"
```

---

### Task 9: Admin pages

**Files:**
- Modify: `src/app/admin/page.tsx`, `src/app/admin/fights/[id]/page.tsx`, `src/app/admin/withdrawals/page.tsx`, `src/components/FightAdminControls.tsx`, `src/components/WithdrawalReviewControls.tsx`, `src/components/CreateFightForm.tsx`, `src/components/CreditForm.tsx`

**Interfaces:**
- Consumes: `Panel`, `DataTable`, `Button`, `Callout`, `EmptyState`, `Tape` from `@/components/ui`.
- Produces: nothing later tasks depend on.

Approving a withdrawal moves real money. Markup only.

- [ ] **Step 1: Restyle the admin dashboard and fight admin**

In `src/app/admin/page.tsx` and `src/app/admin/fights/[id]/page.tsx`, wrap sections in `Panel` and tables in `DataTable`. In `FightAdminControls.tsx`, `CreateFightForm.tsx` and `CreditForm.tsx`, swap buttons for `<Button>` and errors for `<Callout tone="danger">`.

Settlement and cancellation controls go in `<Panel title="…" tone="danger">` with a `<Tape />` directly above the panel, and their buttons use `variant="danger"`.

- [ ] **Step 2: Restyle the withdrawal review queue**

In `src/app/admin/withdrawals/page.tsx`, render the queue with `DataTable` and an `EmptyState` when empty. Destination addresses and amounts carry `className="mono"` — this is the screen where an admin visually checks an address before releasing funds, so legibility here is the whole point.

In `WithdrawalReviewControls.tsx`, approve uses `variant="primary"`, reject uses `variant="danger"`. Leave the approval and rejection calls untouched.

- [ ] **Step 3: Verify**

Run: `npx vitest run` — 223 pass, admin and withdrawal tests especially.
Run: `npx tsc --noEmit` — clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin src/components/
git commit -m "style: admin dashboard, fight controls and withdrawal queue"
```

---

### Task 10: Full verification and deploy

**Files:**
- Modify: none, unless verification finds defects.

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed site.

- [ ] **Step 1: Confirm no logic changed**

Run:

```bash
git diff --stat d8c7478..HEAD -- src/lib/
```

Expected: empty. `src/lib/` holds the logic; if this diff is non-empty, a presentational task changed behaviour and must be reviewed before deploying.

- [ ] **Step 2: Run the full suite on the droplet**

```bash
ssh deploy@165.245.185.0
cd ~/botsbattle && git pull --ff-only
docker compose -f docker-compose.prod.yml --env-file .env.production build web
```

Then run the suite in the built image. Expected: 223 passing, plus the new style tests.

- [ ] **Step 3: Check every route in both themes**

Visit all eleven routes at 375px and 1280px width, in dark and light. Confirm for each: no horizontal page scroll, no unstyled default-serif text, focus rings visible when tabbing, and every address and amount in monospace and not uppercased.

- [ ] **Step 4: Deploy**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d web worker
curl -sI https://botsfight.com | head -1
```

Expected: `HTTP/2 200`. The rollback image `botsbattle:rollback-2e71ec6` already exists; if the new build misbehaves, `docker tag botsbattle:rollback-2e71ec6 botsbattle:latest && docker compose … up -d` restores the previous state.

- [ ] **Step 5: Commit and push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage.** Token layer → Task 1. Element base → Task 2. Seven primitives → Tasks 3–4. All ten routes → Tasks 5–9 (`/login`, `/signup` in 5; `/account`, `/deposit` in 6; `/withdraw` in 7; `/fights`, `/fights/[id]` in 8; three admin routes in 9). Guardrails → Task 2 tests plus per-task `.mono` requirements. Light theme → Task 1. Landing parity → Task 1 Step 6. 223 tests green → verified in Tasks 2, 5, 6, 7, 8, 9 and 10. Deploy → Task 10.

**Deliberately excluded**, per the spec: copy-to-clipboard on the deposit address, because it is behaviour rather than presentation and would void the "223 tests suffice" argument.

**Type consistency.** `Panel` takes `title`/`tone`/`children` everywhere. `Callout` takes `tone`/`title`/`children`, with `tone` values `info | danger | ok` used consistently. `Button` takes `variant` of `primary | ghost | danger`. `DataTable` takes `headers: string[]` plus `<tr>` children in every consumer. `Stat` takes `label`/`children` throughout.

**Known softness.** Tasks 8 and 9 describe markup transformations in prose rather than complete file bodies, because the exact row and column contents depend on fields this plan has not enumerated. Each says explicitly to preserve existing row contents and match headers to real columns rather than invent them. An implementer must read the current file before editing — which the interface blocks and step text call out.
