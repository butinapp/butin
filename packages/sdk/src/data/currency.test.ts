import { describe, expect, it } from 'vitest'

import { resolveCurrencies } from './currency.js'
import { rawRecord, rawTable } from './dataset.js'
import type { CapabilityResult } from './result.js'

const base: CapabilityResult = {
  datasets: [
    rawTable('invoices', [{ key: 'total', label: 'Total', role: 'money' }], [{ total: 12.5 }]),
    rawTable('mixed', [{ key: 'amt', label: 'Amt', role: 'money', currency: 'CHF' }], [{ amt: 3 }]),
    rawRecord('plan', [{ key: 'seats', label: 'Seats', role: 'count' }], { seats: 4 })
  ],
  summaries: [{ section: 'spend', label: 'MTD', value: 12.5, role: 'money' }]
}

describe('resolveCurrencies', () => {
  it('stamps reportingCurrency onto money columns lacking a currency', () => {
    const out = resolveCurrencies(base, 'CAD')
    const invoices = out.datasets[0]
    const col = invoices.shape === 'table' ? invoices.columns[0] : undefined

    expect(col?.currency).toBe('CAD')
  })

  it('leaves an explicit per-value currency untouched', () => {
    const out = resolveCurrencies(base, 'CAD')
    const mixed = out.datasets[1]
    const col = mixed.shape === 'table' ? mixed.columns[0] : undefined

    expect(col?.currency).toBe('CHF')
  })

  it('never stamps a non-money column', () => {
    const out = resolveCurrencies(base, 'CAD')
    const plan = out.datasets[2]
    const field = plan.shape === 'record' ? plan.fields[0] : undefined

    expect(field?.currency).toBeUndefined()
  })

  it('stamps a money summary lacking a currency', () => {
    const out = resolveCurrencies(base, 'CAD')

    expect(out.summaries?.[0]?.currency).toBe('CAD')
  })
})
