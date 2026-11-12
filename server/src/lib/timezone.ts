// UTC offsets for IANA timezone names, via the platform's own tz database
// (Intl) — no timezone library needed. Used only by the suggestions score,
// where a one-hour DST wobble is harmless: the score is a ranking hint,
// not a scheduling decision.

/**
 * Current UTC offset of a timezone in hours (fractional for half-hour
 * zones like Asia/Kolkata, +5.5). Unknown names fall back to 0 (UTC)
 * rather than failing the request — a bad timezone string on one profile
 * must not break suggestions for everyone.
 */
export function utcOffsetHours(timeZone: string): number {
  try {
    const now = new Date()
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
    // The wall-clock time in the target zone, read back as if it were UTC:
    // the difference from the real instant is the zone's offset.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    )
    // Round to the nearest quarter hour — real zones are multiples of 15
    // minutes, and this absorbs the seconds that ticked by mid-computation.
    return Math.round(((asUtc - now.getTime()) / 3600000) * 4) / 4
  } catch {
    return 0
  }
}
