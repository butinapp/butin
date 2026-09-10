// @butinapp/ui/dashboard — the embeddable data-view layer: the generic descriptor-driven renderer, the
// cross-service Overview, and the chart/format helpers a host needs to compose its own dashboards. This is
// what an out-of-repo embed (the snapshot viewer) consumes — it carries NO Electron app chrome (see /shell).
export { DashboardRenderer } from './features/dashboard/dashboard-renderer.js'
export type { FileDownloadStatus, TableFilesBridge } from './features/dashboard/dashboard-renderer.js'
export { formatByRole } from './features/dashboard/format-role.js'
export { findCumulativeColumn } from './features/dashboard/view-models.js'
export { TimeseriesChart } from './features/dashboard/timeseries-chart.js'
export type { ChartPoint } from './features/dashboard/view-models.js'
export { Overview } from './features/dashboard/overview.js'
export type { OverviewPlugin } from './features/dashboard/overview-model.js'
export type { RollupTile, RollupBand } from './features/dashboard/rollup.js'

// Downloadable-table file size cell used by the renderer.
export { formatSize } from './features/documents/doc-models.js'

// Chart/format utilities (for hosts composing their own dashboards).
export { formatMoney } from './lib/format.js'
export { useEchartsTheme, grid } from './lib/echarts-theme.js'
