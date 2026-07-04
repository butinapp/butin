import { contextBridge, ipcRenderer } from 'electron'

import type { DomainProfile } from '../detect/types.js'
import type { AppLockStatus } from '../main/app-lock.js'
import type { DomainSummary, KickstartOutcome, PluginSuggestion, ProfileOption } from '../main/ipc.js'

// The window.recorder bridge — all methods call the main-process IPC handlers registered in main/ipc.ts.
const recorderApi = {
  // Domains/recordings are scoped to one profile's browser partition, so every query takes the partition.
  listDomains: (partition: string): Promise<DomainSummary[]> => ipcRenderer.invoke('recorder:list-domains', partition),

  listProfiles: (): Promise<ProfileOption[]> => ipcRenderer.invoke('recorder:list-profiles'),

  // The profile the recorder last had selected ('' when never set) — restored on launch so it reopens there.
  getLastProfile: (): Promise<string> => ipcRenderer.invoke('recorder:get-last-profile'),

  setLastProfile: (profileId: string): Promise<void> => ipcRenderer.invoke('recorder:set-last-profile', profileId),

  getDomain: (
    surface: string,
    partition: string
  ): Promise<{
    profile: DomainProfile
    runs: { runId: string; label: string; startUrl: string; startedAt: string; requestCount: number }[]
  }> => ipcRenderer.invoke('recorder:get-domain', surface, partition),

  startRecording: (input: {
    label?: string
    startUrl: string
    partition?: string
    /** Begin capturing immediately (default true); false opens the capture window paused. */
    autoRecord?: boolean
    /** Record in a fresh in-memory partition with no persisted cookies (default false). */
    isolated?: boolean
  }): Promise<{ runId: string }> => ipcRenderer.invoke('recorder:start-recording', input),

  mergeSurfaces: (input: { host: string; into: string }): Promise<void> =>
    ipcRenderer.invoke('recorder:merge-surfaces', input),

  // Preview a kickstart (suggested id/name/vendor + capability stubs + collision) without writing anything.
  suggestPlugin: (input: { surface: string; partition: string }): Promise<PluginSuggestion> =>
    ipcRenderer.invoke('recorder:suggest-plugin', input),

  // Scaffold the plugin from the surface's recordings, write the brief, copy the kickoff prompt to clipboard.
  kickstartPlugin: (input: {
    surface: string
    partition: string
    id: string
    name: string
    vendor: string
  }): Promise<KickstartOutcome> => ipcRenderer.invoke('recorder:kickstart-plugin', input),

  openRunFolder: (runId: string): Promise<void> => ipcRenderer.invoke('recorder:open-run-folder', runId),

  // Copy a run's absolute folder path to the clipboard; resolves with the path so the UI can confirm/toast.
  copyRunPath: (runId: string): Promise<string> => ipcRenderer.invoke('recorder:copy-run-path', runId),

  // Subscribe to "a recording finished and was saved". Returns an unsubscribe fn. The renderer uses this to
  // refresh the domain list after a capture window closes (the new run only exists on disk at that point).
  onRecordingSaved: (cb: (payload: { runId: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { runId: string }): void => cb(payload)

    ipcRenderer.on('recorder:recording-saved', listener)

    return () => ipcRenderer.removeListener('recorder:recording-saved', listener)
  },

  // Is the Butin app running, and on which profile? Drives the in-use block before recording.
  appLockStatus: (): Promise<AppLockStatus> => ipcRenderer.invoke('recorder:app-lock-status'),

  // Delete one recording, or every recording under a surface for one partition.
  deleteRecording: (runId: string): Promise<void> => ipcRenderer.invoke('recorder:delete-recording', runId),

  deleteDomain: (input: { surface: string; partition: string }): Promise<void> =>
    ipcRenderer.invoke('recorder:delete-domain', input)
}

contextBridge.exposeInMainWorld('recorder', recorderApi)

// Augment the global Window type so renderer code can call window.recorder with full type safety.
declare global {
  interface Window {
    recorder: typeof recorderApi
  }
}
