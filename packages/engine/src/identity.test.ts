import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { applyBrowserIdentity, BROWSER_UA, SEC_CH_UA_HEADERS } from './identity.js'

// A fake session that captures the onBeforeSendHeaders listener so a request can be run through it.
const fakeSession = () => {
  let listener: ((details: { requestHeaders: Record<string, string> }, cb: (r: unknown) => void) => void) | null = null

  const ses = {
    setUserAgent: vi.fn(),
    webRequest: { onBeforeSendHeaders: vi.fn((fn) => (listener = fn)) }
  } as unknown as Session

  const run = (requestHeaders: Record<string, string>): Record<string, string> => {
    let out: Record<string, string> = {}

    listener!({ requestHeaders }, (r) => (out = (r as { requestHeaders: Record<string, string> }).requestHeaders))

    return out
  }

  return { ses, run }
}

describe('browser identity', () => {
  it('presents as Google Chrome, not Electron', () => {
    expect(BROWSER_UA).toContain('Chrome/')
    expect(BROWSER_UA).not.toContain('Electron')
  })

  it('derives the Sec-Ch-Ua version from the same major as the UA string', () => {
    const major = BROWSER_UA.match(/Chrome\/(\d+)/)?.[1]

    expect(major).toBeTruthy()
    expect(SEC_CH_UA_HEADERS['Sec-Ch-Ua']).toContain(`"Google Chrome";v="${major}"`)
  })

  it('injects Sec-Ch-Ua but passes a page-set X-Requested-With through untouched', () => {
    const { ses, run } = fakeSession()

    applyBrowserIdentity(ses)
    const headers = run({ 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' })

    // The XHR marker the page set survives — AJAX-gated backends (Power Pages, ASP.NET/Rails CSRF) need it.
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['Sec-Ch-Ua']).toBe(SEC_CH_UA_HEADERS['Sec-Ch-Ua'])
  })
})
