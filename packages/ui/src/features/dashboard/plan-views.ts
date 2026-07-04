import { type CapabilityResult, type Dataset, type View } from '@butinapp/sdk/data'

// Synthesize views for a result that ships none: a record -> stat; a table with a timestamp column and a
// money|count column -> timeseries; every table also gets a table view.
export const defaultViews = (datasets: Dataset[]): View[] => {
  const views: View[] = []

  for (const ds of datasets) {
    if (ds.shape === 'record') {
      views.push({ type: 'stat', dataset: ds.id })
      continue
    }

    const ts = ds.columns.find((c) => c.role === 'timestamp')
    const num = ds.columns.find((c) => c.role === 'money' || c.role === 'count')

    if (ts && num) {
      views.push({ type: 'timeseries', dataset: ds.id, x: ts.key, y: num.key })
    }

    views.push({ type: 'table', dataset: ds.id })
  }

  return views
}

export interface PlannedView {
  view: View
  dataset: Dataset
}

// Resolve each view (explicit, or defaulted) to its dataset, dropping any whose dataset id is unknown.
// The validator already flags dangling refs; the renderer just skips them so one bad view never blanks
// the whole dashboard.
export const planViews = (result: CapabilityResult): PlannedView[] => {
  const byId = new Map(result.datasets.map((d) => [d.id, d] as const))
  const views = result.views ?? defaultViews(result.datasets)

  return views
    .map((view) => ({ view, dataset: byId.get(view.dataset) }))
    .filter((p): p is PlannedView => p.dataset != null)
}
