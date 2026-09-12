import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { setConfigRoot, setSetting } from '../store/config-file.js'

import { cookieRemoveUrl, cookieToDto, devHandlers, partitionLabel } from './dev.js'

describe('the developer channels are inert until developer mode is on', () => {
  test('a cookie read is refused while developer mode is off', async () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-devmode-')))

    await expect(devHandlers.listCookies({} as never, 'persist:butin')).rejects.toThrow(/developer mode/)
    await expect(devHandlers.listPartitions()).rejects.toThrow(/developer mode/)
  })

  test('turning developer mode on lets the channel through to the session lookup', async () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-devmode-on-')))
    setSetting('devMode', true)

    // Off-Electron there is no session module, so a permitted call fails later and differently.
    await expect(devHandlers.listCookies({} as never, 'persist:butin')).rejects.not.toThrow(/developer mode/)
  })
})

describe('cookieToDto', () => {
  test('maps an Electron cookie, computing size and session/expires', () => {
    const dto = cookieToDto({
      name: 'sid',
      value: 'abc',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: 1893456000
    } as never)

    expect(dto).toEqual({
      name: 'sid',
      value: 'abc',
      domain: '.google.com',
      path: '/',
      size: 6,
      expires: 1893456000,
      session: false,
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction'
    })
  })

  test('a cookie with no expirationDate is a session cookie', () => {
    const dto = cookieToDto({ name: 'x', value: 'y', domain: 'example.com', path: '/' } as never)

    expect(dto.session).toBe(true)
    expect(dto.expires).toBeNull()
  })
})

describe('cookieRemoveUrl', () => {
  test('builds an https url, stripping a leading dot from the host', () => {
    expect(cookieRemoveUrl({ domain: '.google.com', path: '/', secure: true })).toBe('https://google.com/')
  })

  test('http when not secure; preserves the path', () => {
    expect(cookieRemoveUrl({ domain: 'mail.google.com', path: '/mail', secure: false })).toBe(
      'http://mail.google.com/mail'
    )
  })
})

describe('partitionLabel', () => {
  const plugins = [
    { meta: { id: 'stripe', name: 'Stripe' }, transport: { nativeBrowserHeaders: true } },
    { meta: { id: 'acme', name: 'Acme' }, session: { partition: 'persist:acme-custom' } }
  ] as never[]

  test('the active partition is the default shared one', () => {
    expect(partitionLabel('persist:butin', 'persist:butin', plugins)).toBe('Default (shared)')
  })

  test('a native partition reads its plugin name', () => {
    expect(partitionLabel('persist:butin-native-stripe', 'persist:butin', plugins)).toBe('Stripe (isolated)')
  })

  test('a custom session.partition reads its plugin name', () => {
    expect(partitionLabel('persist:acme-custom', 'persist:butin', plugins)).toBe('Acme')
  })

  test('an unknown partition falls back to the bare string', () => {
    expect(partitionLabel('persist:butin-mystery', 'persist:butin', plugins)).toBe('butin-mystery')
  })
})
