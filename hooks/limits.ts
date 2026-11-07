/**
 * Rate-limit logic, pure (no `$`), so it can be tested on its own. The figures
 * are Claude Code's own (`$.session.usage()` / `session.measure`).
 */

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' }
const LONG: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spend' }
export const THRESHOLDS = [75, 90, 100] as const
/** Below this share of the window elapsed, a forecast is mostly noise. */
const MIN_ELAPSED_FOR_PACE = 0.1

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export const shortName = (kind: string) => SHORT[kind] ?? kind
export const longName = (kind: string) => LONG[kind] ?? kind

/** Compact: 40m, 3h 10m, 6d (a day or more drops the hours). */
export const fmtSpan = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d`
}

export type Pace = { projected: number; hitsFullIn?: number }

/** Linear forecast from the share of the window already used and elapsed. */
export const pace = (limit: Limit, now: number): Pace | undefined => {
  const windowMs = WINDOW_MS[limit.kind]
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!windowMs || Number.isNaN(reset)) return undefined
  const left = reset - now
  const elapsed = windowMs - left
  if (left <= 0 || elapsed / windowMs < MIN_ELAPSED_FOR_PACE || limit.percentUsed <= 0) return undefined
  const ratePerMs = limit.percentUsed / elapsed
  const projected = Math.round(limit.percentUsed + ratePerMs * left)
  const toFull = (100 - limit.percentUsed) / ratePerMs
  return { projected, hitsFullIn: limit.percentUsed < 100 && toFull < left ? toFull : undefined }
}

const dot = (p: number) => (p >= 90 ? '🔴' : p >= 75 ? '🟡' : '🟢')

const order = (a: Limit, b: Limit) => (WINDOW_MS[a.kind] ?? Infinity) - (WINDOW_MS[b.kind] ?? Infinity)

/** One compact segment per window: `🟢 5h 12% · 3h 10m`, a ⚠ only when at risk. */
export const limitSegments = (limits: readonly Limit[], now: number): string[] =>
  [...limits].sort(order).map(l => {
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    const when = Number.isNaN(reset) ? '' : reset > now ? ` · ${fmtSpan(reset - now)}` : ' · resetting'
    const risk = pace(l, now)?.hitsFullIn
    const warn = risk !== undefined ? ` · ⚠ full in ${fmtSpan(risk)}` : ''
    return `${dot(l.percentUsed)} ${shortName(l.kind)} ${Math.round(l.percentUsed)}%${when}${warn}`
  })

/** The highest threshold this reading crossed, if any. */
export const crossed = (percentUsed: number) => [...THRESHOLDS].reverse().find(t => percentUsed >= t)

export const limitDetails = (limits: readonly Limit[], now: number) => {
  if (limits.length === 0) {
    return ['Limits: no reading yet. They arrive with a reply, on a Claude subscription only.']
  }
  return [...limits].sort(order).map(l => {
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    const when = Number.isNaN(reset)
      ? 'reset time unknown'
      : `resets in ${fmtSpan(reset - now)} (${new Date(reset).toLocaleString()})`
    const p = pace(l, now)
    const forecast = p
      ? p.hitsFullIn !== undefined
        ? `at this pace 100% in ~${fmtSpan(p.hitsFullIn)}, before the reset`
        : `at this pace ~${p.projected}% by the reset`
      : 'too early in the window for a forecast'
    return `Limit ${longName(l.kind)}: ${l.percentUsed}% used, ${when}; ${forecast}`
  })
}
