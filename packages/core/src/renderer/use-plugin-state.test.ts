import { describe, expect, it } from 'vitest'

import { fromPersisted, persistedSchema, toPersisted } from './use-plugin-state.js'

describe('plugin-state persistence (failures only)', () => {
  it('toPersisted keeps only dead verdicts — a success (and a bare testing flag) decays out', () => {
    expect(
      toPersisted({ a: { verdict: { ok: true } }, b: { verdict: { ok: false, error: 'boom' } }, c: { testing: true } })
    ).toEqual({ b: { error: 'boom' } })
  })

  it('fromPersisted rehydrates persisted entries as failed verdicts', () => {
    expect(fromPersisted({ b: { error: 'boom' } })).toEqual({ b: { verdict: { ok: false, error: 'boom' } } })
  })

  it('round-trips a failure so a disconnected plugin stays disconnected across reopen', () => {
    const persisted = { x: { error: 'dead' } }

    expect(toPersisted(fromPersisted(persisted))).toEqual(persisted)
  })

  it('rejects a blob that does not match the schema (state is disposable — load resets it)', () => {
    expect(persistedSchema.safeParse({ x: { error: 42 } }).success).toBe(false)
    expect(persistedSchema.safeParse('not an object').success).toBe(false)
  })
})
