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
