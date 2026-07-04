import type { Session } from 'electron'
import { expect, test, vi } from 'vitest'

import { promoteSessionCookies } from './cookies.js'

// A minimal fake Electron cookie jar with the few methods promoteSessionCookies touches.
const fakeSession = (cookies: { name: string; domain: string; session: boolean }[]) => {
  const set = vi.fn(async (_opts: { name: string }) => undefined)

  return {
    set,
    ses: {
      cookies: {
        get: async () => cookies.map((c) => ({ ...c, path: '/', secure: true })),
        set,
        flushStore: async () => undefined
      }
    } as unknown as Session
  }
}

test('promoteSessionCookies persists every session cookie by default', async () => {
  const { ses, set } = fakeSession([
    { name: 'a', domain: '.desjardins.com', session: true },
    { name: 'b', domain: '.github.com', session: true }
  ])

  await promoteSessionCookies(ses)

  expect(set.mock.calls.map((c) => c[0].name).sort()).toEqual(['a', 'b'])
})

test('promoteSessionCookies skips cookies whose domain matches an excluded host (persistCookies:false)', async () => {
  const { ses, set } = fakeSession([
    { name: 'desj', domain: '.mouv.desjardins.com', session: true },
    { name: 'keep', domain: '.github.com', session: true }
  ])

  await promoteSessionCookies(ses, ['desjardins.com'])

  // the excluded service's cookie is left to expire; everyone else still gets promoted
  expect(set.mock.calls.map((c) => c[0].name)).toEqual(['keep'])
})

test('promoteSessionCookies ignores non-session cookies (already persistent)', async () => {
  const { ses, set } = fakeSession([{ name: 'persistent', domain: '.x.com', session: false }])

  await promoteSessionCookies(ses)

  expect(set).not.toHaveBeenCalled()
})
