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

  const DARK_ORIGINALS: Record<string, string> = {
    '--ink': '#f3efe6',
    '--ink-dim': '#b8b2a6',
    '--void': '#0a0a0d',
    '--void-raised': '#131316',
    '--void-line': '#232327',
    '--hazard': '#f4c518',
    '--hazard-ink': '#1a1500',
    '--danger': '#e2402c',
    '--danger-panel': '#2a1310',
    '--ok': '#4fd67a',
  }

  it.each(Object.entries(DARK_ORIGINALS))(
    'keeps the dark value of %s byte-identical to the landing page original',
    (token, expected) => {
      expect(darkTokens()[token]).toBe(expected)
    },
  )

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
