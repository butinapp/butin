import type { Column } from './dataset.js'
import type { CapabilityResult } from './result.js'

// ISO-4217 currency code a plugin denominates in. A strict union (not a bare `string`) so a typo like 'usd'
// fails to compile rather than silently breaking FX — an unknown code converts to null in the Overview rollup
// and drops out of cross-service totals. Extend with the exact uppercase ISO-4217 code as services in new
// currencies are added.
export type CurrencyCode =
  | 'USD'
  | 'CAD'
  | 'EUR'
  | 'GBP'
  | 'AUD'
  | 'NZD'
  | 'JPY'
  | 'CHF'
  | 'CNY'
  | 'INR'
  | 'BRL'
  | 'MXN'
  | 'SEK'
  | 'NOK'
  | 'DKK'
  | 'SGD'
  | 'HKD'
  | 'ZAR'
  | 'PLN'

// Fill the concrete currency onto every money value that did not declare one, so the persisted report is
// self-describing and nothing downstream falls back to a guessed default. A money value's own `currency`
// (a per-value override) always wins; non-money roles are never touched.
const stampColumns = (cols: Column[], reportingCurrency: CurrencyCode): Column[] =>
  cols.map((c) => (c.role === 'money' && !c.currency ? { ...c, currency: reportingCurrency } : c))

export const resolveCurrencies = (result: CapabilityResult, reportingCurrency: CurrencyCode): CapabilityResult => {
  const datasets = result.datasets.map((ds) =>
    ds.shape === 'table'
      ? { ...ds, columns: stampColumns(ds.columns, reportingCurrency) }
      : { ...ds, fields: stampColumns(ds.fields, reportingCurrency) }
  )

  const summaries = result.summaries?.map((s) =>
    s.role === 'money' && !s.currency ? { ...s, currency: reportingCurrency } : s
  )

  return { ...result, datasets, ...(summaries?.length ? { summaries } : {}) }
}
