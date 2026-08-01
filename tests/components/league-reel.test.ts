import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LeagueReel, reelEmbedUrl } from '@/components/LeagueReel'

const markup = renderToStaticMarkup(createElement(LeagueReel))

const v = (id: string, start?: number) => ({ id, start })

describe('reelEmbedUrl', () => {
  it('puts the first video in the path and queues the rest', () => {
    const url = new URL(reelEmbedUrl([v('aaa'), v('bbb'), v('ccc')]))
    expect(url.pathname).toBe('/embed/aaa')
    expect(url.searchParams.get('playlist')).toBe('bbb,ccc')
  })

  it('omits the queue parameter for a single video', () => {
    const url = new URL(reelEmbedUrl([v('aaa')]))
    expect(url.pathname).toBe('/embed/aaa')
    expect(url.searchParams.has('playlist')).toBe(false)
  })

  it('uses the no-cookie host, since the site shows no cookie banner', () => {
    expect(new URL(reelEmbedUrl([v('aaa')])).host).toBe('www.youtube-nocookie.com')
  })

  it('never asks the player to autoplay', () => {
    expect(new URL(reelEmbedUrl([v('aaa')])).searchParams.has('autoplay')).toBe(false)
  })

  it('separates queued ids with a raw comma, not %2C', () => {
    // URLSearchParams escapes the separator; the player is only ever tested against the
    // raw form, so keep it raw.
    expect(reelEmbedUrl([v('aaa'), v('bbb'), v('ccc')])).toContain('playlist=bbb,ccc')
  })

  it('applies the lead video start offset', () => {
    expect(new URL(reelEmbedUrl([v('aaa', 51), v('bbb')])).searchParams.get('start')).toBe('51')
  })

  it('omits start entirely when the lead has no offset', () => {
    expect(new URL(reelEmbedUrl([v('aaa'), v('bbb', 51)])).searchParams.has('start')).toBe(false)
  })

  it('never emits a queued video offset, which YouTube would ignore anyway', () => {
    // Guards against a future change that tries to thread per-video offsets into the URL
    // and silently produces a start that applies to the wrong video.
    expect(reelEmbedUrl([v('aaa', 10), v('bbb', 99)])).not.toContain('99')
  })

  it('refuses an empty queue rather than emitting /embed/undefined', () => {
    expect(() => reelEmbedUrl([])).toThrow(/at least one video/)
  })
})

describe('LeagueReel', () => {
  it('embeds every video in the reel', () => {
    const src = markup.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&')
    expect(src, 'expected an iframe with a src').toBeTruthy()
    const url = new URL(src!)
    const queued = url.searchParams.get('playlist')?.split(',') ?? []
    const ids = [url.pathname.replace('/embed/', ''), ...queued]
    expect(ids).toHaveLength(8)
    expect(new Set(ids).size, 'no video should appear twice in the queue').toBe(ids.length)
    // Guards against someone pasting a full watch URL into REEL, which would silently
    // produce /embed/https:.
    for (const id of ids) expect(id).toMatch(/^[\w-]{11}$/)
  })

  /*
   * The whole point of the panel's copy. A live badge on this site means a fight is open and
   * stakeable; this is recorded video of bouts already fought. If someone writes "live" into
   * the panel, that is a misleading claim on a real-money page, not a wording nit.
   */
  it('never describes the recorded footage as live', () => {
    expect(markup).not.toMatch(/\blive\b/i)
  })

  it('carries the non-affiliation disclaimer next to the footage', () => {
    expect(markup).toMatch(/not affiliated with, endorsed by, or an official betting partner/)
    expect(markup).toMatch(/EngineAI/)
  })

  it('states that nothing shown can be bet on', () => {
    expect(markup).toMatch(/No bout shown here is\s+available to bet on/)
  })

  it('gives the iframe an accessible name', () => {
    expect(markup).toMatch(/<iframe[^>]*\stitle="[^"]+"/)
  })
})
