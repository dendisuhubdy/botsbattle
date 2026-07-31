import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readCss } from './helpers/css'

const globals = readCss('src/app/globals.css')

/** Every `*.module.css` file under `src/`, relative to the repo root. */
function findModuleCssFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...findModuleCssFiles(full))
    } else if (entry.endsWith('.module.css')) {
      out.push(full)
    }
  }
  return out
}

const moduleCssPaths = findModuleCssFiles('src').map((p) => p.replace(/\\/g, '/'))
const moduleCssFiles = moduleCssPaths.map((path) => ({ path, css: readCss(path) }))

/**
 * Leaf rules (selector + declaration body) in `css` — i.e. rules with no
 * nested braces of their own. This deliberately also matches simple rules
 * nested inside `@media`/`@keyframes` wrappers (the wrapper's own "selector"
 * fails to match because its body contains a further `{`), which is exactly
 * the set of rules whose declarations are worth inspecting.
 */
function leafRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: match[1].trim(), body: match[2] })
  }
  return out
}

/**
 * CSS-module class names are local and arbitrary — a literal `.mono` substring
 * check only catches rules that happen to keep that name (see globals.css).
 * Module files must instead be matched structurally: any rule that sets a
 * monospace `font-family`, regardless of what its selector is called.
 */
const MONO_FONT_FAMILY = /font-family\s*:[^;]*monospace/i

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

  it('found at least one component stylesheet to scan', () => {
    // Guards against the glob silently matching nothing (e.g. a renamed src/ dir).
    expect(moduleCssPaths.length).toBeGreaterThan(0)
  })

  it('found at least one monospace rule to scan across *.module.css', () => {
    // Guards against MONO_FONT_FAMILY silently matching nothing (e.g. a syntax change).
    const found = moduleCssFiles.some(({ css }) => leafRules(css).some((r) => MONO_FONT_FAMILY.test(r.body)))
    expect(found).toBe(true)
  })

  it('never uppercases or tracks out monospace text in any *.module.css', () => {
    for (const { path, css } of moduleCssFiles) {
      for (const { selector, body } of leafRules(css)) {
        if (!MONO_FONT_FAMILY.test(body)) continue
        expect(
          UPPERCASE.test(body),
          `${path}: "${selector}" is monospace and must not declare text-transform: uppercase`,
        ).toBe(false)
        expect(
          /letter-spacing\s*:/.test(body),
          `${path}: "${selector}" is monospace and must not declare letter-spacing`,
        ).toBe(false)
      }
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
