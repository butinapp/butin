import { describe, expect, it } from 'vitest'

import { activeFromPath, firstTabFor, headerAction } from './route-helpers.js'

describe('firstTabFor', () => {
  it('returns the first capability id', () => {
    expect(firstTabFor({ capabilities: [{ id: 'billing' }, { id: 'usage' }] })).toBe('billing')
  })

  it('returns empty string when there are no capabilities or no plugin', () => {
    expect(firstTabFor({ capabilities: [] })).toBe('')
    expect(firstTabFor(undefined)).toBe('')
  })
})

describe('activeFromPath', () => {
  it('maps overview', () => {
    expect(activeFromPath('/')).toEqual({ kind: 'overview' })
    expect(activeFromPath('/garbage')).toEqual({ kind: 'overview' })
  })

  it('maps management', () => {
    expect(activeFromPath('/management')).toEqual({ kind: 'management' })
  })

  it('maps developer', () => {
    expect(activeFromPath('/developer')).toEqual({ kind: 'developer' })
  })

  it('maps a service path (with or without tab)', () => {
    expect(activeFromPath('/service/groq/usage')).toEqual({ kind: 'service', serviceId: 'groq' })
    expect(activeFromPath('/service/sentry')).toEqual({ kind: 'service', serviceId: 'sentry' })
  })
})

describe('headerAction', () => {
  it('refreshes while the session is live or merely unverified', () => {
    expect(headerAction('connected', false)).toBe('refresh')
    expect(headerAction('unverified', false)).toBe('refresh')
    expect(headerAction('unverified', true)).toBe('refresh')
  })

  it('reconnects a dead session, and routes a sessionless plugin to its config form', () => {
    expect(headerAction('disconnected', false)).toBe('reconnect')
    expect(headerAction('disconnected', true)).toBe('connect')
  })
})
