import type { FxRates } from '@butinapp/sdk/util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { dataRootDir } from './store.js'

// The user's currency settings: which currency the Overview rolls up into, and the rate table that gets
// foreign-currency services there. Rates are entered manually or filled by a transparent fetch; `source` +
// `fetchedAt` record where the current table came from. `rates[c]` = value in baseCurrency of 1 unit of c.
export type FxConfig = {
  baseCurrency: string
  rates: FxRates
  source?: string
  fetchedAt?: string
}

const DEFAULT: FxConfig = { baseCurrency: 'USD', rates: {} }

const fxPath = (): string => join(dataRootDir(), 'fx.json')

export const getFxConfig = async (): Promise<FxConfig> => {
  try {
    const stored = JSON.parse(await readFile(fxPath(), 'utf8')) as Partial<FxConfig>

    return { ...DEFAULT, ...stored }
  } catch {
    return DEFAULT
  }
}

export const setFxConfig = async (cfg: FxConfig): Promise<void> => {
  await mkdir(dirname(fxPath()), { recursive: true })
  await writeFile(fxPath(), JSON.stringify(cfg, null, 2))
}
