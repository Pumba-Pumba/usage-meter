import { describe, expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, PromptSubmitInput } from 'claude-code'

import { coldCost, fresh, record } from './cache'
import { GUARD_MIN_TOKENS, judge, parseGuard } from './guard'
import { idle, isWarmPing, parseWindow, plan } from './keepwarm'
import { coldUsd, fmtUsd, priceOf, warmUsd } from './price'

const M = 60_000
const H = 60 * M
const T0 = Date.parse('2026-11-12T12:00:00Z')
const SONNET = 'claude-sonnet-5-5'
/** A 200k prefix on Sonnet 5.5: $0.80 to write at 1h, $0.50 at 5m, $0.02 to read. */
const step = (at: number, cacheRead: number, cacheWrite = 1_000, input = 0, model = SONNET) => ({
  at,
  input,
  cacheRead,
  cacheWrite,
  model,
})
/** Rounded to the cent, for comparing prices. */
const cents = (usd: number | undefined) => (usd === undefined ? undefined : Math.round(usd * 100) / 100)
const learned1h = () => ({ ...fresh(), ttlSource: 'learned' as const })

describe('prices', () => {
  test('models take their own rows, specific families first', async () => {
    expect(priceOf('claude-opus-4-1-20250805', 1)?.read).toBe(1.5)
    expect(priceOf('claude-opus-4-5', 1)?.read).toBe(0.5)
    expect(priceOf('claude-opus-5-5', 1)?.base).toBe(4)
    expect(priceOf('claude-haiku-5-5', 150_000)?.base).toBe(0.5)
    expect(priceOf('claude-haiku-5-5', 50_000)?.base).toBe(0.1)
    expect(priceOf('test', 1)).toBeUndefined()
    expect(priceOf(undefined, 1)).toBeUndefined()
  })

  test('a cold write is priced at the lifetime it really has', async () => {
    expect(cents(coldUsd(SONNET, 200_000, '1h'))).toBe(0.8)
    expect(cents(coldUsd(SONNET, 200_000, '5m'))).toBe(0.5)
    expect(cents(warmUsd(SONNET, 200_000))).toBe(0.02)
    expect([fmtUsd(0.8), fmtUsd(0.004), fmtUsd(0), fmtUsd(123.4)]).toEqual(['$0.80', '<$0.01', '$0.00', '$123'])
  })

  test('unexpected re-caches add up in dollars', async () => {
    let s = record(learned1h(), step(0, 0, 200_000))
    s = record(s, step(1 * M, 0, 200_000))
    expect(s.misses).toBe(1)
    expect(cents(s.missUsd)).toBe(0.8)
  })
})

describe('send-guard', () => {
  const cold = () => record(learned1h(), step(T0, 0, 200_000))
  const warn = { kind: 'warn' } as const
  const ask = { kind: 'ask', floorUsd: 0 } as const

  test('parses its words', async () => {
    expect(parseGuard('off')).toEqual({ kind: 'off' })
    expect(parseGuard(' ask $2.5 ')).toEqual({ kind: 'ask', floorUsd: 2.5 })
    expect(parseGuard('ask')).toEqual({ kind: 'ask', floorUsd: 0 })
    expect(parseGuard('warn 3')).toBeUndefined()
    expect(parseGuard('maybe')).toBeUndefined()
  })

  test('a warm cache, a small prefix or an off guard sends without a word', async () => {
    expect(judge(cold(), ask, T0 + 30 * M, 'composer').action).toBe('send')
    expect(judge(record(learned1h(), step(T0, 0, GUARD_MIN_TOKENS - 1)), ask, T0 + 2 * H, 'composer').action).toBe('send')
    expect(judge(cold(), { kind: 'off' }, T0 + 2 * H, 'composer').action).toBe('send')
    expect(judge(fresh(), ask, T0, 'composer').action).toBe('send')
  })

  test('cold: warn shows the price, ask asks', async () => {
    const w = judge(cold(), warn, T0 + 2 * H, 'composer')
    expect(w.action).toBe('warn')
    if (w.action !== 'send') expect(w.text).toBe('The prompt cache went cold 1h 0m ago. This message re-sends ~200k tokens to be cached again = ~$0.80 (a warm turn: ~$0.02).')
    expect(judge(cold(), ask, T0 + 2 * H, 'composer').action).toBe('ask')
  })

  test('never holds a prompt nobody can send again, or one under the floor', async () => {
    expect(judge(cold(), ask, T0 + 2 * H, 'task-notification').action).toBe('warn')
    expect(judge(cold(), ask, T0 + 2 * H, 'sdk').action).toBe('warn')
    expect(judge(cold(), { kind: 'ask', floorUsd: 5 }, T0 + 2 * H, 'composer').action).toBe('warn')
  })
})

