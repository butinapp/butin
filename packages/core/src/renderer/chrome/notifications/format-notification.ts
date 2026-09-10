import type { AlertWindow, NotificationView } from './types.js'

export type NotificationLabels = {
  windowDod: string
  windowWow: string
  windowMom: string
  facetSpend: string
  facetUsage: string
  allServices: string
  up: string
  down: string
  newActivity: string
  fxMissingTitle: string
  fxMissingBody: (currency: string, base: string, service: string) => string
}

export type FormatContext = {
  serviceName: (id?: string) => string
  baseCurrency: string
  money: (n: number, ccy?: string) => string
  pct: (fraction: number) => string
  labels: NotificationLabels
}

const windowLabel = (w: AlertWindow, l: NotificationLabels): string =>
  w === 'dod' ? l.windowDod : w === 'wow' ? l.windowWow : l.windowMom

// Turn a structured notification into a localized title + body, resolving the service name + currency now
// (not at storage time) so renames and locale changes are always reflected.
export const formatNotification = (n: NotificationView, ctx: FormatContext): { title: string; body: string } => {
  const { labels: l } = ctx

  if (n.kind === 'health') {
    return {
      title: l.fxMissingTitle,
      body: l.fxMissingBody(n.currency ?? '?', ctx.baseCurrency, ctx.serviceName(n.pluginId))
    }
  }

  const name = n.pluginId === '__total__' ? l.allServices : ctx.serviceName(n.pluginId)
  const facet = n.facet === 'usage' ? l.facetUsage : l.facetSpend
  const window = windowLabel(n.window ?? 'mom', l)
  const body = `${ctx.money(n.previous ?? 0, n.currency)} → ${ctx.money(n.current ?? 0, n.currency)}`

  if (n.pct === undefined) {
    return { title: `${name} ${l.newActivity} ${facet} ${window}`, body }
  }

  const dir = n.pct >= 0 ? l.up : l.down

  return { title: `${name} ${facet} ${dir} ${ctx.pct(Math.abs(n.pct))} ${window}`, body }
}
