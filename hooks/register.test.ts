import { describe, expect, mock, test } from 'claude-code/testing'

import { cacheSegment, fresh, record, shouldWarn } from './cache'
import { crossed, fmtSpan, limitSegments, pace } from './limits'
import { statusLine } from './register'
import { DYNAMIC, render, SAMPLE, snapshot, STATIC, THEMES } from './themes'
import type { ThemeName } from './themes'

const M = 60_000
const H = 60 * M
const T0 = Date.parse('2026-11-07T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const step = (at: number, cacheRead: number, cacheWrite = 1_000, input = 50) => ({ at, input, cacheRead, cacheWrite })

describe('cache', () => {
  test('first reply: full window, TTL marked as assumed', async () => {
    const s = record(fresh(), step(0, 0, 20_000))
    expect(cacheSegment(s, 8 * M)).toBe('🟢 cache 52m? · hit 0%')
  })

  test('a cache read after a 10 minute pause proves a 1h TTL', async () => {
    let s = record(fresh(), step(0, 0, 20_000))
    s = record(s, step(10 * M, 20_000))
    expect([s.ttl, s.ttlSource, s.misses]).toEqual(['1h', 'learned', 0])
    expect(cacheSegment(s, 10 * M)).toContain('cache 1h 0m · hit')
  })

  test('nothing read after a 10 minute pause proves 5m, not counted as a miss', async () => {
    let s = record(fresh(), step(0, 0, 20_000))
    s = record(s, step(10 * M, 0, 21_000))
    expect([s.ttl, s.ttlSource, s.misses]).toEqual(['5m', 'learned', 0])
  })

  test('a re-cache inside the window counts as a miss', async () => {
    let s = record(fresh(), step(0, 0, 20_000))
    s = record(s, step(1 * M, 500, 20_500))
    expect(s.misses).toBe(1)
    expect(cacheSegment(s, 1 * M)).toContain('· 1 miss')
  })

  test('a manual TTL is never overridden', async () => {
    let s = { ...record(fresh(), step(0, 0, 20_000)), ttl: '1h' as const, ttlSource: 'manual' as const }
    s = record(s, step(10 * M, 0, 21_000))
    expect(s.ttl).toBe('1h')
  })

  test('warns once in the last 10%, then goes cold', async () => {
    let s = record(fresh(), step(0, 0, 20_000))
    expect(shouldWarn(s, 50 * M)).toBe(false)
    expect(shouldWarn(s, 56 * M)).toBe(true)
    s = { ...s, warnedFor: 0 }
    expect(shouldWarn(s, 57 * M)).toBe(false)
    expect(cacheSegment(s, 58 * M)).toContain('🟡 cache 2m?')
    expect(cacheSegment(s, 61 * M)).toBe('🔴 cache cold · ~20k to re-cache')
  })
})

describe('limits', () => {
  test('compact spans', async () => {
    expect(fmtSpan(45 * M)).toBe('45m')
    expect(fmtSpan(3 * H + 10 * M)).toBe('3h 10m')
    expect(fmtSpan(6 * 24 * H + 22 * H)).toBe('6d')
  })

  test('half used at half time projects 100% without a warning', async () => {
    const p = pace({ kind: 'five_hour', percentUsed: 50, resetsAt: iso(T0 + 2.5 * H) }, T0)
    expect(p?.projected).toBe(100)
    expect(p?.hitsFullIn).toBeUndefined()
  })

  test('burning fast warns when 100% comes before the reset', async () => {
    const limits = [{ kind: 'five_hour', percentUsed: 40, resetsAt: iso(T0 + 4 * H) }]
    expect(limitSegments(limits, T0)).toEqual(['🟢 5h 40% · 4h 0m · ⚠ full in 1h 30m'])
  })

  test('thresholds', async () => {
    expect(crossed(74.9)).toBeUndefined()
    expect(crossed(75)).toBe(75)
    expect(crossed(93)).toBe(90)
    expect(crossed(100)).toBe(100)
  })
})

test('one line: cache first, then 5h, then week', async () => {
  const c = record(fresh(), { ...step(T0, 9_000, 1_000, 0) })
  const line = statusLine(
    c,
    [
      { kind: 'seven_day', percentUsed: 2, resetsAt: iso(T0 + 6 * 24 * H + 22 * H) },
      { kind: 'five_hour', percentUsed: 12, resetsAt: iso(T0 + 3 * H + 10 * M) },
    ],
    T0 + 8 * M,
    'classic',
  )
  expect(line).toBe('🟢 cache 52m? · hit 90%  │  🟢 5h 12% · 3h 2m  │  🟢 wk 2% · 6d')
  expect(statusLine(fresh(), [], T0, 'classic')).toBeUndefined()
})

test('the engine path: limits at start, cache after a reply, alerts once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { theme: 'classic', welcomed: true })
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }))
  const reading = (percentUsed: number) => [{ kind: 'five_hour', percentUsed, resetsAt: iso(T0 + 2.5 * H) }]
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: reading(50) } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'test', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000 },
    } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(statuses.at(-1)).toBe('🟢 5h 50% · 2h 30m')

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1 })
  for await (const _ of stream) {
    // drain: the result settles once the stream is read to its end
  }
  await stream.result
  expect(statuses.at(-1)).toBe('🟢 cache 1h 0m? · hit 0%  │  🟢 5h 50% · 2h 30m')

  const measure = (p: number) =>
    $.session.measure({ context: { window: 200_000 }, rateLimits: reading(p), changed: ['rateLimits'] })
  await measure(76)
  await measure(80)
  expect(toasts).toEqual(['You have used 76% of your 5-hour limit.'])

  await clock.advance(56 * M)
  expect(toasts.at(-1)).toContain('Prompt cache goes cold in')
})

