import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import { cacheDetails, fmtClock, fresh, record, restore, shouldWarn, toSaved, TTL_MS } from './cache'
import type { CacheState, Ttl } from './cache'
import { crossed, limitDetails, longName } from './limits'
import type { Limit } from './limits'
import { animates, blurb, DEFAULT_THEME, DYNAMIC, isTheme, render, SAMPLE, snapshot, STATIC, themeList } from './themes'
import type { ThemeName } from './themes'

/**
 * usage-meter: one status line with the prompt cache and the subscription
 * limits, drawn in one of ten designs (five dynamic, five static).
 *
 * Reads only what Claude Code hands every mod: each reply's token usage and
 * its rate-limit figures. No credentials, no network, no files. It warns; it
 * never compacts or sends anything on its own.
 */

const PANE = 'usage-meter-designs'
const STORE_TTL = 'ttl'
const STORE_TTL_SOURCE = 'ttlSource'
const STORE_THEME = 'theme'
const STORE_WELCOMED = 'welcomed'
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

/** The whole line for a theme and frame: cache first, then the windows. */
export const statusLine = (c: CacheState, l: readonly Limit[], now: number, name: ThemeName = DEFAULT_THEME, f = 0) =>
  render(name, snapshot(c, l, now), f)

const details = (now: number) =>
  [
    ...cacheDetails(cache, now),
    ...limitDetails(limits, now),
    '',
    `Design: ${theme} (/meter designs to change it)`,
    'Main conversation only; subagents keep their own caches. No credentials are read.',
  ].join('\n')

async function draw($: EngineInterface) {
  const now = await $.clock.now()
  if (shouldWarn(cache, now) && cache.last) {
    cache = { ...cache, warnedFor: cache.last.at }
    const left = fmtClock(cache.last.at + TTL_MS[cache.ttl] - now)
    $.ui.toast(`Prompt cache goes cold in ${left}. Send a message to keep it warm, or /compact before stepping away.`)
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
    cache = restore(cache, await $.store.get(SESSION_PREFIX + (await $.session.id())))
    await $.command.register({
      name: 'meter',
      description: 'Prompt cache and usage limits: details, "designs" to pick a look, "theme <name>", "ttl 5m|1h|auto"',
      argumentHint: '[designs | theme <name> | ttl 5m|1h|auto]',
    })
    await takeLimits($, (await $.session.usage()).rateLimits)
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => void draw($))

    // First run: offer the designs once, never again.
    if (e.isInteractive && (await $.store.get(STORE_WELCOMED)) !== true) {
      await $.store.set(STORE_WELCOMED, true)
      $.ui.toast('usage-meter is on. Pick a look with /meter designs: 5 animated, 5 still.')
      await openPicker($)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response?.usage
    if (e.agentId === undefined && usage) {
      const before = cache
      cache = record(cache, {
        at: await $.clock.now(),
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      })
      if (cache.ttlSource === 'learned' && (before.ttl !== cache.ttl || before.ttlSource !== 'learned')) {
        await $.store.set(STORE_TTL, cache.ttl)
        await $.store.set(STORE_TTL_SOURCE, 'learned')
      }
      await save($)
      await draw($)
    }
    return response
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await takeLimits($, e.rateLimits)
    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
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
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    tick?.cancel()
    tick = null
    shown = null
    $.ui.status(undefined)
    return next(e)
  })
}
