import { type AlertConfigDto } from '../../shared/ipc.js'
import { getAlertConfig, setAlertConfig } from '../alerts/alerts-config.js'
import {
  dismissNotification,
  markAllNotificationsRead,
  markNotificationRead,
  readNotifications
} from '../alerts/notifications-store.js'

import type { IpcHandlers } from './result.js'

export const notificationHandlers = {
  list: () => readNotifications(),
  markRead: (_event, id: string) => markNotificationRead(id),
  markAllRead: () => markAllNotificationsRead(),
  dismiss: (_event, id: string) => dismissNotification(id),
  getAlertConfig: () => getAlertConfig(),
  setAlertConfig: (_event, cfg: AlertConfigDto) => setAlertConfig(cfg)
} satisfies IpcHandlers['notifications']
