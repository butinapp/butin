import { contextBridge, ipcRenderer } from 'electron'

import {
  type ArchiveProgressDto,
  type ButinApi,
  IPC,
  IPC_EVENT,
  type JobProgressDto,
  type UpdateStateDto
} from '../shared/ipc.js'

const subscribe = <T>(channel: string, cb: (p: T) => void): (() => void) => {
  const listener = (_e: unknown, p: T): void => cb(p)

  ipcRenderer.on(channel, listener)

  return () => ipcRenderer.removeListener(channel, listener)
}

// One invoke-bridge method per channel, in the IPC map's domain → method shape → window.butin.<domain>.<method>.
// Pure mechanical wiring (no per-method boilerplate); the event channels are subscriptions, wired below.
const domains = Object.fromEntries(
  Object.entries(IPC).map(([domain, methods]) => [
    domain,
    Object.fromEntries(
      Object.entries(methods).map(([name, channel]) => [
        name,
        (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
      ])
    )
  ])
)

const api = {
  ...domains,
  platform: process.platform,
  onJobProgress: (cb: (p: JobProgressDto) => void) => subscribe<JobProgressDto>(IPC_EVENT.jobProgress, cb),
  onArchiveProgress: (cb: (p: ArchiveProgressDto) => void) =>
    subscribe<ArchiveProgressDto>(IPC_EVENT.archiveProgress, cb),
  onNotificationsChanged: (cb: () => void) => subscribe<void>(IPC_EVENT.notificationsChanged, cb),
  onUpdateState: (cb: (state: UpdateStateDto) => void) => subscribe<UpdateStateDto>(IPC_EVENT.updateState, cb)
} as ButinApi

contextBridge.exposeInMainWorld('butin', api)
