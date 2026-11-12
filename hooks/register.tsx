import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import { cacheDetails, coldCost, expiresAt, fmtClock, fmtTokens, fresh, record, restore, shouldWarn, toSaved, TTL_MS } from './cache'
import type { CacheState, Ttl } from './cache'
import { DEFAULT_GUARD, guardFrom, guardLabel, guardToStore, judge, parseGuard } from './guard'
import type { GuardMode } from './guard'
import { DEFAULT_WINDOW_MS, idle, isRetryable, isWarmPing, MAX_RETRIES, parseWindow, PING_PROMPT, plan, RETRY_MS } from './keepwarm'
import type { Warm } from './keepwarm'
import { crossed, limitDetails, longName } from './limits'
import { fmtUsd, usageUsd } from './price'
import type { Limit } from './limits'
import { animates, blurb, DEFAULT_THEME, DYNAMIC, isTheme, render, SAMPLE, snapshot, STATIC, themeList } from './themes'
import type { ThemeName } from './themes'

/**
 * usage-meter: one status line with the prompt cache and the subscription
 * limits, drawn in one of ten designs (five dynamic, five static).
 *
 * Reads only what Claude Code hands every mod: each reply's token usage and
 * its rate-limit figures. No credentials, no network, no files. It warns; it
 * never compacts or sends anything on its own, except keep-warm pings, and
 * those only while the person has turned keep-warm on (`/meter keepwarm`).
 */

const PANE = 'usage-meter-designs'
const STORE_TTL = 'ttl'
const STORE_TTL_SOURCE = 'ttlSource'
const STORE_THEME = 'theme'
const STORE_WELCOMED = 'welcomed'
const STORE_GUARD = 'guard'
/** A running keep-warm window's end, `keepwarm:<id>`, so a reload or resume keeps it. */
const WARM_PREFIX = 'keepwarm:'
const KEEP_LABEL = "Don't send"
/** Per-session cache state, `session:<id>`, so a resume picks up where it left off. */
const SESSION_PREFIX = 'session:'
/** Sessions remembered; the least recently used beyond this are forgotten. */
const MAX_SESSIONS = 30
/** One animation frame. Text that did not change is not sent again. */
const TICK_MS = 800

/** What the design picker draws from: the chosen design and the frame. */
const chosen = atom({ plugin: 'usage-meter', key: 'chosen' } as const, DEFAULT_THEME as string)
const pickerFrame = atom({ plugin: 'usage-meter', key: 'frame' } as const, 0)

let cache: CacheState = fresh()
let limits: readonly Limit[] = []
let tick: { cancel: () => void } | null = null
let theme: ThemeName = DEFAULT_THEME
let frame = 0
/** The text last sent to the status line; null forces the next draw to send. */
let shown: string | undefined | null = null
let isPickerOpen = false
let guard: GuardMode = DEFAULT_GUARD
let warm: Warm = idle()
let warmTimer: { cancel: () => void } | null = null
/** Bumped by every reschedule, so a timer set before it does nothing. */
let warmGen = 0
let pinging = false
/** Said once per wait, so a restart's first ping does not repeat it. */
let toldNothingToFork = false

/** The whole line for a theme and frame: cache first, then the windows. */
export const statusLine = (c: CacheState, l: readonly Limit[], now: number, name: ThemeName = DEFAULT_THEME, f = 0) =>
  render(name, snapshot(c, l, now), f)

const warmDetails = (now: number) => {
  const spent = warm.pings > 0 ? `; ${warm.pings} ping${warm.pings > 1 ? 's' : ''}, ~${fmtUsd(warm.usd)}` : ''
  if (warm.until > now) {
    const p = plan(cache, warm, now)
    const next = p.kind === 'ping' ? `next ping in ${fmtClock(p.at - now)}` : 'waiting for the next reply'
    return `Keep-warm: on, ${fmtClock(warm.until - now)} left, ${next}${spent} (/meter keepwarm off)`
  }
  if (warm.stopped) return `Keep-warm: stopped, ${warm.stopped}${spent} (/meter keepwarm 3h to restart)`
  return 'Keep-warm: off (/meter keepwarm 3h pings the cache before it goes cold)'
}

