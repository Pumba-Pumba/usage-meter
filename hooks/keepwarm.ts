/**
 * Keep-warm, pure (no `$`): when to ping, and whether a ping found the cache
 * still warm. Off unless the person turns it on with `/meter keepwarm`.
 *
 * A ping is a tool-less fork of the main conversation (`$.model.fork`) with a
 * one-word prompt: it reads the cached prefix, which restarts its lifetime,
 * and costs a cache read plus a short reply instead of a full re-cache. The
 * idea and the warm test follow cache-tax by Karan Bansal (MIT).
 */

import { TTL_MS } from './cache'
import type { CacheState, Ttl } from './cache'

export const PING_PROMPT = 'Reply with the single word: warm'
export const DEFAULT_WINDOW_MS = 3 * 60 * 60_000
export const MAX_WINDOW_MS = 24 * 60 * 60_000
export const MAX_RETRIES = 3
export const RETRY_MS = 60_000

/** How long before expiry a ping goes out: room for one retry on 1h, a safe margin on 5m. */
const LEAD_MS: Record<Ttl, number> = { '5m': 60_000, '1h': 10 * 60_000 }

/** What a running keep-warm window holds. */
export type Warm = {
  /** When the window ends; 0 when keep-warm is off. */
  until: number
  pings: number
  /** What the pings cost at list price, summed. */
  usd: number
  /** Why it stopped by itself, shown until it is turned on again. */
  stopped: string | null
  /** Retries of the ping now due. */
  retries: number
}

export const idle = (): Warm => ({ until: 0, pings: 0, usd: 0, stopped: null, retries: 0 })

/** Parses `90m`, `3h`, `1h30m`; undefined for anything else or past the cap. */
export const parseWindow = (text: string): number | undefined => {
  const m = /^\s*(?:(\d+)h)?(?:(\d+)m)?\s*$/i.exec(text)
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000
  return ms > 0 && ms <= MAX_WINDOW_MS ? ms : undefined
}

/**
 * When the next ping is due, or why none is: `wait` until a reply gives the
 * cache something to keep (none yet, after `/compact`, or already cold, since
 * a ping into a cold cache would pay the very re-cache it exists to avoid),
 * `end` when the window closes before a ping would be needed.
 */
export const plan = (
  cache: CacheState,
  warm: Warm,
  now: number,
): { kind: 'off' } | { kind: 'end'; at: number } | { kind: 'wait' } | { kind: 'ping'; at: number } => {
  if (warm.until === 0) return { kind: 'off' }
  if (now >= warm.until) return { kind: 'end', at: now }
  const last = cache.last
  if (last === null) return { kind: 'wait' }
  const expires = last.at + TTL_MS[cache.ttl]
  if (now >= expires) return { kind: 'wait' }
  const at = Math.max(now, expires - LEAD_MS[cache.ttl])
  return at >= warm.until ? { kind: 'end', at: warm.until } : { kind: 'ping', at }
}

/**
 * A warm ping reads the prefix and writes only its own short message; one
 * that wrote a tenth of what it read, or more, found the prefix gone.
 */
export const isWarmPing = (u: { cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens

/** A failure worth trying again a minute later: a busy or failing API, or no response at all. */
export const isRetryable = (status: number | null) => status === null || status === 429 || status >= 500
