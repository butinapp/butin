import { describe, expect, it } from 'vitest'

import { evaluateAppLock } from './app-lock.js'

const alive = () => true
const dead = () => false

describe('evaluateAppLock', () => {
  it('reads missing or blank contents as not running', () => {
    expect(evaluateAppLock(undefined, alive)).toEqual({ running: false })
    expect(evaluateAppLock('', alive)).toEqual({ running: false })
  })

  it('reads malformed JSON as not running', () => {
    expect(evaluateAppLock('{ not json', alive)).toEqual({ running: false })
  })

  it('reads a missing or non-numeric pid as not running', () => {
    expect(evaluateAppLock(JSON.stringify({ activeProfileId: 'personal' }), alive)).toEqual({ running: false })
    expect(evaluateAppLock(JSON.stringify({ pid: 'nope' }), alive)).toEqual({ running: false })
  })

  it('reads a dead pid as not running (stale lock self-heals)', () => {
    expect(evaluateAppLock(JSON.stringify({ pid: 4321, activeProfileId: 'personal' }), dead)).toEqual({
      running: false
    })
  })

  it('reads a live pid as running, carrying the active profile', () => {
    expect(evaluateAppLock(JSON.stringify({ pid: 4321, activeProfileId: 'work' }), alive)).toEqual({
      running: true,
      activeProfileId: 'work'
    })
  })

  it('reads a live pid with no profile as running without one', () => {
    expect(evaluateAppLock(JSON.stringify({ pid: 4321 }), alive)).toEqual({ running: true, activeProfileId: undefined })
  })
})
