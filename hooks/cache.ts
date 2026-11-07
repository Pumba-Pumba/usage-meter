/**
 * Prompt-cache logic, pure (no `$`), so it can be tested on its own.
 *
 * - Expiry is a sliding window: every request that reads the cache resets it,
 *   so the deadline is "last request + TTL".
 * - The TTL (5m or 1h) is learned from what the API does: a request sent after
 *   a 5-60 minute gap that still reads the cache proves 1h; one that reads
 *   nothing proves 5m. It can also be set by hand.
 */

export type Ttl = '5m' | '1h'
export type TtlSource = 'learned' | 'manual' | 'assumed'

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
/** A drop in cache reads smaller than this is noise, not a re-cache. */
const MISS_MIN_TOKENS = 2_000

export type Step = { at: number; input: number; cacheRead: number; cacheWrite: number }

export type CacheState = {
  ttl: Ttl
  ttlSource: TtlSource
  last: Step | null
  totalInput: number
  totalRead: number
  misses: number
  missTokens: number
  warnedFor: number | null
}

export const fresh = (): CacheState => ({
  ttl: '1h',
  ttlSource: 'assumed',
  last: null,
  totalInput: 0,
  totalRead: 0,
  misses: 0,
  missTokens: 0,
  warnedFor: null,
})

export const promptTokens = (s: Step) => s.input + s.cacheRead + s.cacheWrite

/** Folds one main-thread response into the state. */
export const record = (state: CacheState, step: Step): CacheState => {
  const next: CacheState = {
    ...state,
    last: step,
    totalInput: state.totalInput + promptTokens(step),
    totalRead: state.totalRead + step.cacheRead,
    warnedFor: null,
  }
  const prev = state.last
  if (prev === null) return next

  const gap = step.at - prev.at
  const prevPrompt = promptTokens(prev)
  const lost = prevPrompt - step.cacheRead
  const isMiss = lost >= MISS_MIN_TOKENS && step.cacheRead < prevPrompt * 0.5

  // Learn the TTL from evidence; a manual choice is never overridden.
  const isMidGap = gap > TTL_MS['5m'] && gap < TTL_MS['1h']
  if (state.ttlSource !== 'manual' && prevPrompt >= MISS_MIN_TOKENS && isMidGap) {
    if (!isMiss) {
      next.ttl = '1h'
      next.ttlSource = 'learned'
    } else if (step.cacheRead === 0) {
      next.ttl = '5m'
      next.ttlSource = 'learned'
    }
  }

  // A re-cache after the window lapsed is expected; one inside it is not
  // (a model switch, an edited system prompt, a changed tool list).
  if (isMiss && gap < TTL_MS[next.ttl]) {
    next.misses += 1
    next.missTokens += step.cacheWrite + step.input
  }

  return next
}

/**
 * What a session keeps between launches, so a resumed session knows when its
 * last reply was (and so whether the cache is still warm) instead of starting
 * over. The TTL is kept apart, across all sessions.
 */
export type Saved = Pick<CacheState, 'last' | 'totalInput' | 'totalRead' | 'misses' | 'missTokens'>

export const toSaved = (s: CacheState): Saved => ({
  last: s.last,
  totalInput: s.totalInput,
  totalRead: s.totalRead,
  misses: s.misses,
  missTokens: s.missTokens,
})

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const isStep = (v: unknown): v is Step => {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return isNum(s.at) && isNum(s.input) && isNum(s.cacheRead) && isNum(s.cacheWrite)
}

/** Folds what a session saved into a fresh state; anything malformed is ignored. */
export const restore = (state: CacheState, saved: unknown): CacheState => {
  if (typeof saved !== 'object' || saved === null) return state
  const v = saved as Record<string, unknown>
  if (!isStep(v.last) || !isNum(v.totalInput) || !isNum(v.totalRead) || !isNum(v.misses) || !isNum(v.missTokens)) {
    return state
  }
  return {
    ...state,
    last: { at: v.last.at, input: v.last.input, cacheRead: v.last.cacheRead, cacheWrite: v.last.cacheWrite },
    totalInput: v.totalInput,
    totalRead: v.totalRead,
    misses: v.misses,
    missTokens: v.missTokens,
  }
}

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const hitRate = (state: CacheState) =>
  state.totalInput > 0 ? Math.round((state.totalRead / state.totalInput) * 100) : 0

/** The compact segment for the shared status line; undefined before a reply. */
export const cacheSegment = (state: CacheState, now: number): string | undefined => {
  const last = state.last
  if (last === null) return undefined
  const ttlMs = TTL_MS[state.ttl]
  const left = last.at + ttlMs - now
  const miss = state.misses > 0 ? ` · ${state.misses} miss${state.misses > 1 ? 'es' : ''}` : ''
  if (left <= 0) return `🔴 cache cold · ~${fmtTokens(promptTokens(last))} to re-cache${miss}`
  const dot = left / ttlMs < 0.2 ? '🟡' : '🟢'
  const unsure = state.ttlSource === 'assumed' ? '?' : ''
  return `${dot} cache ${fmtClock(left)}${unsure} · hit ${hitRate(state)}%${miss}`
}

/** Warn once per cache window, in its last 10% (6m of 1h, 30s of 5m). */
export const shouldWarn = (state: CacheState, now: number) => {
  const last = state.last
  if (last === null || state.warnedFor === last.at) return false
  const ttlMs = TTL_MS[state.ttl]
  const left = last.at + ttlMs - now
  return left > 0 && left <= ttlMs * 0.1
}

export const cacheDetails = (state: CacheState, now: number) => {
  const last = state.last
  if (last === null) return ['Cache: no model reply yet in this session.']
  const left = last.at + TTL_MS[state.ttl] - now
  const lines = [
    left > 0
      ? `Cache: warm, ${fmtClock(left)} left (TTL ${state.ttl}, ${state.ttlSource})`
      : `Cache: cold; the next message re-caches ~${fmtTokens(promptTokens(last))} tokens (TTL ${state.ttl}, ${state.ttlSource})`,
    `  Conversation prefix ~${fmtTokens(promptTokens(last))} tokens; ${fmtTokens(state.totalRead)} of ${fmtTokens(state.totalInput)} prompt tokens served from cache (${hitRate(state)}%)`,
  ]
  if (state.misses > 0) {
    lines.push(`  Unexpected re-caches: ${state.misses} (~${fmtTokens(state.missTokens)} tokens re-sent)`)
  }
  if (state.ttlSource === 'assumed') {
    lines.push('  TTL is assumed until a pause of 5-60 min shows which it is; or set it: /meter ttl 5m|1h')
  }
  return lines
}
