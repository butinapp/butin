import type { AuthStrategy, ButinClient, CredentialStore } from '@butinapp/sdk'
import { expect, test, vi } from 'vitest'

import { clearSpaBearer, setCachedBearer } from '../session/spa-session.js'

import { createAuthResolver } from './auth-resolve.js'

const credsWith = (fields: Record<string, string>): CredentialStore => ({
  get: (f = 'cookie') => fields[f],
  set: (f, v) => {
    fields[f] = v
  }
})

const noClient = {} as ButinClient

test('cookie strategy attaches the stored cookie', async () => {
  const resolve = createAuthResolver({ kind: 'cookie' }, credsWith({ cookie: 'sessionKey=abc' }), noClient, {})

  expect(await resolve()).toEqual({ cookie: 'sessionKey=abc' })
})

test('bearer-token strategy uses the tokenField', async () => {
  const strat: AuthStrategy = { kind: 'bearer-token', tokenField: 'idToken' }
  const resolve = createAuthResolver(strat, credsWith({ idToken: 'jwt123' }), noClient, {})

  expect(await resolve()).toEqual({ headers: { Authorization: 'Bearer jwt123' } })
})

test('custom resolve() hook is called and memoized', async () => {
  const hook = vi.fn(async () => ({ headers: { 'X-Nonce': 'n1' } }))
  const strat: AuthStrategy = { kind: 'cookie-csrf', resolve: hook }
  const resolve = createAuthResolver(strat, credsWith({ cookie: 'c' }), noClient, {})

  await resolve()
  await resolve()
  expect(hook).toHaveBeenCalledTimes(1)
})

test('memo:false re-runs the hook each call', async () => {
  const hook = vi.fn(async () => ({ headers: { 'X-Nonce': 'n' } }))
  const strat: AuthStrategy = { kind: 'rotating-refresh', resolve: hook }
  const resolve = createAuthResolver(strat, credsWith({ cookie: 'c' }), noClient, {}, { memo: false })

  await resolve()
  await resolve()
  expect(hook).toHaveBeenCalledTimes(2)
})

test('spa-bearer attaches the cached Bearer + the stored cookie', async () => {
  setCachedBearer('carnet-sante', 'Bearer minted')
  const strat: AuthStrategy = { kind: 'spa-bearer', bootUrl: 'x', authCaptureUrlPatterns: [] }
  const resolve = createAuthResolver(strat, credsWith({ cookie: 'sso=1' }), noClient, {}, { pluginId: 'carnet-sante' })

  expect(await resolve()).toEqual({ headers: { Authorization: 'Bearer minted' }, cookie: 'sso=1' })
  clearSpaBearer('carnet-sante')
})

test('spa-bearer bare resolver does not mint — attaches cookie only', async () => {
  const strat: AuthStrategy = { kind: 'spa-bearer', bootUrl: 'x', authCaptureUrlPatterns: [] }
  const resolve = createAuthResolver(
    strat,
    credsWith({ cookie: 'sso=1' }),
    noClient,
    {},
    {
      pluginId: 'nope',
      bare: true
    }
  )

  expect(await resolve()).toEqual({ cookie: 'sso=1' })
})
