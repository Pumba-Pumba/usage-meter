/**
 * Themes: how the one status line looks. Each theme turns the same snapshot
 * into text for an animation frame that counts up with every tick (~0.8s).
 * Pure (no `$`), so every theme can be tested frame by frame.
 *
 * The look: futuristic, electric, glass, light, smooth, seamless. Thin lines
 * and glass glyphs, not emoji; fractional fills, not chunky blocks; motion
 * only where something is live (a warm cache), stillness everywhere else.
 */

import { fmtClock, fmtTokens, hitRate, promptTokens, TTL_MS } from './cache'
import type { CacheState } from './cache'
import { fmtSpan, pace, shortName } from './limits'
import type { Limit } from './limits'
import { coldUsd, fmtUsd } from './price'

export type CacheView =
  | { kind: 'none' }
  | { kind: 'cold'; reCache: number; misses: number; usd?: number }
  | { kind: 'warm'; left: number; frac: number; hit: number; misses: number; unsure: boolean }

export type LimitView = { kind: string; pct: number; resetIn?: number; fullIn?: number }

export type Snapshot = { cache: CacheView; limits: LimitView[] }

const WINDOW_ORDER: Record<string, number> = { five_hour: 0, seven_day: 1 }

export const snapshot = (cache: CacheState, limits: readonly Limit[], now: number): Snapshot => {
  let c: CacheView = { kind: 'none' }
  if (cache.last) {
    const ttlMs = TTL_MS[cache.ttl]
    const left = cache.last.at + ttlMs - now
    c =
      left <= 0
        ? {
            kind: 'cold',
            reCache: promptTokens(cache.last),
            misses: cache.misses,
            usd: coldUsd(cache.last.model, promptTokens(cache.last), cache.ttl),
          }
        : { kind: 'warm', left, frac: left / ttlMs, hit: hitRate(cache), misses: cache.misses, unsure: cache.ttlSource === 'assumed' }
  }
  const l = [...limits]
    .sort((a, b) => (WINDOW_ORDER[a.kind] ?? 9) - (WINDOW_ORDER[b.kind] ?? 9))
    .map(x => {
      const reset = x.resetsAt ? Date.parse(x.resetsAt) : NaN
      return {
        kind: x.kind,
        pct: Math.round(x.percentUsed),
        resetIn: Number.isNaN(reset) ? undefined : Math.max(0, reset - now),
        fullIn: pace(x, now)?.hitsFullIn,
      }
    })
  return { cache: c, limits: l }
}

type Theme = {
  /** `dynamic` themes animate while the cache is warm; `static` ones never move. */
  motion: 'static' | 'dynamic'
  /** One line for the picker. */
  blurb: string
  render: (s: Snapshot, frame: number) => string | undefined
}

// ── shared pieces ────────────────────────────────────────────────────────────
/** The cold re-cache's price, ` ~$0.42`, or nothing for a model with no price row. */
const usd = (c: { usd?: number }) => (c.usd === undefined ? '' : ` ~${fmtUsd(c.usd)}`)
const at = <T>(list: readonly T[], i: number) => list[((i % list.length) + list.length) % list.length] as T
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const join = (parts: (string | undefined)[], sep: string) => {
  const kept = parts.filter((p): p is string => Boolean(p))
  return kept.length === 0 ? undefined : kept.join(sep)
}
const q = (c: { unsure: boolean }) => (c.unsure ? '?' : '')
const misses = (n: number) => (n > 0 ? ` ↺${n}` : '')
/** Only what matters: a reset time once use is high, a △ when 100% comes first. */
const tail = (l: LimitView) =>
  (l.resetIn !== undefined && (l.pct >= 75 || l.fullIn !== undefined) ? ` ↻${fmtSpan(l.resetIn)}` : '') +
  (l.fullIn !== undefined ? ` △ full ${fmtSpan(l.fullIn)}` : '')
/** Faster motion as the window closes: every frame near the end, every 2nd otherwise. */
const tempo = (frac: number, frame: number) => (frac < 0.2 ? frame : Math.floor(frame / 2))

