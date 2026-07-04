import type { IpcMainInvokeEvent } from 'electron'

import { type IPC, type Result } from '../../shared/ipc.js'
import { classifyFailure } from '../plugin/failure-classifier.js'
import { pluginById } from '../plugin/plugins.js'
import { isSpaSessionExpired } from '../session/spa-session.js'

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

// Every invoke channel's handler, in the same domain → method shape as the IPC map. The full (non-Partial)
// mapped type makes the compiler require a handler for every channel: index.ts composes the per-domain
// fragments into one value of this type, so a fragment that forgets a channel fails to compile. Streaming
// channels live in IPC_EVENT, not IPC, so they carry no invoke handler here.
export type IpcHandlers = {
  [D in keyof typeof IPC]: { [M in keyof (typeof IPC)[D]]: IpcHandler }
}

// Per-plugin context that sharpens failure classification (a 403 on a browser-engine plugin means verification
// is needed, not a permission error; clearOnStatuses says which status means a dead session). Read off the descriptor.
export const failureCtx = (
  plugin: ReturnType<typeof pluginById>
): { requiresBrowserEngine?: boolean; clearOnStatuses?: number[]; hasConfigFields?: boolean } => ({
  requiresBrowserEngine: plugin?.transport?.requiresBrowserEngine,
  clearOnStatuses: plugin?.auth.clearOnStatuses,
  hasConfigFields: (plugin?.config?.fields?.length ?? 0) > 0
})

// Wrap a handler body into the single Result<T> envelope every fallible IPC channel returns — so a thrown
// collector/network error never crosses IPC unhandled, it comes back as { ok: false, error }. A failure is
// classified (status + message + optional per-plugin ctx) so the UI gets a structured cause + action set.
export const safeResult = async <T>(
  fn: () => Promise<T>,
  ctx?: { requiresBrowserEngine?: boolean; clearOnStatuses?: number[] }
): Promise<Result<T>> => {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    const e = err as {
      message?: string
      status?: number
      response?: { status?: number }
      dataInvalid?: boolean
      permissionDenied?: boolean
    }
    const { cause, actions } = classifyFailure({
      status: e.status ?? e.response?.status,
      sessionExpired: isSpaSessionExpired(err),
      message: e.message,
      requiresBrowserEngine: ctx?.requiresBrowserEngine,
      clearOnStatuses: ctx?.clearOnStatuses,
      dataInvalid: e.dataInvalid,
      permissionDenied: e.permissionDenied
    })

    return { ok: false, error: e.message ?? String(err), cause, actions }
  }
}
