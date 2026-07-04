import { join } from 'node:path'

import type { AlertConfigDto } from '../../shared/ipc.js'
import { readJson, writeJson } from '../store/secure-fs.js'
import { dataRootDir } from '../store/store.js'

// Ships ON with sensible thresholds so the feature does something immediately; the user mutes a facet by
// clearing its threshold in Settings.
export const DEFAULT_ALERT_CONFIG: AlertConfigDto = {
  change: {
    dod: { spend: 50, usage: 50 },
    wow: { spend: 30, usage: 50 },
    mom: { spend: 20, usage: 40 }
  },
  health: { fxMissing: true }
}

const alertsPath = (): string => join(dataRootDir(), 'alerts.json')

export const getAlertConfig = async (): Promise<AlertConfigDto> => {
  const stored = await readJson<AlertConfigDto>(dataRootDir(), alertsPath())

  return stored ? { ...DEFAULT_ALERT_CONFIG, ...stored } : DEFAULT_ALERT_CONFIG
}

export const setAlertConfig = async (cfg: AlertConfigDto): Promise<void> => {
  await writeJson(dataRootDir(), alertsPath(), cfg)
}
