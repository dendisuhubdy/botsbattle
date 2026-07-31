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
