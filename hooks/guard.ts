/**
 * The send-guard, pure (no `$`): what to do with a prompt sent into a cold
 * cache. It never blocks unless asked to: `warn` (the default) shows the price
 * and sends, `ask` asks first, at any price or from a dollar floor up.
 */

import { coldCost, expiresAt, fmtClock, fmtTokens } from './cache'
import type { CacheState } from './cache'
import { fmtUsd } from './price'

export type GuardMode = { kind: 'off' } | { kind: 'warn' } | { kind: 'ask'; floorUsd: number }

export const DEFAULT_GUARD: GuardMode = { kind: 'warn' }

/** A cold prefix smaller than this costs too little to mention. */
export const GUARD_MIN_TOKENS = 50_000

/**
 * Prompts a person typed and can send again after a "Don't send". Everything
 * else (a notification, a scheduled trigger, a peer, the SDK) is never held:
 * nobody would be there to send it again, so it goes through with the price.
 */
const ASKABLE = new Set(['composer', 'bridge'])

export type Verdict =
  | { action: 'send' }
  | { action: 'warn' | 'ask'; text: string; usd: number | undefined; tokens: number }

/** Reads what `/meter guard` stored; anything unrecognised is the default. */
export const guardFrom = (v: unknown): GuardMode => {
  if (v === 'off') return { kind: 'off' }
  if (v === 'warn') return { kind: 'warn' }
  if (v === 'ask') return { kind: 'ask', floorUsd: 0 }
  if (typeof v === 'object' && v !== null) {
    const floor = (v as { ask?: unknown }).ask
    if (typeof floor === 'number' && Number.isFinite(floor) && floor >= 0) return { kind: 'ask', floorUsd: floor }
  }
  return DEFAULT_GUARD
}

export const guardToStore = (g: GuardMode): unknown =>
  g.kind === 'ask' ? (g.floorUsd > 0 ? { ask: g.floorUsd } : 'ask') : g.kind

export const guardLabel = (g: GuardMode) =>
  g.kind === 'off'
    ? 'off'
    : g.kind === 'warn'
      ? 'warn (shows the price, then sends)'
      : g.floorUsd > 0
        ? `ask from ${fmtUsd(g.floorUsd)} up, warn below`
        : 'ask before every cold send'

/** Parses `/meter guard <args>`; undefined when the words are not a mode. */
export const parseGuard = (args: string): GuardMode | undefined => {
  const m = /^\s*(off|warn|ask)(?:\s+\$?(\d+(?:\.\d+)?))?\s*$/i.exec(args)
  if (!m) return undefined
  const kind = m[1]!.toLowerCase()
  if (kind !== 'ask') return m[2] === undefined ? { kind: kind as 'off' | 'warn' } : undefined
  return { kind: 'ask', floorUsd: m[2] === undefined ? 0 : Number(m[2]) }
}

/** What the guard does with a prompt sent now from `origin`. */
export const judge = (state: CacheState, guard: GuardMode, now: number, origin: string): Verdict => {
  if (guard.kind === 'off') return { action: 'send' }
  const until = expiresAt(state)
  const cost = coldCost(state)
  if (until === undefined || cost === undefined || now < until || cost.tokens < GUARD_MIN_TOKENS) return { action: 'send' }

  const price = cost.usd === undefined ? '' : ` = ~${fmtUsd(cost.usd)}`
  const warm = cost.warm === undefined ? '' : ` (a warm turn: ~${fmtUsd(cost.warm)})`
  const unsure = state.ttlSource === 'assumed' ? ', if its lifetime is the assumed 1h' : ''
  const text =
    `The prompt cache went cold ${fmtClock(now - until)} ago${unsure}. ` +
    `This message re-sends ~${fmtTokens(cost.tokens)} tokens to be cached again${price}${warm}.`

  const asks =
    guard.kind === 'ask' && ASKABLE.has(origin) && (cost.usd === undefined || cost.usd >= guard.floorUsd)
  return { action: asks ? 'ask' : 'warn', text, usd: cost.usd, tokens: cost.tokens }
}
