import { useLabels } from '@butinapp/ui/i18n'
import { Switch } from '@butinapp/ui/primitives'

import type { LogLevel } from '../../../shared/ipc.js'

import { Row, SelectField, SettingsGroup, useAppSettings } from './parts.js'

// Cache-window options, in seconds. Sub-minute reads as `Ns`, the rest as minutes.
const CACHE_WINDOWS = [15, 30, 60, 300]
const fmtWindow = (seconds: number): string => (seconds < 60 ? `${seconds}s` : `${seconds / 60} min`)

// Log controls (English technical copy, matching the Logs viewer): the persisted capture gate + how long
// daily log files are kept.
const LOG_LEVELS = [
  { value: 'debug', label: 'Debug — everything' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors only' }
]
const LOG_RETENTION = [
  { value: '0', label: 'Session only (not saved to disk)' },
  { value: '1', label: 'Keep 1 day' },
  { value: '3', label: 'Keep 3 days' },
  { value: '7', label: 'Keep 1 week' },
  { value: '14', label: 'Keep 2 weeks' },
  { value: '30', label: 'Keep 30 days' }
]

// Advanced: capture/network behaviour and the read-cache window — knobs a power user reaches for, kept out of
// the everyday panes.
export const AdvancedPane = () => {
  const t = useLabels()
  const { settings, patch } = useAppSettings()

  return (
    <div className="space-y-5">
      <SettingsGroup>
        <Row
          title={t.manualCaptureLabel}
          hint={t.manualCaptureHint}
          control={
            <Switch
              checked={settings?.manualCapture ?? false}
              onCheckedChange={(v) => patch({ manualCapture: v })}
              aria-label={t.manualCaptureLabel}
            />
          }
        />
        <Row
          title={t.paceRequestsLabel}
          hint={t.paceRequestsHint}
          control={
            <Switch
              checked={settings?.paceRequests ?? true}
              onCheckedChange={(v) => patch({ paceRequests: v })}
              aria-label={t.paceRequestsLabel}
            />
          }
        />
        <SelectField
          label={t.cacheWindowLabel}
          hint={t.cacheWindowHint}
          value={String(settings?.cacheWindowSeconds ?? 30)}
          onValueChange={(v) => patch({ cacheWindowSeconds: Number(v) })}
          options={CACHE_WINDOWS.map((s) => ({ value: String(s), label: fmtWindow(s) }))}
        />
      </SettingsGroup>

      <SettingsGroup title={t.logsHeading}>
        <SelectField
          label={t.logLevelLabel}
          hint={t.logLevelHint}
          value={settings?.logLevel ?? 'info'}
          onValueChange={(v) => patch({ logLevel: v as LogLevel })}
          options={LOG_LEVELS}
        />
        <SelectField
          label={t.logRetentionLabel}
          hint={t.logRetentionHint}
          value={String(settings?.logRetentionDays ?? 0)}
          onValueChange={(v) => patch({ logRetentionDays: Number(v) })}
          options={LOG_RETENTION}
        />
      </SettingsGroup>

      <SettingsGroup title={t.devModeSection}>
        <Row
          title={t.devModeLabel}
          hint={t.devModeHint}
          control={
            <Switch
              checked={settings?.devMode ?? false}
              onCheckedChange={(v) => patch({ devMode: v })}
              aria-label={t.devModeLabel}
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}
