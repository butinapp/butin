import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { __resetRequestPacing, configureRequestPacing, paceRequest } from './request-pacer.js'

beforeEach(() => {
  vi.useFakeTimers()
  __resetRequestPacing()
})

afterEach(() => {
  vi.useRealTimers()
})

test('disabled: requests run immediately, no gap', async () => {
  configureRequestPacing(false)

  const order: number[] = []
  const a = paceRequest('host', async () => void order.push(1))
  const b = paceRequest('host', async () => void order.push(2))

  await vi.runAllTimersAsync()
  await Promise.all([a, b])

  expect(order).toEqual([1, 2])
})

test('enabled: same-host requests are serialized in order, each gated behind a gap', async () => {
  configureRequestPacing(true)

  const started: string[] = []
  const fn = (id: string) => async () => void started.push(id)

  const all = Promise.all([paceRequest('host', fn('a')), paceRequest('host', fn('b')), paceRequest('host', fn('c'))])

  // Nothing fires synchronously — the first dispatch waits its gap (≥100ms) too.
  expect(started).toEqual([])

  await vi.runAllTimersAsync()
  await all

  // Released in submission order.
  expect(started).toEqual(['a', 'b', 'c'])
})

test('enabled: nothing dispatches before the minimum gap (100ms) elapses', async () => {
  configureRequestPacing(true)

  const started: string[] = []

  void paceRequest('host', async () => void started.push('a'))
  void paceRequest('host', async () => void started.push('b'))

  // 100ms is the floor of the jittered gap, so no dispatch can have happened yet — the random upper bound
  // makes the exact second-dispatch time non-deterministic, but the floor is guaranteed.
  await vi.advanceTimersByTimeAsync(99)
  expect(started).toEqual([])

  await vi.runAllTimersAsync()
  expect(started).toEqual(['a', 'b'])
})

test('onWait reports the incurred delay when paced, and is skipped when disabled', async () => {
  configureRequestPacing(true)
  const waited: number[] = []

  const a = paceRequest(
    'host',
    async () => 'a',
    (ms) => waited.push(ms)
  )

  await vi.runAllTimersAsync()
  await a

  expect(waited).toHaveLength(1)
  expect(waited[0]).toBeGreaterThanOrEqual(100)

  configureRequestPacing(false)
  const skipped: number[] = []
  const b = paceRequest(
    'host',
    async () => 'b',
    (ms) => skipped.push(ms)
  )

  await vi.runAllTimersAsync()
  await b

  expect(skipped).toEqual([])
})

test('enabled: different hosts pace independently (not serialized against each other)', async () => {
  configureRequestPacing(true)

  const started: string[] = []
  const all = Promise.all([
    paceRequest('host-a', async () => void started.push('a')),
    paceRequest('host-b', async () => void started.push('b'))
  ])

  await vi.runAllTimersAsync()
  await all

  expect(started.sort()).toEqual(['a', 'b'])
})