describe('keep-warm plan', () => {
  test('windows', async () => {
    expect([parseWindow('3h'), parseWindow('90m'), parseWindow('1h30m')]).toEqual([3 * H, 90 * M, 90 * M])
    expect([parseWindow(''), parseWindow('25h'), parseWindow('0m'), parseWindow('soon')]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test('pings 10 minutes before a 1h cache goes cold, a minute before a 5m one', async () => {
    const on = { ...idle(), until: T0 + 3 * H }
    const c = record(learned1h(), step(T0, 0, 200_000))
    expect(plan(c, on, T0)).toEqual({ kind: 'ping', at: T0 + 50 * M })
    expect(plan({ ...c, ttl: '5m' }, on, T0)).toEqual({ kind: 'ping', at: T0 + 4 * M })
  })

  test('off, waiting, and the end of the window', async () => {
    const c = record(learned1h(), step(T0, 0, 200_000))
    expect(plan(c, idle(), T0).kind).toBe('off')
    expect(plan(fresh(), { ...idle(), until: T0 + H }, T0).kind).toBe('wait')
    expect(plan(c, { ...idle(), until: T0 + 3 * H }, T0 + 2 * H).kind).toBe('wait') // already cold
    expect(plan(c, { ...idle(), until: T0 + 30 * M }, T0)).toEqual({ kind: 'end', at: T0 + 30 * M })
  })

  test('a warm ping reads and barely writes', async () => {
    expect(isWarmPing({ cache_read_input_tokens: 200_000, cache_creation_input_tokens: 30 })).toBe(true)
    expect(isWarmPing({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200_000 })).toBe(false)
    expect(isWarmPing({ cache_read_input_tokens: 10_000, cache_creation_input_tokens: 190_000 })).toBe(false)
  })

  test('cold cost carries the model the reply came from', async () => {
    const c = record(learned1h(), step(T0, 0, 200_000))
    expect(cents(coldCost(c)?.usd)).toBe(0.8)
    expect(coldCost(fresh())).toBeUndefined()
  })
})

// ── through the engine ───────────────────────────────────────────────────────

const run = (args: string): CommandRunInput => ({
  command: 'meter',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})
const prompt = (text: string, kind: 'composer' | 'task-notification' = 'composer'): PromptSubmitInput => ({
  text,
  wait: false,
  origin: { kind },
})

type ForkAnswer = ModelForkResult | { read: number; write: number }

const world = (on: On, opts: { stepTakes?: number; forks?: ForkAnswer[]; answer?: string | null } = {}) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { theme: 'classic', welcomed: true, ttl: '1h', ttlSource: 'learned' })
  const w = {
    clock,
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    logs: [] as string[],
    entered: [] as string[],
    asked: [] as string[],
    forks: 0,
  }
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.status', (_, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', (_, e) => (w.logs.push(e.text), { value: undefined }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('prompt.submit', (_, e) => (w.entered.push(e.text), { text: e.text }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    w.asked.push(q.question)
    if (opts.answer === null || opts.answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: opts.answer } } }
  })
  on('model.fork', async () => {
    w.forks += 1
    const a = opts.forks?.shift() ?? { read: 200_000, write: 20 }
    if ('isAnswered' in a) return { value: a }
    return {
      value: {
        isAnswered: true,
        text: 'warm',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write },
      } as ModelForkResult,
    }
  })
  // The first reply writes a 200k prefix; later ones read it back, as a warm cache does.
  let replies = 0
  on('turn.step', async function* (_, e) {
    if (opts.stepTakes) await clock.advance(opts.stepTakes)
    const first = replies++ === 0
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: SONNET,
        input_tokens: 0,
        output_tokens: 5,
        cache_read_input_tokens: first ? 0 : 200_000,
        cache_creation_input_tokens: first ? 200_000 : 500,
      },
    } as never
  })
  return w
}

/** Advances in steps of 1h: the status line ticks every 0.8s, and one advance resolves at most 10000 waits. */
const advance = async (clock: { advance: (ms: number) => Promise<unknown> }, ms: number) => {
  for (let left = ms; left > 0; left -= H) await clock.advance(Math.min(H, left))
}

const send = async ($: { turn: { step: (i: never) => AsyncIterable<unknown> & { result: Promise<unknown> } } }) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: SONNET, messageCount: 1 } as never)
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('the countdown starts when the request is sent, not when a long reply ends', async ($, on) => {
  const w = world(on, { stepTakes: 3 * M })
  await $.session.start(start)
  await send($ as never)
  expect(w.statuses.at(-1)).toBe('🟢 cache 57m · hit 0%')
})

