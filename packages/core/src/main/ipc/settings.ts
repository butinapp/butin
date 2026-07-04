import { type AppSettingsDto, type FxConfigDto } from '../../shared/ipc.js'
import { pruneLogs, setLogLevels, setLogRetention } from '../log.js'
import {
  getFormatPrefs,
  getLogLevelOverrides,
  getSetting,
  getTablePrefs,
  setFormatPrefs,
  setLogLevelOverride,
  setSetting,
  setTablePrefs
} from '../store/config-file.js'
import { getFxConfig, setFxConfig } from '../store/fx-rates.js'
import { configureRequestPacing } from '../transport/request-pacer.js'

import type { IpcHandlers } from './result.js'

export const settingsHandlers = {
  getTablePrefs: (_event, key: string) => getTablePrefs(key),

  setTablePrefs: (_event, key: string, prefs: unknown) => {
    setTablePrefs(key, prefs as Parameters<typeof setTablePrefs>[1])
  },

  get: () => ({
    manualCapture: getSetting('manualCapture'),
    paceRequests: getSetting('paceRequests'),
    startPage: getSetting('startPage'),
    idleLockMinutes: getSetting('idleLockMinutes'),
    lockOnSleep: getSetting('lockOnSleep'),
    cacheWindowSeconds: getSetting('cacheWindowSeconds'),
    logRetentionDays: getSetting('logRetentionDays'),
    logLevel: getSetting('logLevel'),
    logLevelOverrides: getLogLevelOverrides(),
    devMode: getSetting('devMode'),
    ...getFormatPrefs()
  }),

  // One patch channel for every app setting. Each field is applied only when present; log-retention changes
  // prune immediately, and any log-level change is re-applied to the live gate. A new setting = a new
  // AppSettingsDto field, no new channel.
  patch: (_event, patch: Partial<AppSettingsDto>) => {
    const { manualCapture, paceRequests, startPage, idleLockMinutes, lockOnSleep, cacheWindowSeconds, devMode } = patch
    const { logRetentionDays, logLevel, logLevelOverrides, ...format } = patch

    if (manualCapture !== undefined) {
      setSetting('manualCapture', manualCapture)
    }

    if (paceRequests !== undefined) {
      setSetting('paceRequests', paceRequests)
      configureRequestPacing(paceRequests)
    }

    // The auto-lock interval + suspend handler read these live, so persisting is enough to retime locking.
    if (startPage !== undefined) {
      setSetting('startPage', startPage)
    }

    if (idleLockMinutes !== undefined) {
      setSetting('idleLockMinutes', idleLockMinutes)
    }

    if (lockOnSleep !== undefined) {
      setSetting('lockOnSleep', lockOnSleep)
    }

    if (cacheWindowSeconds !== undefined) {
      setSetting('cacheWindowSeconds', cacheWindowSeconds)
    }

    if (devMode !== undefined) {
      setSetting('devMode', devMode)
    }

    if (logRetentionDays !== undefined) {
      setSetting('logRetentionDays', logRetentionDays)
      setLogRetention(logRetentionDays)
      pruneLogs(logRetentionDays)
    }

    if (logLevel !== undefined) {
      setSetting('logLevel', logLevel)
    }

    if (logLevelOverrides !== undefined) {
      // Diff against the stored set so a removed key clears its override (setting it to undefined deletes it).
      const previous = getLogLevelOverrides()

      for (const key of Object.keys(previous)) {
        if (logLevelOverrides[key] === undefined) {
          setLogLevelOverride(key, undefined)
        }
      }

      for (const [key, level] of Object.entries(logLevelOverrides)) {
        setLogLevelOverride(key, level)
      }
    }

    if (logLevel !== undefined || logLevelOverrides !== undefined) {
      setLogLevels(getSetting('logLevel'), getLogLevelOverrides())
    }

    if (format.currencyStyle !== undefined || format.dateFormat !== undefined) {
      setFormatPrefs(format)
    }
  },

  getFx: () => getFxConfig(),
  setFx: (_event, cfg: FxConfigDto) => setFxConfig(cfg)
} satisfies IpcHandlers['settings']
