import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { NotificationDto } from '../../shared/ipc.js'
import { setDataRoot } from '../store/store.js'

import {
  dismissNotification,
  markAllNotificationsRead,
  markNotificationRead,
  readNotifications,
  writeNotifications
} from './notifications-store.js'

const n = (id: string): NotificationDto => ({
  id,
  createdAt: '2026-06-16T00:00:00Z',
  kind: 'change',
  severity: 'info',
  read: false
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-notif-'))
  setDataRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('empty by default; round-trips a written list', async () => {
  expect(await readNotifications()).toEqual([])
  await writeNotifications([n('a'), n('b')])
  expect((await readNotifications()).map((x) => x.id)).toEqual(['a', 'b'])
})

test('markNotificationRead flips one; markAll flips all; dismiss removes', async () => {
  await writeNotifications([n('a'), n('b')])
  expect((await markNotificationRead('a')).find((x) => x.id === 'a')!.read).toBe(true)
  expect((await markAllNotificationsRead()).every((x) => x.read)).toBe(true)
  expect((await dismissNotification('a')).map((x) => x.id)).toEqual(['b'])
})