test('the cold line carries the price', async ($, on) => {
  const w = world(on)
  await $.session.start(start)
  await send($ as never)
  await advance(w.clock, 2 * H)
  expect(w.statuses.at(-1)).toBe('🔴 cache cold · ~200k to re-cache ~$0.80')
})

describe('send-guard through the engine', () => {
  test('by default a cold send shows its price and goes through', async ($, on) => {
    const w = world(on)
    await $.session.start(start)
    await send($ as never)
    await advance(w.clock, 2 * H)
    const r = await $.prompt.submit(prompt('hello again'))
    expect(r).toEqual({ text: 'hello again' })
    expect(w.logs.at(-1)).toContain('~$0.80')
    expect(w.asked).toEqual([])
  })

  test("ask: Don't send drops the prompt, Send anyway lets it through", async ($, on) => {
    const opts: { answer: string | null } = { answer: "Don't send" }
    const w = world(on, opts)
    await $.session.start(start)
    await $.command.run(run('guard ask'))
    await send($ as never)
    await advance(w.clock, 2 * H)

    const dropped = await $.prompt.submit(prompt('hello again'))
    expect('drop' in dropped && dropped.drop).toContain('not sent')
    expect(w.entered).toEqual([])
    expect(w.asked[0]).toContain('Send it anyway?')

    opts.answer = 'Send anyway (~$0.80)'
    expect(await $.prompt.submit(prompt('hello again'))).toEqual({ text: 'hello again' })

    // Dismissing the dialog sends nothing.
    opts.answer = null
    expect('drop' in (await $.prompt.submit(prompt('hello again')))).toBe(true)
    // A notification is never held, and a slash command is never read.
    expect(await $.prompt.submit(prompt('done', 'task-notification'))).toEqual({ text: 'done' })
    expect(await $.prompt.submit(prompt('/meter'))).toEqual({ text: '/meter' })
  })
})

describe('keep-warm through the engine', () => {
  test('off until asked: no ping ever goes out on its own', async ($, on) => {
    const w = world(on)
    await $.session.start(start)
    await send($ as never)
    await advance(w.clock, 3 * H)
    expect(w.forks).toBe(0)
  })

  test('pings 10 minutes before expiry, keeps the cache warm, ends with the window', async ($, on) => {
    const w = world(on)
    await $.session.start(start)
    await send($ as never)
    const r = await $.command.run(run('keepwarm 3h'))
    expect(r.text).toContain('The first ping goes out in 50m.')

    await advance(w.clock, 50 * M)
    expect(w.forks).toBe(1)
    expect(w.statuses.at(-1)).toBe('🟢 cache 1h 0m · hit 0%')

    // 50m, 100m, 150m; the next would be at 200m, after the window.
    await advance(w.clock, 3 * H)
    expect(w.forks).toBe(3)
    const after = await $.command.run(run('keepwarm status'))
    expect(after.text).toContain('Keep-warm: off')
  })

  test('a reply moves the next ping along', async ($, on) => {
    const w = world(on)
    await $.session.start(start)
    await send($ as never)
    await $.command.run(run('keepwarm 3h'))
    await advance(w.clock, 40 * M)
    await send($ as never)
    await advance(w.clock, 40 * M)
    expect(w.forks).toBe(0)
    await advance(w.clock, 10 * M)
    expect(w.forks).toBe(1)
  })

  test('a ping that finds the cache gone stops, and says why', async ($, on) => {
    const w = world(on, { forks: [{ read: 0, write: 200_000 }] })
    await $.session.start(start)
    await send($ as never)
    await $.command.run(run('keepwarm 3h'))
    await advance(w.clock, 50 * M)
    expect(w.forks).toBe(1)
    expect(w.toasts.at(-1)).toContain('Keep-warm stopped: the cache was already gone')
    await advance(w.clock, 2 * H)
    expect(w.forks).toBe(1)
  })

  test('a busy API is retried a minute later', async ($, on) => {
    const busy: ModelForkResult = {
      isAnswered: false,
      reason: 'api-error',
      status: 429,
      error: 'rate_limit',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const w = world(on, { forks: [busy] })
    await $.session.start(start)
    await send($ as never)
    await $.command.run(run('keepwarm 3h'))
    await advance(w.clock, 50 * M)
    expect(w.forks).toBe(1)
    await advance(w.clock, 1 * M)
    expect(w.forks).toBe(2)
    expect(w.statuses.at(-1)).toBe('🟢 cache 1h 0m · hit 0%')
  })

  test('/meter keepwarm off stops it', async ($, on) => {
    const w = world(on)
    await $.session.start(start)
    await send($ as never)
    await $.command.run(run('keepwarm 3h'))
    const r = await $.command.run(run('keepwarm off'))
    expect(r.text).toBe('Keep-warm off.')
    await advance(w.clock, 2 * H)
    expect(w.forks).toBe(0)
  })
})