/** A seamless line gauge: heavy where filled, light where empty, half-steps at the edge. */
const line = (fraction: number, width: number) => {
  const halves = Math.round(clamp01(fraction) * width * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2 === 1
  return '━'.repeat(full) + (half ? '╸' : '') + '─'.repeat(width - full - (half ? 1 : 0))
}

/** Glass beads with quarter fills: ○ ◔ ◑ ◕ ●. */
const BEAD = ['○', '◔', '◑', '◕', '●']
const beads = (fraction: number, count: number, empty = '○') => {
  const quarters = Math.round(clamp01(fraction) * count * 4)
  let out = ''
  for (let i = 0; i < count; i++) {
    const q4 = Math.min(4, Math.max(0, quarters - i * 4))
    out += q4 === 0 ? empty : BEAD[q4]
  }
  return out
}

/** Sixths-of-a-cell segment gauge: ▰ filled, ▱ empty. */
const segments = (fraction: number, count: number) => {
  const n = Math.round(clamp01(fraction) * count)
  return '▰'.repeat(n) + '▱'.repeat(count - n)
}

// ── aurora: light sweeping along a thin line ────────────────────────────────
// Light, smooth. An orbit turns; a gleam travels the lit part of the line.
const aurora: Theme = {
  motion: 'dynamic',
  blurb: 'light — a gleam sweeps a thin line of light as the cache drains',
  render: (s, f) =>
    join(
      [
        s.cache.kind === 'warm'
          ? (() => {
              const w = 10
              const bar = line(s.cache.frac, w).split('')
              const lit = bar.findIndex(ch => ch !== '━')
              const span = lit === -1 ? w : lit
              if (span > 1) bar[tempo(s.cache.frac, f) % span] = '✦'
              return `${at(['◜', '◝', '◞', '◟'], tempo(s.cache.frac, f))} ${fmtClock(s.cache.left)}${q(s.cache)} ${bar.join('')}${misses(s.cache.misses)}`
            })()
          : s.cache.kind === 'cold'
            ? `◌ dim ${line(0, 10)} ${fmtTokens(s.cache.reCache)} to relight${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${shortName(l.kind)} ${line(l.pct / 100, 8)} ${l.pct}%${tail(l)}`),
      ],
      '  ╱  ',
    ),
}

// ── pulse: an electric waveform ─────────────────────────────────────────────
// Electric, futuristic. A wave runs while warm, flattens near expiry, flatlines cold.
const WAVE = '⎺⎻⎼⎽⎼⎻'
const RIPPLE = '⎼⎽⎼⎼⎼⎼'
const LEVEL = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const pulse: Theme = {
  motion: 'dynamic',
  blurb: 'electric — a live waveform that runs, flattens near expiry, flatlines cold',
  render: (s, f) =>
    join(
      [
        s.cache.kind === 'warm'
          ? (() => {
              const src = s.cache.frac < 0.2 ? RIPPLE : WAVE
              const shift = tempo(s.cache.frac, f) % src.length
              const wave = (src.slice(shift) + src.slice(0, shift)).repeat(2)
              return `${at(['ϟ', 'ϟ', 'ϟ', '⌁'], f)} ${fmtClock(s.cache.left)}${q(s.cache)} ${wave}${misses(s.cache.misses)}`
            })()
          : s.cache.kind === 'cold'
            ? `⌁ offline ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ ${fmtTokens(s.cache.reCache)} to reboot${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${shortName(l.kind)} ${LEVEL[Math.min(7, Math.floor((Math.min(100, l.pct) / 100) * 8))]} ${l.pct}%${tail(l)}`),
      ],
      '  ┊  ',
    ),
}

// ── glass: beads of light that fill and empty in quarters ───────────────────
// Glass, smooth. A diamond breathes; the leading bead shimmers.
const glass: Theme = {
  motion: 'dynamic',
  blurb: 'glass — beads of light that empty in quarter steps, a breathing diamond',
  render: (s, f) =>
    join(
      [
        s.cache.kind === 'warm'
          ? (() => {
              const b = beads(s.cache.frac, 5).split('')
              const i = b.lastIndexOf('●')
              if (i >= 0 && tempo(s.cache.frac, f) % 2 === 1) b[i] = '◉'
              return `${at(['◇', '◈', '◆', '◈'], tempo(s.cache.frac, f))} ${fmtClock(s.cache.left)}${q(s.cache)} ${b.join('')}${misses(s.cache.misses)}`
            })()
          : s.cache.kind === 'cold'
            ? `◇ clear ${beads(0, 5)} ${fmtTokens(s.cache.reCache)} to refill${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${shortName(l.kind)} ${beads(l.pct / 100, 5, '◌')} ${l.pct}%${tail(l)}`),
      ],
      '   ◦   ',
    ),
}