const details = (now: number) =>
  [
    ...cacheDetails(cache, now),
    ...limitDetails(limits, now),
    '',
    warmDetails(now),
    `Send-guard: ${guardLabel(guard)} (/meter guard off|warn|ask [$N])`,
    `Design: ${theme} (/meter designs to change it)`,
    'Main conversation only; subagents keep their own caches. No credentials are read.',
  ].join('\n')

async function draw($: EngineInterface) {
  const now = await $.clock.now()
  // While keep-warm covers the expiry, a ping is coming: nothing to warn about.
  const covered = warm.until > (expiresAt(cache) ?? Infinity)
  const last = cache.last
  if (shouldWarn(cache, now) && last && !covered) {
    cache = { ...cache, warnedFor: last.at }
    const left = fmtClock(last.at + TTL_MS[cache.ttl] - now)
    const usd = coldCost(cache)?.usd
    const price = usd === undefined ? '' : ` Re-caching would cost ~${fmtUsd(usd)}.`
    $.ui.toast(`Prompt cache goes cold in ${left}.${price} Send a message, /meter keepwarm, or /compact before stepping away.`)
  }
  const snap = snapshot(cache, limits, now)
  if (animates(theme, snap)) frame += 1
  const text = render(theme, snap, frame)
  if (text !== shown) {
    shown = text
    $.ui.status(text)
  }
  if (isPickerOpen) await update($, pickerFrame, n => n + 1)
}

async function choose($: EngineInterface, name: ThemeName) {
  theme = name
  shown = null
  await $.store.set(STORE_THEME, name)
  await update($, chosen, () => name)
  await draw($)
}

async function openPicker($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'usage-meter · choose a design' })
  isPickerOpen = opened.isPlaced
  return opened.isPlaced
}

// ── keep-warm ────────────────────────────────────────────────────────────────

function cancelWarmTimer() {
  warmTimer?.cancel()
  warmTimer = null
}

/** Sets the one keep-warm timer from the cache and the window as they are now. */
async function schedule($: EngineInterface) {
  cancelWarmTimer()
  const gen = ++warmGen
  const now = await $.clock.now()
  if (gen !== warmGen) return
  const p = plan(cache, warm, now)
  if (p.kind === 'off') return
  if (p.kind === 'end' && p.at <= now) return endWarm($, null)
  // Waiting for a reply still ends the window on time.
  const at = p.kind === 'wait' ? warm.until : p.at
  warmTimer = $.clock.after(Math.max(0, at - now), () => {
    if (gen === warmGen) void (p.kind === 'ping' ? ping($) : schedule($))
  })
}

async function startWarm($: EngineInterface, windowMs: number) {
  const now = await $.clock.now()
  warm = { ...idle(), until: now + windowMs }
  toldNothingToFork = false
  await $.store.set(WARM_PREFIX + (await $.session.id()), warm.until)
  await schedule($)
}

/** Turns keep-warm off: by the person (`null`) or by itself, saying why. */
async function endWarm($: EngineInterface, why: string | null) {
  cancelWarmTimer()
  warmGen += 1
  const wasOn = warm.until > 0
  warm = { ...warm, until: 0, retries: 0, stopped: why }
  await $.store.delete(WARM_PREFIX + (await $.session.id()))
  if (wasOn && why) $.ui.toast(`Keep-warm stopped: ${why}.`)
}