describe('themes', () => {
  const limits = [
    { kind: 'five_hour', percentUsed: 12, resetsAt: iso(T0 + 3 * H + 10 * M) },
    { kind: 'seven_day', percentUsed: 2, resetsAt: iso(T0 + 6 * 24 * H) },
  ]
  const warmAt = (leftMin: number) => {
    const c = record(fresh(), step(T0, 9_000, 1_000, 0))
    return snapshot({ ...c, ttlSource: 'learned' }, limits, T0 + (60 - leftMin) * M)
  }
  const names = Object.keys(THEMES) as ThemeName[]

  test('every theme draws warm, closing, cold and empty states', async () => {
    const cold = snapshot(record(fresh(), step(T0, 9_000, 1_000, 0)), limits, T0 + 2 * H)
    for (const name of names) {
      for (const snap of [warmAt(52), warmAt(4), cold]) {
        const text = render(name, snap, 3)
        expect(typeof text).toBe('string')
        expect(text).toContain('12%')
      }
      expect(render(name, snapshot(fresh(), [], T0), 0)).toBeUndefined()
    }
  })

  test('animated themes move while warm and hold still when cold', async () => {
    const cold = snapshot(record(fresh(), step(T0, 9_000, 1_000, 0)), limits, T0 + 2 * H)
    for (const name of DYNAMIC) {
      const frames = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(f => render(name, warmAt(52), f)))
      expect(frames.size).toBeGreaterThan(1)
      const still = new Set([0, 1, 2, 3].map(f => render(name, cold, f)))
      expect(still.size).toBe(1)
    }
  })

  test('the looks, frame 0 (a sample for the eye)', async () => {
    expect(render('aurora', warmAt(52), 0)).toBe('◜ 52m ✦━━━━━━━╸─  ╱  5h ━─────── 12%  ╱  wk ──────── 2%')
    expect(render('pulse', warmAt(52), 0)).toBe('ϟ 52m ⎺⎻⎼⎽⎼⎻⎺⎻⎼⎽⎼⎻  ┊  5h ▁ 12%  ┊  wk ▁ 2%')
    expect(render('glass', warmAt(52), 0)).toBe('◇ 52m ●●●●◔  ◦  5h ◑◌◌◌◌ 12%  ◦  wk ◌◌◌◌◌ 2%'.replace(/  ◦  /g, '   ◦   '))
    expect(render('flux', warmAt(52), 0)).toBe('⟡ 52m ●•∙∙∙∙∙∙∙  ⟋  5h ▰▱▱▱▱▱ 12%  ⟋  wk ▱▱▱▱▱▱ 2%')
  })
})

test('five dynamic and five static designs', async () => {
  expect(DYNAMIC).toEqual(['aurora', 'pulse', 'glass', 'flux', 'prism'])
  expect(STATIC).toEqual(['classic', 'bars', 'icons', 'minimal', 'blueprint'])
  for (const name of STATIC) {
    const frames = new Set([0, 1, 2, 3, 4, 5].map(f => render(name, SAMPLE, f)))
    expect(frames.size).toBe(1)
  }
})

test('first run offers the designs once, and a press picks one', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  const toasts: string[] = []
  const opened: string[] = []
  const statuses: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['usage-meter-designs'])
  expect(toasts[0]).toContain('/meter designs')

  const ui = await $.ui.mount({
    plugin: 'usage-meter',
    component: 'Pane',
    requestId: 'usage-meter-designs',
    surface: 'desktop',
    props: {
      title: 'usage-meter',
      isFocused: true,
      bodyColumns: 100,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  } as never)
  expect((await ui.find({ key: 'use-aurora' }))?.text).toBe('● aurora')
  await ui.press({ key: 'use-pulse' })
  expect((await ui.find({ key: 'use-pulse' }))?.text).toBe('● pulse')
  await ui.unmount()

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(1)
})
