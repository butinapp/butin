import { convert } from '@butinapp/sdk/util'
import { combineDailySpend, deriveDailySpend, type DailyPoint } from '@butinapp/shapes'
import { BrowserWindow } from 'electron'

import { IPC_EVENT, type OverviewTileDto } from '../../shared/ipc.js'
import { createLogger } from '../log.js'
import { pluginById } from '../plugin/plugins.js'
import { type FxConfig, getFxConfig } from '../store/fx-rates.js'
import { readLedger } from '../store/ledger.js'
import { buildOverview } from '../store/overview.js'
import { seriesPoints } from '../store/project-ledger.js'

import { getAlertConfig } from './alerts-config.js'
import { evaluateChangeAlerts, type SeriesInput } from './change-alerts.js'
import { evaluateHealthChecks } from './health-checks.js'
import { mergeNotifications } from './merge.js'
import { readNotifications, writeNotifications } from './notifications-store.js'

const log = createLogger({ scope: 'alerts' })
const DEBOUNCE_MS = 1500
const TOTAL_ID = '__total__'

// A service's 'other'-section per-day series, derived from whichever capability's ledger carries it.
const usageDaily = async (pluginId: string): Promise<DailyPoint[]> => {
  const plugin = pluginById(pluginId)

  for (const c of plugin?.capabilities ?? []) {
    const led = await readLedger(pluginId, c.id)
    const pts = led ? seriesPoints(led, 'other') : []

    if (pts.length > 0) {
      return deriveDailySpend(pts)
    }
  }

  return []
}

const convertDaily = (daily: DailyPoint[], from: string, to: string, fx: FxConfig): DailyPoint[] =>
  daily.flatMap((p) => {
    const value = convert(p.value, from, to, fx.rates)

    return value === null ? [] : [{ ...p, value }]
  })

// Build the per-(service, facet) series the change evaluator scores, plus the cross-service spend total.
export const buildAlertSeries = async (tiles: OverviewTileDto[], fx: FxConfig): Promise<SeriesInput[]> => {
  const base = fx.baseCurrency
  const series: SeriesInput[] = []

  for (const t of tiles) {
    if (t.state !== 'connected') {
      continue
    }

    if (t.daily?.length) {
      series.push({ pluginId: t.pluginId, facet: 'spend', currency: t.currency ?? base, daily: t.daily })
    }

    const usage = t.summaries?.find((s) => s.section === 'other' && s.role === 'money')

    if (usage) {
      const daily = await usageDaily(t.pluginId)

      if (daily.length) {
        series.push({ pluginId: t.pluginId, facet: 'usage', currency: usage.currency ?? base, daily })
      }
    }
  }

  const total = combineDailySpend(
    tiles
      .filter((t) => t.state === 'connected' && t.daily?.length)
      .map((t) => convertDaily(t.daily ?? [], t.currency ?? base, base, fx))
  )

  if (total.length) {
    series.push({ pluginId: TOTAL_ID, facet: 'spend', currency: base, daily: total })
  }

  return series
}

const broadcast = (): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC_EVENT.notificationsChanged)
  }
}

// Read the current state of the world, run both evaluators, merge into the stored list, broadcast. Best-effort.
export const evaluateAlerts = async (): Promise<void> => {
  try {
    const [tiles, fx, config] = await Promise.all([buildOverview(), getFxConfig(), getAlertConfig()])
    const series = await buildAlertSeries(tiles, fx)
    const now = new Date()
    const change = evaluateChangeAlerts(series, config.change, now)
    const health = config.health.fxMissing ? evaluateHealthChecks(tiles, fx) : []
    const merged = mergeNotifications(await readNotifications(), [...change, ...health], now.toISOString())

    await writeNotifications(merged)
    broadcast()
  } catch (err) {
    log.error(`alert evaluation failed: ${(err as Error).message}`)
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

// Coalesce a burst of capability runs (a refresh-all batch) into one evaluation after the batch settles.
export const scheduleAlertEvaluation = (): void => {
  if (timer) {
    clearTimeout(timer)
  }

  timer = setTimeout(() => {
    timer = null
    void evaluateAlerts()
  }, DEBOUNCE_MS)
}