async function ping($: EngineInterface) {
  warmTimer = null
  if (pinging || warm.until === 0) return
  const before = cache.last
  const sentAt = await $.clock.now()
  const due = plan(cache, warm, sentAt)
  if (before === null || due.kind !== 'ping' || due.at > sentAt + 1000) return schedule($)

  pinging = true
  let r: Awaited<ReturnType<EngineInterface['model']['fork']>>
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    pinging = false
    return endWarm($, `the ping failed (${err instanceof Error ? err.message : String(err)})`)
  }
  pinging = false
  // Off, or a reply or /compact moved the cache on while the ping was out:
  // what it was sent for is gone, so plan again from what is there now.
  if (warm.until === 0) return
  if (cache.last !== before) return schedule($)

  if (!r.isAnswered && r.reason === 'nothing-to-fork') {
    // A restarted process has nothing to fork until its first reply.
    if (!toldNothingToFork) $.ui.log('usage-meter: keep-warm waits for your next message before its first ping.')
    toldNothingToFork = true
    return
  }
  const usd = usageUsd(before.model, cache.ttl, r.usage) ?? 0
  if (!r.isAnswered) {
    warm = { ...warm, usd: warm.usd + usd }
    if (r.reason === 'api-error' && isRetryable(r.status) && warm.retries < MAX_RETRIES) {
      const now = await $.clock.now()
      // Only while the retry can still land before the cache goes cold.
      if (now + RETRY_MS < (expiresAt(cache) ?? 0) - 30_000) {
        warm = { ...warm, retries: warm.retries + 1 }
        cancelWarmTimer()
        const gen = ++warmGen
        warmTimer = $.clock.after(RETRY_MS, () => {
          if (gen === warmGen) void ping($)
        })
        return
      }
    }
    const why =
      r.reason === 'api-error'
        ? `the API call failed${r.status === null ? '' : ` (${r.status})`}`
        : r.reason === 'aborted'
          ? 'the ping was interrupted'
          : 'the ping got no reply'
    return endWarm($, why)
  }

  warm = { ...warm, pings: warm.pings + 1, usd: warm.usd + usd, retries: 0 }
  const u = r.usage
  if (!isWarmPing(u)) {
    // A ping that read nothing after more than 5 minutes, on an assumed hour,
    // shows the lifetime is 5 minutes.
    if (cache.ttlSource === 'assumed' && u.cache_read_input_tokens === 0 && sentAt - before.at > TTL_MS['5m']) {
      cache = { ...cache, ttl: '5m', ttlSource: 'learned' }
      await $.store.set(STORE_TTL, '5m')
      await $.store.set(STORE_TTL_SOURCE, 'learned')
    }
    return endWarm(
      $,
      `the cache was already gone (the ping read ${fmtTokens(u.cache_read_input_tokens)} and wrote ${fmtTokens(u.cache_creation_input_tokens)} tokens)`,
    )
  }
  // The read restarted the cache's lifetime from when the ping was sent.
  cache = { ...cache, last: { ...before, at: sentAt }, warnedFor: null }
  shown = null
  await save($)
  await draw($)
  await schedule($)
}

// ── limits ───────────────────────────────────────────────────────────────────

async function alert($: EngineInterface, limit: SessionRateLimit) {
  const level = crossed(limit.percentUsed)
  if (level === undefined || !limit.resetsAt) return
  const key = `alerted:${limit.kind}`
  const prev = (await $.store.get(key)) as { resetsAt: string; level: number } | undefined
  if (prev && prev.resetsAt === limit.resetsAt && prev.level >= level) return
  await $.store.set(key, { resetsAt: limit.resetsAt, level })
  const text =
    level >= 100
      ? `You have reached your ${longName(limit.kind)} limit.`
      : `You have used ${Math.round(limit.percentUsed)}% of your ${longName(limit.kind)} limit.`
  $.ui.toast(text)
  if (level >= 90) await $.ui.notify(text, { title: 'Claude usage' }).catch(() => undefined)
}

/**
 * Saves this session's cache state. Deleting first moves the key to the end of
 * the store's insertion order, so the oldest sessions are the first keys.
 */
async function save($: EngineInterface) {
  const key = SESSION_PREFIX + (await $.session.id())
  await $.store.delete(key)
  await $.store.set(key, toSaved(cache))
  const sessions = (await $.store.keys()).filter(k => k.startsWith(SESSION_PREFIX))
  for (const old of sessions.slice(0, Math.max(0, sessions.length - MAX_SESSIONS))) await $.store.delete(old)
}

