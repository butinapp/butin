import { describe, expect, it } from 'vitest'

import { extractNextAction } from './nextjs.js'

describe('extractNextAction', () => {
  it('reads the Next-Action header case-insensitively', () => {
    expect(extractNextAction({ 'Next-Action': '7f1a2b3c' })).toBe('7f1a2b3c')
    expect(extractNextAction({ 'next-action': 'abc123' })).toBe('abc123')
  })

  it('returns undefined when absent or blank', () => {
    expect(extractNextAction({ 'content-type': 'application/json' })).toBeUndefined()
    expect(extractNextAction({ 'next-action': '   ' })).toBeUndefined()
    expect(extractNextAction(undefined)).toBeUndefined()
  })
})
