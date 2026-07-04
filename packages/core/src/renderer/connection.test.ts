import { describe, expect, it } from 'vitest'

import { connState } from './connection.js'

describe('connState', () => {
  it('a confirmed-good probe reads connected (green)', () => {
    expect(connState({ connected: true }, { ok: true })).toBe('connected')
  })

  it('a confirmed-bad probe reads disconnected (red), overriding a stored session', () => {
    expect(connState({ connected: true }, { ok: false, error: 'dead' })).toBe('disconnected')
  })

  it('credentials present but no probe this session reads unverified (blue)', () => {
    // Covers BOTH a stored session and the AWS case — a sessionless plugin whose config IS its credential.
    // connState doesn't special-case sessionless: configured ≠ verified, so it reads blue, not green.
    expect(connState({ connected: true })).toBe('unverified')
  })

  it('no credentials reads disconnected', () => {
    expect(connState({ connected: false })).toBe('disconnected')
  })
})