// ── flux: a particle scanning a track ───────────────────────────────────────
// Futuristic, seamless. A spark glides back and forth; it races near expiry.
const FLUX_W = 9
const scan = (pos: number) => {
  const p = pos % (2 * (FLUX_W - 1))
  const x = p < FLUX_W ? p : 2 * (FLUX_W - 1) - p
  let out = ''
  for (let i = 0; i < FLUX_W; i++) {
    const d = Math.abs(i - x)
    out += d === 0 ? '●' : d === 1 ? '•' : '∙'
  }
  return out
}
const flux: Theme = {
  motion: 'dynamic',
  blurb: 'futuristic — a spark glides along a track, racing as the cache runs out',
  render: (s, f) =>
    join(
      [
        s.cache.kind === 'warm'
          ? `⟡ ${fmtClock(s.cache.left)}${q(s.cache)} ${scan(s.cache.frac < 0.2 ? f * 2 : f)}${misses(s.cache.misses)}`
          : s.cache.kind === 'cold'
            ? `⟡ idle ${'∙'.repeat(FLUX_W)} ${fmtTokens(s.cache.reCache)} to recharge${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${shortName(l.kind)} ${segments(l.pct / 100, 6)} ${l.pct}%${tail(l)}`),
      ],
      '  ⟋  ',
    ),
}

// ── classic: every number, no motion ────────────────────────────────────────
const dot = (bad: boolean, warn: boolean) => (bad ? '🔴' : warn ? '🟡' : '🟢')
const classic: Theme = {
  motion: 'static',
  blurb: 'traffic-light dots and every number',
  render: s =>
    join(
      [
        s.cache.kind === 'warm'
          ? `${dot(false, s.cache.frac < 0.2)} cache ${fmtClock(s.cache.left)}${q(s.cache)} · hit ${s.cache.hit}%${misses(s.cache.misses)}`
          : s.cache.kind === 'cold'
            ? `🔴 cache cold · ~${fmtTokens(s.cache.reCache)} to re-cache${usd(s.cache)}`
            : undefined,
        ...s.limits.map(
          l =>
            `${dot(l.pct >= 90, l.pct >= 75)} ${shortName(l.kind)} ${l.pct}%${l.resetIn !== undefined ? ` · ${fmtSpan(l.resetIn)}` : ''}${l.fullIn !== undefined ? ` · full in ${fmtSpan(l.fullIn)}` : ''}`,
        ),
      ],
      '  │  ',
    ),
}

// ── prism: light refracting through a glass bar ─────────────────────────────
// Glass, light. A bright band travels through the lit part; a prism turns.
const prismBar = (fraction: number, width: number, pos: number | null) => {
  const lit = Math.round(clamp01(fraction) * width)
  let out = ''
  for (let i = 0; i < width; i++) {
    if (i >= lit) out += '░'
    else if (pos === null) out += '▓'
    else {
      const d = Math.abs(i - (pos % Math.max(1, lit)))
      out += d === 0 ? '█' : d === 1 ? '▓' : '▒'
    }
  }
  return out
}
const prism: Theme = {
  motion: 'dynamic',
  blurb: 'light refracting — a bright band travels through a glass bar',
  render: (s, f) =>
    join(
      [
        s.cache.kind === 'warm'
          ? `${at(['◐', '◓', '◑', '◒'], tempo(s.cache.frac, f))} ${fmtClock(s.cache.left)}${q(s.cache)} ${prismBar(s.cache.frac, 10, tempo(s.cache.frac, f))}${misses(s.cache.misses)}`
          : s.cache.kind === 'cold'
            ? `◌ ${prismBar(0, 10, null)} ${fmtTokens(s.cache.reCache)} to refract${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${shortName(l.kind)} ${prismBar(l.pct / 100, 6, null)} ${l.pct}%${tail(l)}`),
      ],
      '  ⋮  ',
    ),
}

// ── static designs ──────────────────────────────────────────────────────────

/** bars: small segment gauges, one icon per kind of figure. */
const bars: Theme = {
  motion: 'static',
  blurb: 'mini gauges — read time left and use at a glance',
  render: s =>
    join(
      [
        s.cache.kind === 'warm'
          ? `⏱ ${fmtClock(s.cache.left)}${q(s.cache)} ${segments(s.cache.frac, 5)} ${s.cache.hit}%${misses(s.cache.misses)}`
          : s.cache.kind === 'cold'
            ? `❄ cold · ${fmtTokens(s.cache.reCache)} to re-cache${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${l.kind === 'five_hour' ? '⚡' : '📅'} ${shortName(l.kind)} ${segments(l.pct / 100, 5)} ${l.pct}%${tail(l)}`),
      ],
      '   ',
    ),
}

