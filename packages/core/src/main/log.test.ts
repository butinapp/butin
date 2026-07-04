import { beforeEach, expect, test } from 'vitest'

import { clearLogs, createLogger, getRecentLogs, log, setLogLevels } from './log.js'

// Start each test from a clean ring and a permissive gate; gating tests tighten the level themselves.
beforeEach(() => {
  clearLogs()
  setLogLevels('debug', {})
})

test('log.* records level, scope, and a serialized message into the ring', () => {
  log.warn('test-scope', 'hello', { a: 1 })

  const last = getRecentLogs().at(-1)

  expect(last).toMatchObject({ level: 'warn', scope: 'test-scope' })
  expect(last?.message).toContain('hello')
  expect(last?.message).toContain('"a":1')
})

test('log.error serializes an Error to its stack/message', () => {
  log.error('x', new Error('boom'))

  expect(getRecentLogs().at(-1)?.message).toContain('boom')
})

test('a circular object never throws — it falls back to a string', () => {
  const circular: Record<string, unknown> = {}

  circular['self'] = circular

  expect(() => log.info('x', circular)).not.toThrow()
})

test('the global level gates at the source — below-threshold lines are never emitted', () => {
  setLogLevels('info', {})
  log.debug('x', 'hidden')

  expect(getRecentLogs().some((e) => e.message === 'hidden')).toBe(false)

  setLogLevels('debug', {})
  log.debug('x', 'shown')

  expect(getRecentLogs().some((e) => e.message === 'shown')).toBe(true)
})

test('a per-target override lifts one source above the global floor', () => {
  setLogLevels('warn', { noisy: 'debug' })

  log.debug('noisy', 'kept')
  log.debug('quiet', 'dropped')
  log.info('quiet', 'also-dropped')

  const messages = getRecentLogs().map((e) => e.message)

  expect(messages).toContain('kept')
  expect(messages).not.toContain('dropped')
  expect(messages).not.toContain('also-dropped')
})

test('a plugin override gates by plugin id, independent of scope', () => {
  setLogLevels('warn', { groq: 'debug' })

  createLogger({ plugin: 'groq', action: 'usage' }).debug('groq-detail')
  createLogger({ plugin: 'sentry', action: 'usage' }).debug('sentry-detail')

  const messages = getRecentLogs().map((e) => e.message)

  expect(messages).toContain('groq-detail')
  expect(messages).not.toContain('sentry-detail')
})

test('createLogger binds plugin/action and keeps structured data on the entry', () => {
  createLogger({ plugin: 'groq', action: 'billing' }).warn('rate limited', { retryAfter: 30 })

  const last = getRecentLogs().at(-1)

  expect(last).toMatchObject({ level: 'warn', plugin: 'groq', action: 'billing', message: 'rate limited' })
  expect(last?.data).toEqual({ retryAfter: 30 })
})

test('seq is monotonic and clearLogs empties the ring', () => {
  log.info('x', 'one')
  log.info('x', 'two')

  const entries = getRecentLogs()
  const [a, b] = entries.slice(-2)

  expect(b.seq).toBeGreaterThan(a.seq)

  clearLogs()
  expect(getRecentLogs()).toHaveLength(0)
})