async function takeLimits($: EngineInterface, next: readonly SessionRateLimit[]) {
  limits = next.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  for (const l of next) await alert($, l)
  await draw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    cache = fresh()
    shown = null
    const saved = await $.store.get(STORE_THEME)
    theme = isTheme(saved) ? saved : DEFAULT_THEME
    await update($, chosen, () => theme)
    const ttl = await $.store.get(STORE_TTL)
    const source = await $.store.get(STORE_TTL_SOURCE)
    if (ttl === '5m' || ttl === '1h') {
      cache.ttl = ttl
      cache.ttlSource = source === 'manual' ? 'manual' : 'learned'
    }
    // A resumed session: remember when its last reply was, so the line shows
    // a cold cache as cold instead of nothing, then a fresh countdown.
    const id = await $.session.id()
    cache = restore(cache, await $.store.get(SESSION_PREFIX + id))
    guard = guardFrom(await $.store.get(STORE_GUARD))
    // A keep-warm window this session left open (a reload, a resume) goes on;
    // windows other sessions left behind are forgotten once they have ended.
    const now = await $.clock.now()
    cancelWarmTimer()
    warm = idle()
    for (const key of (await $.store.keys()).filter(k => k.startsWith(WARM_PREFIX))) {
      const until = await $.store.get(key)
      const open = typeof until === 'number' && until > now
      if (key === WARM_PREFIX + id && open) warm = { ...warm, until }
      else if (!open) await $.store.delete(key)
    }
    await $.command.register({
      name: 'meter',
      description:
        'Prompt cache and usage limits: details, "keepwarm [3h|off]", "guard off|warn|ask [$N]", "designs", "theme <name>", "ttl 5m|1h|auto"',
      argumentHint: '[keepwarm [3h|90m|off] | guard off|warn|ask [$N] | designs | theme <name> | ttl 5m|1h|auto]',
    })
    await takeLimits($, (await $.session.usage()).rateLimits)
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => void draw($))
    await schedule($)

    // First run: offer the designs once, never again.
    if (e.isInteractive && (await $.store.get(STORE_WELCOMED)) !== true) {
      await $.store.set(STORE_WELCOMED, true)
      $.ui.toast('usage-meter is on. Pick a look with /meter designs: 5 animated, 5 still.')
      await openPicker($)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    // The cache's lifetime restarts when the request is handled, not when a
    // long reply finishes, so the clock is read before the request goes out.
    const sentAt = e.agentId === undefined ? await $.clock.now() : 0
    const response = yield* next(e)
    const usage = response?.usage
    if (e.agentId === undefined && usage) {
      const before = cache
      cache = record(cache, {
        at: sentAt,
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        model: e.model,
      })
      if (cache.ttlSource === 'learned' && (before.ttl !== cache.ttl || before.ttlSource !== 'learned')) {
        await $.store.set(STORE_TTL, cache.ttl)
        await $.store.set(STORE_TTL_SOURCE, 'learned')
      }
      await save($)
      await draw($)
      toldNothingToFork = false
      warm = { ...warm, retries: 0 }
      await schedule($)
    }
    return response
  })

  // The send-guard: a prompt about to go into a cold cache. Only its first
  // character is read, to leave slash commands alone.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin.kind === 'plugin' || e.text.trimStart().startsWith('/')) return next(e)
    const v = judge(cache, guard, await $.clock.now(), e.origin.kind)
    if (v.action === 'send') return next(e)
    if (v.action === 'warn') {
      $.ui.log(`usage-meter: ${v.text} Sending. (/meter guard ask to be asked first)`)
      return next(e)
    }
    const send = v.usd === undefined ? 'Send anyway' : `Send anyway (~${fmtUsd(v.usd)})`
    let answer: string | null
    try {
      answer = await $.ui.ask(`${v.text} Send it anyway?`, { header: 'usage-meter', options: [send, KEEP_LABEL] })
    } catch {
      // Dismissed: nothing is sent, nothing paid.
      answer = null
    }
    if (answer === send) return next(e)
    return {
      drop: 'usage-meter: not sent, nothing paid. Send it again to be asked again, /clear to start fresh, or /meter guard warn to stop asking.',
    }
  }).catch(($, e, next) => next(e)) // a failing guard never holds a prompt back

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await takeLimits($, e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const kw = /^\s*keep-?warm(?:\s+(\S+))?\s*$/i.exec(e.args)
    if (kw) {
      const arg = kw[1]?.toLowerCase()
      const now = await $.clock.now()
      if (arg === 'off') {
        const wasOn = warm.until > 0
        await endWarm($, null)
        const spent = warm.pings ? ` ${warm.pings} ping${warm.pings > 1 ? 's' : ''}, ~${fmtUsd(warm.usd)}.` : ''
        return { text: wasOn ? `Keep-warm off.${spent}` : 'Keep-warm was not on.' }
      }
      if (arg === 'status') return { text: warmDetails(now) }
      const windowMs = arg === undefined ? DEFAULT_WINDOW_MS : parseWindow(arg)
      if (windowMs === undefined) return { text: 'Keep-warm takes a window up to 24h, such as 3h, 90m or 1h30m; or off, or status.' }
      await startWarm($, windowMs)
      const p = plan(cache, warm, now)
      const warmUsd = coldCost(cache)?.warm
      const each = warmUsd === undefined ? '' : ` Each ping costs about a cache read (~${fmtUsd(warmUsd)}) plus a one-word reply.`
      const when =
        p.kind === 'ping'
          ? `The first ping goes out in ${fmtClock(p.at - now)}.`
          : 'The cache has nothing warm to keep right now, so pings start after your next message.'
      return {
        text: `Keep-warm on for ${fmtClock(windowMs)}: before the cache would go cold, a one-word request to Claude reads it again so it stays warm. ${when}${each}`,
      }
    }
    const g = /^\s*guard(?:\s+(.*))?$/i.exec(e.args)
    if (g) {
      if (!g[1]?.trim()) return { text: `Send-guard: ${guardLabel(guard)}. Change it: /meter guard off | warn | ask | ask $2` }
      const chosenGuard = parseGuard(g[1])
      if (!chosenGuard) return { text: 'The send-guard takes off, warn, ask, or ask with a dollar floor such as ask $2.' }
      guard = chosenGuard
      await $.store.set(STORE_GUARD, guardToStore(chosenGuard))
      return { text: `Send-guard: ${guardLabel(chosenGuard)}.` }
    }
    if (/^\s*designs?\s*$/i.test(e.args)) {
      const isShown = await openPicker($)
      return { text: isShown ? 'Design picker opened.' : ['Designs (/meter theme <name>):', themeList(theme)].join('\n') }
    }
    const t = /^\s*theme(?:\s+(\S+))?\s*$/i.exec(e.args)
    if (t) {
      const want = t[1]?.toLowerCase()
      if (want === undefined) return { text: ['Designs (/meter theme <name>):', themeList(theme)].join('\n') }
      if (!isTheme(want)) return { text: [`No design "${want}".`, themeList(theme)].join('\n') }
      await choose($, want)
      return { text: `Design: ${want}. ${blurb(want)}` }
    }
    const m = /^\s*ttl\s+(5m|1h|auto)\s*$/i.exec(e.args)
    if (m) {
      const choice = m[1]!.toLowerCase()
      if (choice === 'auto') {
        cache = { ...cache, ttl: '1h', ttlSource: 'assumed' }
        await $.store.delete(STORE_TTL)
        await $.store.delete(STORE_TTL_SOURCE)
      } else {
        cache = { ...cache, ttl: choice as Ttl, ttlSource: 'manual' }
        await $.store.set(STORE_TTL, choice)
        await $.store.set(STORE_TTL_SOURCE, 'manual')
      }
      await draw($)
    }
    return { text: details(await $.clock.now()) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, chosen)
    const f = await read($, pickerFrame)
    const row = (name: ThemeName) => (
      <Box key={`row-${name}`} flexDirection="column" marginBottom={1}>
        <Box>
          <Button
            key={`use-${name}`}
            label={name === current ? `● ${name}` : `○ ${name}`}
            onPress={() => choose($, name)}
          />
          <Text dimColor> {blurb(name)}</Text>
        </Box>
        <Text>{render(name, SAMPLE, f) ?? ''}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Text dimColor>Pick a design. It applies at once and is remembered. Change it any time: /meter designs</Text>
        <Text> </Text>
        <Text bold>Dynamic: animated while the cache is warm</Text>
        {DYNAMIC.map(row)}
        <Text bold>Static: never moves</Text>
        {STATIC.map(row)}
        <Button key="done" label="Done" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isPickerOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  // A compaction replaces the conversation, so the next request re-caches by
  // design: forget the old prefix instead of counting it as a miss.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    cache = { ...cache, last: null }
    shown = null
    await $.store.delete(SESSION_PREFIX + (await $.session.id()))
    await draw($)
    // Keep-warm waits for the first reply over the new, shorter conversation.
    await schedule($)
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    tick?.cancel()
    tick = null
    // The window stays stored, so a resume of this session picks it up.
    cancelWarmTimer()
    warmGen += 1
    shown = null
    $.ui.status(undefined)
    return next(e)
  })
}