/** icons: friendly and short. */
const icons: Theme = {
  motion: 'static',
  blurb: 'icons and numbers — short and friendly',
  render: s =>
    join(
      [
        s.cache.kind === 'warm'
          ? `🧠 ${fmtClock(s.cache.left)}${q(s.cache)}${s.cache.frac < 0.2 ? ' ⚠' : ''} · ${s.cache.hit}%${misses(s.cache.misses)}`
          : s.cache.kind === 'cold'
            ? `🧊 cold ${fmtTokens(s.cache.reCache)}${usd(s.cache)}`
            : undefined,
        ...s.limits.map(
          l =>
            `${l.kind === 'five_hour' ? '⏳' : '📅'} ${l.pct}%${l.resetIn !== undefined ? ` ↻${fmtSpan(l.resetIn)}` : ''}${l.fullIn !== undefined ? ` ⚠${fmtSpan(l.fullIn)}` : ''}`,
        ),
      ],
      '   ',
    ),
}

/** minimal: words only; a colored dot appears only where attention is needed. */
const flag = (bad: boolean, warn: boolean) => (bad ? '🔴 ' : warn ? '🟡 ' : '')
const minimal: Theme = {
  motion: 'static',
  blurb: 'words only — color appears only when something needs you',
  render: s =>
    join(
      [
        s.cache.kind === 'warm'
          ? `${flag(false, s.cache.frac < 0.2)}cache ${fmtClock(s.cache.left)}${q(s.cache)}`
          : s.cache.kind === 'cold'
            ? `🔴 cache cold${usd(s.cache)}`
            : undefined,
        ...s.limits.map(
          l =>
            `${flag(l.pct >= 90, l.pct >= 75 || l.fullIn !== undefined)}${shortName(l.kind)} ${l.pct}%${l.fullIn !== undefined ? ` (full in ${fmtSpan(l.fullIn)})` : ''}`,
        ),
      ],
      ' · ',
    ),
}

/** blueprint: aurora's thin lines, held perfectly still. */
const blueprint: Theme = {
  motion: 'static',
  blurb: 'thin line gauges, perfectly still — the calm twin of aurora',
  render: s =>
    join(
      [
        s.cache.kind === 'warm'
          ? `cache ${fmtClock(s.cache.left)}${q(s.cache)} ${line(s.cache.frac, 10)}${misses(s.cache.misses)}`
          : s.cache.kind === 'cold'
            ? `cache cold ${line(0, 10)} ${fmtTokens(s.cache.reCache)}${usd(s.cache)}`
            : undefined,
        ...s.limits.map(l => `${shortName(l.kind)} ${line(l.pct / 100, 8)} ${l.pct}%${tail(l)}`),
      ],
      '  ╱  ',
    ),
}

export const THEMES = { aurora, pulse, glass, flux, prism, classic, bars, icons, minimal, blueprint } as const
export type ThemeName = keyof typeof THEMES
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
export const DYNAMIC = THEME_NAMES.filter(n => THEMES[n].motion === 'dynamic')
export const STATIC = THEME_NAMES.filter(n => THEMES[n].motion === 'static')
export const DEFAULT_THEME: ThemeName = 'aurora'
export const isTheme = (name: unknown): name is ThemeName =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(THEMES, name)
export const blurb = (name: ThemeName) => THEMES[name].blurb

export const render = (theme: ThemeName, s: Snapshot, frame: number) => THEMES[theme].render(s, frame)
/** Motion only while the cache is warm and the theme moves. */
export const animates = (theme: ThemeName, s: Snapshot) =>
  THEMES[theme].motion === 'dynamic' && s.cache.kind === 'warm'

/** A fixed sample the picker and the gallery draw every design with. */
export const SAMPLE: Snapshot = {
  cache: { kind: 'warm', left: 52 * 60_000, frac: 52 / 60, hit: 91, misses: 0, unsure: false },
  limits: [
    { kind: 'five_hour', pct: 12, resetIn: (3 * 60 + 10) * 60_000 },
    { kind: 'seven_day', pct: 2, resetIn: 6 * 24 * 3_600_000 },
  ],
}

export const themeList = (current: ThemeName) => {
  const row = (name: ThemeName) => `${name === current ? '▸' : '  '} ${name}: ${THEMES[name].blurb}`
  return ['Dynamic (animated while the cache is warm):', ...DYNAMIC.map(row), 'Static:', ...STATIC.map(row)].join('\n')
}
