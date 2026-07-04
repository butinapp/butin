import { expect, test } from 'vitest'

import type { DevCookieDto } from '../../../shared/ipc.js'

import { groupCookiesByDomain } from './cookie-grouping.js'

const ck = (domain: string, name: string, value: string): DevCookieDto => ({
  name,
  value,
  domain,
  path: '/',
  size: name.length + value.length,
  expires: null,
  session: true,
  httpOnly: false,
  secure: false,
  sameSite: 'lax'
})

test('groups by domain with count + total bytes, biggest domain first', () => {
  const groups = groupCookiesByDomain([
    ck('.google.com', 'a', 'x'),
    ck('example.com', 'b', 'y'),
    ck('.google.com', 'c', 'zzzz')
  ])

  expect(groups.map((g) => g.domain)).toEqual(['.google.com', 'example.com'])
  expect(groups[0]).toMatchObject({ count: 2, bytes: 2 + 5 })
  expect(groups[1]).toMatchObject({ count: 1, bytes: 2 })
})

test('filter matches the domain substring, case-insensitive', () => {
  const groups = groupCookiesByDomain([ck('.google.com', 'a', 'x'), ck('example.com', 'b', 'y')], 'GOOGLE')

  expect(groups.map((g) => g.domain)).toEqual(['.google.com'])
})
