import type { Cookie, Session } from 'electron'
import { expect, test, vi } from 'vitest'

import { copyCookies, promoteSessionCookies, toSetDetails } from './cookies.js'

const cookie = (over: Partial<Cookie>): Cookie =>
  ({ name: 'sid', value: 'v', domain: '.example.com', path: '/', secure: true, session: true, ...over }) as Cookie

test('toSetDetails keeps a domain-scoped cookie domain-scoped', () => {
  const out = toSetDetails(cookie({ domain: '.example.com' }))

  expect(out.domain).toBe('.example.com')
  expect(out.url).toBe('https://example.com/')
})

// Electron widens `domain` with a preceding dot, so passing one for a host-only cookie writes a SECOND
// subdomain-scoped cookie instead of re-setting the original.
test('toSetDetails drops domain for a host-only cookie', () => {
  expect(toSetDetails(cookie({ domain: 'app.example.com', hostOnly: true })).domain).toBeUndefined()
  expect(toSetDetails(cookie({ domain: 'app.example.com' })).domain).toBeUndefined()
})

test('toSetDetails pins the __Host- prefix rules whatever the stored attributes say', () => {
  const out = toSetDetails(cookie({ name: '__Host-GAPS', domain: 'accounts.google.com', path: '/deep', secure: false }))

  expect(out.domain).toBeUndefined()
  expect(out.path).toBe('/')
  expect(out.secure).toBe(true)
  expect(out.url).toBe('https://accounts.google.com/')
})

test('toSetDetails forces __Secure- cookies secure and preserves a persistent expiry', () => {
  const out = toSetDetails(cookie({ name: '__Secure-1PSID', secure: false, session: false, expirationDate: 123 }))

  expect(out.secure).toBe(true)
  expect(out.expirationDate).toBe(123)
})

test('toSetDetails leaves a session cookie a session cookie unless an expiry is given', () => {
  expect(toSetDetails(cookie({ session: true })).expirationDate).toBeUndefined()
  expect(toSetDetails(cookie({ session: true }), { expirationDate: 999 }).expirationDate).toBe(999)
})

test('copyCookies moves every cookie into the target session and reports the count', async () => {
  const set = vi.fn(async (_o: { name: string; domain?: string }) => undefined)
  const from = {
    cookies: { get: async () => [cookie({ name: 'a' }), cookie({ name: 'b', domain: 'app.example.com' })] }
  } as unknown as Session
  const to = { cookies: { set } } as unknown as Session

  expect(await copyCookies(from, to)).toBe(2)
  expect(set.mock.calls.map((c) => [c[0].name, c[0].domain])).toEqual([
    ['a', '.example.com'],
    ['b', undefined]
  ])
})

test('copyCookies counts only what landed when the target rejects one', async () => {
  const set = vi.fn(async (o: { name: string }) => {
    if (o.name === 'bad') {
      throw new Error('rejected')
    }
  })
  const from = {
    cookies: { get: async () => [cookie({ name: 'bad' }), cookie({ name: 'good' })] }
  } as unknown as Session

  expect(await copyCookies(from, { cookies: { set } } as unknown as Session)).toBe(1)
})

// A minimal fake Electron cookie jar with the few methods promoteSessionCookies touches.
const fakeSession = (cookies: { name: string; domain: string; session: boolean; hostOnly?: boolean }[]) => {
  const set = vi.fn(async (_opts: { name: string; domain?: string; path?: string }) => undefined)

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

// Electron widens `domain` with a preceding dot, so handing one back for a host-only cookie writes a SECOND,
// subdomain-scoped cookie of the same name instead of persisting the original — and the server, which sends no
// Domain attribute, only ever updates the original. Two values under one name is what breaks a login.
test('promoteSessionCookies keeps a host-only cookie host-only', async () => {
  const { ses, set } = fakeSession([
    { name: '_digitalocean2_session_v4', domain: 'cloud.digitalocean.com', session: true, hostOnly: true },
    { name: 'shared', domain: '.digitalocean.com', session: true, hostOnly: false }
  ])

  await promoteSessionCookies(ses)

  const byName = Object.fromEntries(set.mock.calls.map((c) => [c[0].name, c[0]]))

  expect(byName['_digitalocean2_session_v4']!.domain).toBeUndefined()
  expect(byName['shared']!.domain).toBe('.digitalocean.com')
})

test('promoteSessionCookies treats a dotless domain as host-only when hostOnly is absent', async () => {
  const { ses, set } = fakeSession([{ name: 'LSID', domain: 'accounts.google.com', session: true }])

  await promoteSessionCookies(ses)

  expect(set.mock.calls[0]![0].domain).toBeUndefined()
})

// A `__Host-` cookie must be Secure, path=/ and carry NO domain, whatever the stored attributes say.
test('promoteSessionCookies honors the __Host- prefix rules', async () => {
  const { ses, set } = fakeSession([{ name: '__Host-GAPS', domain: 'accounts.google.com', session: true }])

  await promoteSessionCookies(ses)

  expect(set.mock.calls[0]![0].domain).toBeUndefined()
  expect(set.mock.calls[0]![0].path).toBe('/')
})

test('promoteSessionCookies ignores non-session cookies (already persistent)', async () => {
  const { ses, set } = fakeSession([{ name: 'persistent', domain: '.x.com', session: false }])

  await promoteSessionCookies(ses)

  expect(set).not.toHaveBeenCalled()
})
