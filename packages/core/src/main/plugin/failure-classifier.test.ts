import { describe, expect, it } from 'vitest'

import { classifyFailure } from './failure-classifier.js'

describe('classifyFailure', () => {
  it('login window closed before capture → session-not-captured', () => {
    expect(classifyFailure({ capture: 'closed' }).cause).toBe('session-not-captured')
    expect(classifyFailure({ capture: 'no-marker' }).cause).toBe('session-not-captured')
  })

  it('a clearing status (default 401) → session-expired', () => {
    expect(classifyFailure({ status: 401, clearOnStatuses: [401] }).cause).toBe('session-expired')
  })

  it('a status-less dead session (spa-bearer expiry) → session-expired + reconnect', () => {
    // SpaSessionExpired carries no HTTP status, so the cause can only be derived from this signal, not a code.
    const out = classifyFailure({ sessionExpired: true, message: 'session expired for videotron — re-run Magic Login' })

    expect(out.cause).toBe('session-expired')
    expect(out.actions).toContain('reconnect')
  })

  it('a contract-validation failure → data-invalid', () => {
    expect(classifyFailure({ dataInvalid: true }).cause).toBe('data-invalid')
  })

  it('403 on a browser-engine plugin → verification-required', () => {
    expect(classifyFailure({ status: 403, requiresBrowserEngine: true }).cause).toBe('verification-required')
  })

  it('403 on a normal plugin → permission', () => {
    expect(classifyFailure({ status: 403 }).cause).toBe('permission')
  })

  it('no response → network', () => {
    expect(classifyFailure({ message: 'getaddrinfo ENOTFOUND api.x.com' }).cause).toBe('network')
  })

  it('404 on a plugin that takes a configured id → config-invalid (offer Edit settings)', () => {
    const out = classifyFailure({ status: 404, hasConfigFields: true })

    expect(out.cause).toBe('config-invalid')
    expect(out.actions).toContain('edit-settings')
  })

  it('404 on a plugin with no config fields stays generic', () => {
    expect(classifyFailure({ status: 404 }).cause).toBe('unknown')
  })

  it('unknown otherwise', () => {
    expect(classifyFailure({ status: 500 }).cause).toBe('unknown')
  })

  it('carries the default action set for the cause', () => {
    expect(classifyFailure({ status: 401, clearOnStatuses: [401] }).actions).toContain('reconnect')
  })
})
