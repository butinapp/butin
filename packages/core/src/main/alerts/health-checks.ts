import { convert } from '@butinapp/sdk/util'

import type { NotificationDraft, OverviewTileDto } from '../../shared/ipc.js'
import type { FxConfig } from '../store/fx-rates.js'

// A tile that feeds the spend/usage rollups (so a missing rate actually skews a total).
const contributesToTotals = (t: OverviewTileDto): boolean =>
  (t.summaries ?? []).some((s) => s.role === 'money' && (s.section === 'spend' || s.section === 'other'))

// One warning per connected, total-contributing service whose currency can't convert to base — exactly the
// condition that silently drops it from the cross-service totals.
export const evaluateHealthChecks = (tiles: OverviewTileDto[], fx: FxConfig): NotificationDraft[] => {
  const out: NotificationDraft[] = []

  for (const t of tiles) {
    if (t.state !== 'connected' || !contributesToTotals(t)) {
      continue
    }

    const ccy = t.currency

    if (!ccy || ccy === fx.baseCurrency || convert(1, ccy, fx.baseCurrency, fx.rates) !== null) {
      continue
    }

    out.push({
      id: `health:fx:${t.pluginId}`,
      kind: 'health',
      severity: 'warning',
      pluginId: t.pluginId,
      currency: ccy
    })
  }

  return out
}
