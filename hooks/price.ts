/**
 * List prices, pure (no `$`), so the dollar figures can be tested on their own.
 *
 * The table and its model matching follow cache-tax by Karan Bansal (MIT,
 * https://github.com/karanb192/cache-tax), restated per base input rate so a
 * cache write is priced at the lifetime it really has: 1.25x base for 5m, 2x
 * for 1h. A read is the model's own rate, which is not a fixed share of base.
 */

import type { Ttl } from './cache'

/** $ per million tokens. */
export type Price = { read: number; base: number; output: number }

/** Prompts over this many tokens pay the long-context row, where a model has one. */
const LONG_PROMPT_TOKENS = 100_000

// List prices, November 2026. A model id takes the first row it matches, so
// the more specific families come first.
const PRICES: ReadonlyArray<[string | RegExp, Price]> = [
  ['fable-5-2', { read: 0.2, base: 8, output: 40 }],
  ['mythos-5-2', { read: 0.2, base: 8, output: 40 }],
  ['fable-5-1', { read: 0.25, base: 10, output: 50 }],
  ['mythos-5-1', { read: 0.25, base: 10, output: 50 }],
  ['fable-5', { read: 1, base: 10, output: 50 }],
  ['mythos-5', { read: 1, base: 10, output: 50 }],
  ['opus-5-5', { read: 0.2, base: 4, output: 20 }],
  ['opus-5', { read: 0.5, base: 5, output: 25 }],
  // Opus 4 and 4.1 in every spelling, never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, { read: 1.5, base: 15, output: 75 }],
  ['opus-4', { read: 0.5, base: 5, output: 25 }],
  ['sonnet-5-5', { read: 0.1, base: 2, output: 10 }],
  ['sonnet-5', { read: 0.2, base: 2, output: 10 }],
  ['sonnet', { read: 0.3, base: 3, output: 15 }],
  ['haiku-5-5', { read: 0.01, base: 0.1, output: 0.5 }],
  ['3-5-haiku', { read: 0.08, base: 0.8, output: 4 }],
  ['haiku-3-5', { read: 0.08, base: 0.8, output: 4 }],
  ['haiku', { read: 0.1, base: 1, output: 5 }],
]

const LONG_PRICES: ReadonlyArray<[string, Price]> = [['haiku-5-5', { read: 0.05, base: 0.5, output: 2.5 }]]

/** The price row for a model id and prompt size; undefined for a model with no row. */
export const priceOf = (model: string | undefined, promptTokens: number): Price | undefined => {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (!m) return undefined
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, p] of LONG_PRICES) if (m.includes(family)) return p
  }
  for (const [family, p] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return p
  }
  return undefined
}

/** The cache-write rate for a lifetime. */
export const writeRate = (p: Price, ttl: Ttl) => p.base * (ttl === '1h' ? 2 : 1.25)

/** What re-sending `tokens` into a cold cache costs: all of it written again. */
export const coldUsd = (model: string | undefined, tokens: number, ttl: Ttl) => {
  const p = priceOf(model, tokens)
  return p ? (tokens * writeRate(p, ttl)) / 1e6 : undefined
}

/** What the same prefix costs while the cache is warm: all of it read. */
export const warmUsd = (model: string | undefined, tokens: number) => {
  const p = priceOf(model, tokens)
  return p ? (tokens * p.read) / 1e6 : undefined
}

/** What one request billed, from its usage. */
export const usageUsd = (
  model: string | undefined,
  ttl: Ttl,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
) => {
  const p = priceOf(model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  if (!p) return undefined
  return (
    (u.cache_read_input_tokens * p.read +
      u.cache_creation_input_tokens * writeRate(p, ttl) +
      u.input_tokens * p.base +
      u.output_tokens * p.output) /
    1e6
  )
}

/** What re-caching cost: the tokens written at the lifetime's rate, plus the uncached input. */
export const recacheUsd = (model: string | undefined, ttl: Ttl, written: number, input: number) => {
  const p = priceOf(model, written + input)
  return p ? (written * writeRate(p, ttl) + input * p.base) / 1e6 : undefined
}

export const fmtUsd = (usd: number) =>
  usd >= 100 ? `$${usd.toFixed(0)}` : usd === 0 || usd >= 0.005 ? `$${usd.toFixed(2)}` : '<$0.01'
