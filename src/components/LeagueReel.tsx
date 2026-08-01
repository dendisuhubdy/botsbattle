import styles from './LeagueReel.module.css'

/*
 * A video panel for the landing page, playing coverage of the Ultimate Robot Knock-out
 * Legend.
 *
 * Two constraints shape everything here, and neither is cosmetic:
 *
 * 1. None of this footage is ours. It is uploaded by independent channels covering a real
 *    league we have no relationship with. Naming that league on a gambling site already
 *    requires a disclaimer (see the note in src/app/page.tsx); putting its robots and marks
 *    on screen continuously requires the same one, which is why `Disclaimer` renders
 *    directly under the frame rather than somewhere further down the page.
 *
 * 2. Nothing here may read as "live". Elsewhere on this site a live badge means a fight is
 *    open and you can stake money on it. This is recorded video of bouts that are already
 *    over and were never bettable here. The word is deliberately absent from this file, and
 *    tests/components/league-reel.test.ts fails the build if it comes back.
 *
 * There is no official URKL stream to embed as of August 2026 — the league has not
 * announced one. If that changes, this becomes a one-line edit: replace REEL with the
 * single official video id, and revisit point 2 above, because then it genuinely is live.
 */

/**
 * Third-party uploads, verified embeddable. Lead with actual fight footage.
 *
 * `start` skips a presenter intro so the panel opens on fighting rather than on a talking
 * head. YouTube only honours it for the video in the path, not for queued ones, so only the
 * lead entry's offset has any effect — the rest are recorded so the intent survives a
 * reordering, and `reelEmbedUrl` reads it off whichever entry ends up first.
 */
const REEL = [
  { id: 'k2ty5NR2vQc', channel: 'CN.科技发布会' }, // The opening match itself — lead with the fight
  { id: '3QY62StK14k', channel: 'Chris Wabs', start: 51 }, // Rounds 1-3, English commentary
  { id: '5IMU5or-VFo', channel: 'Chris Wabs', start: 73 }, // Robots Fight for $1M Prize
  { id: 'NyhlafILpqk', channel: 'OTOFOOTAGE' }, // White Eagle vs Matador, opening exhibition
  { id: 'MUv2zFegmFQ', channel: 'AI Disrupt' },
  { id: 'DUbbBdSGHE8', channel: 'The Construct Robotics Institute' },
  { id: '4hFEiGC06zU', channel: 'InsiderXpress' },
  { id: 'GKqDjawv-6k', channel: 'Zoom Vantage' },
] as const

/**
 * The embed URL for a queue of videos.
 *
 * We do not own a YouTube account, so there is no playlist id to point at. YouTube's embed
 * player accepts an anonymous queue instead: the first video in the path, the rest in a
 * `playlist` parameter. `youtube-nocookie.com` because this site shows no cookie banner,
 * and `rel=0` so the end screen stays within the same channel rather than recommending
 * whatever the algorithm fancies next to our betting copy.
 *
 * The query is assembled by hand rather than with URLSearchParams, which escapes the
 * separating commas to `%2C`. A comma is a legal sub-delimiter in a query value and every
 * documented YouTube embed uses it raw, so there is no reason to hand the player a form
 * nobody tests against.
 *
 * `start` is emitted only when the lead entry declares one, and only ever for the lead:
 * YouTube applies it to the video in the path and ignores it for queued ids.
 *
 * Throws on an empty queue rather than emitting `/embed/undefined`, which renders as a
 * YouTube error frame that looks like our bug.
 */
export function reelEmbedUrl(reel: readonly { id: string; start?: number }[]): string {
  const [first, ...rest] = reel
  if (!first) throw new Error('reelEmbedUrl: needs at least one video')

  const query = [
    'rel=0',
    ...(first.start ? [`start=${first.start}`] : []),
    ...(rest.length > 0 ? [`playlist=${rest.map((v) => v.id).join(',')}`] : []),
  ]

  return `https://www.youtube-nocookie.com/embed/${first.id}?${query.join('&')}`
}

export function LeagueReel() {
  return (
    <div className={styles.reel}>
      <p className={styles.tag}>Recorded coverage · not a botsfight card</p>

      <div className={styles.frame}>
        <iframe
          src={reelEmbedUrl(REEL)}
          title="Recorded coverage of Ultimate Robot Knock-out Legend bouts"
          /* No `autoplay`: audible video that starts itself next to real-money betting copy
             is hostile, and browsers block it anyway. The viewer presses play. */
          allow="clipboard-write; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>

      <p className={styles.credit}>
        {/* Deduped: one uploader contributes more than one clip, and crediting them twice
            reads as a bug rather than as thoroughness. */}
        Footage from {[...new Set(REEL.map((v) => v.channel))].join(', ')}, via YouTube.
      </p>

      <p className={styles.disclaimer}>
        botsfight.com is not affiliated with, endorsed by, or an official betting partner of
        the Ultimate Robot Knock-out Legend, EngineAI or Quanmingxing Robotics. These are
        third-party uploads of bouts that have already been fought. No bout shown here is
        available to bet on, and no result shown here settles anything on this site.
      </p>
    </div>
  )
}
