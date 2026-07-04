import { join } from 'node:path'

import type { NotificationDto } from '../../shared/ipc.js'
import { readJson, writeJson } from '../store/secure-fs.js'
import { dataRootDir } from '../store/store.js'

const notifPath = (): string => join(dataRootDir(), 'notifications.json')

export const readNotifications = async (): Promise<NotificationDto[]> => {
  const stored = await readJson<{ items: NotificationDto[] }>(dataRootDir(), notifPath())

  return stored?.items ?? []
}

export const writeNotifications = async (items: NotificationDto[]): Promise<void> => {
  await writeJson(dataRootDir(), notifPath(), { items })
}

const mutate = async (fn: (items: NotificationDto[]) => NotificationDto[]): Promise<NotificationDto[]> => {
  const next = fn(await readNotifications())

  await writeNotifications(next)

  return next
}

export const markNotificationRead = (id: string): Promise<NotificationDto[]> =>
  mutate((items) => items.map((n) => (n.id === id ? { ...n, read: true } : n)))

export const markAllNotificationsRead = (): Promise<NotificationDto[]> =>
  mutate((items) => items.map((n) => ({ ...n, read: true })))

export const dismissNotification = (id: string): Promise<NotificationDto[]> =>
  mutate((items) => items.filter((n) => n.id !== id))
