import { describe, expect, it } from 'vitest'

import { capabilityResult, record, table } from './builders.js'
import type { Column } from './dataset.js'
import { CapabilityResultSchema, validateCapabilityResult } from './result.js'

interface InvoiceRow {
  date: string | null
  amount: number
  status: string
  receiptUrl: string | null
  name: string
}

describe('table', () => {
  it('emits a wire table dataset and a table view bound to it', () => {
    const invoices = table<InvoiceRow>({
      id: 'invoices',
      columns: [
        { key: 'date', role: 'timestamp', label: 'Date' },
        { key: 'amount', role: 'money', currency: 'USD', label: 'Amount' },
        { key: 'status', role: 'status', label: 'Status' },
        { key: 'receiptUrl', role: 'url', label: 'Receipt' },
        { key: 'name', role: 'label', hidden: true }
      ],
      rows: [{ date: '2026-05-01', amount: 10, status: 'paid', receiptUrl: 'https://x/r.pdf', name: 'Invoice' }]
    })

    expect(invoices.dataset.shape).toBe('table')
    expect(invoices.dataset.columns.find((c) => c.key === 'name')?.hidden).toBe(true)

    const section = invoices.fileTable({ title: 'Invoices', name: 'name', source: { url: 'receiptUrl' }, ext: 'pdf' })

    expect(section.view).toEqual({
      type: 'table',
      dataset: 'invoices',
      title: 'Invoices',
      files: { name: 'name', source: { url: 'receiptUrl' }, ext: 'pdf' }
    })
  })

  it('fileTable round-trip: new files shape validates and survives CapabilityResultSchema.parse', () => {
    const invoices = table<{ receiptUrl: string | null; name: string; amount: number }>({
      id: 'invoices-rt',
      columns: [
        { key: 'amount', role: 'money', currency: 'USD', label: 'Amount' },
        { key: 'receiptUrl', role: 'url', label: 'Receipt' },
        { key: 'name', role: 'label', hidden: true }
      ],
      rows: [{ receiptUrl: 'https://x/r.pdf', name: 'Invoice Jan', amount: 10 }]
    })
    const section = invoices.fileTable({
      title: 'Invoices',
      name: 'name',
      source: { url: 'receiptUrl' },
      ext: 'pdf',
      category: 'Invoices'
    })
    const result = capabilityResult({ sections: [section] })

    expect(validateCapabilityResult(result)).toEqual([])

    const parsed = CapabilityResultSchema.parse(result)
    const view = parsed.views?.[0]

    if (!view || view.type !== 'table') {
      throw new Error('expected table view')
    }

    expect(view.files?.name).toBe('name')
    expect(view.files?.source).toEqual({ url: 'receiptUrl' })
    expect(view.files?.ext).toBe('pdf')
    expect(view.files?.category).toBe('Invoices')
  })
})

describe('capabilityResult', () => {
  it('collects + de-dupes datasets from sections and drops falsy ones', () => {
    const account = record<{ currentMtd: number | null; plan: string | null }>({
      id: 'account',
      fields: [
        { key: 'currentMtd', role: 'money', currency: 'USD', label: 'This month' },
        { key: 'plan', role: 'label', label: 'Plan' }
      ],
      value: { currentMtd: 10, plan: 'Pro' }
    })
    const monthly = table<{ month: string; amount: number }>({
      id: 'monthly',
      columns: [
        { key: 'month', role: 'timestamp', label: 'Month' },
        { key: 'amount', role: 'money', currency: 'USD', label: 'Spend' }
      ],
      rows: [{ month: '2026-05', amount: 10 }],
      key: 'month'
    })

    const result = capabilityResult({
      sections: [
        account.stat(),
        monthly.timeseries({ x: 'month', y: 'amount', title: 'Monthly spend' }),
        false,
        undefined
      ],
      summaries: [
        monthly.summary({
          section: 'spend',
          label: 'This month',
          value: 10,
          currency: 'USD',
          x: 'month',
          y: 'amount'
        })
      ]
    })

    expect(result.datasets.map((d) => d.id)).toEqual(['account', 'monthly'])
    expect(result.views?.map((v) => v.type)).toEqual(['stat', 'timeseries'])
    expect(result.summaries?.[0]?.spark).toEqual({ dataset: 'monthly', x: 'month', y: 'amount' })
    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('rejects a wrong role / unknown key at compile time', () => {
    table<{ amount: number }>({
      id: 't',
      columns: [
        // @ts-expect-error number field cannot be a 'status' role
        { key: 'amount', role: 'status' }
      ],
      rows: [{ amount: 1 }]
    })
    table<{ amount: number }>({
      id: 't2',
      // @ts-expect-error 'amont' is not a key of the row
      columns: [{ key: 'amont', role: 'money' }],
      rows: [{ amount: 1 }]
    })
  })

  it('label-less hidden column validates', () => {
    const t = table<{ name: string; amount: number }>({
      id: 'items',
      columns: [
        { key: 'amount', role: 'money', currency: 'USD', label: 'Amount' },
        { key: 'name', role: 'label', hidden: true }
      ],
      rows: [{ name: 'Widget', amount: 42 }]
    })
    const result = capabilityResult({ sections: [t.table({ title: 'X' })] })

    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('dedup first-wins across two handles with the same dataset id', () => {
    const a = table<{ month: string; amount: number }>({
      id: 'shared',
      columns: [
        { key: 'month', role: 'timestamp', label: 'Month' },
        { key: 'amount', role: 'money', label: 'A' }
      ],
      rows: [{ month: '2026-01', amount: 1 }]
    })
    const b = table<{ month: string; amount: number }>({
      id: 'shared',
      columns: [
        { key: 'month', role: 'timestamp', label: 'Month' },
        { key: 'amount', role: 'money', label: 'B' }
      ],
      rows: [
        { month: '2026-02', amount: 2 },
        { month: '2026-03', amount: 3 }
      ]
    })
    const result = capabilityResult({ sections: [a.table({ title: 'A' }), b.table({ title: 'B' })] })

    expect(result.datasets).toHaveLength(1)
    // first-wins: dataset from handle `a` (1 row, column label 'A') is kept
    const ds = result.datasets[0]

    if (ds.shape !== 'table') {
      throw new Error('expected table shape')
    }

    expect(ds.rows).toHaveLength(1)
    expect(ds.columns.find((c) => c.key === 'amount')?.label).toBe('A')
  })

  it('a table detail binding emits the view.detail + ships the child dataset via extraDatasets', () => {
    const keys = table<{ id: string; creatorId: string; name: string }>({
      id: 'keys',
      columns: [
        { key: 'name', role: 'label', label: 'Name' },
        { key: 'creatorId', role: 'identifier', hidden: true }
      ],
      rows: [{ id: 'k1', creatorId: 'u1', name: 'prod' }],
      key: 'id'
    })
    const members = table<{ creatorId: string; who: string }>({
      id: 'members',
      columns: [
        { key: 'who', role: 'label', label: 'Member' },
        { key: 'creatorId', role: 'identifier', hidden: true }
      ],
      rows: [{ creatorId: 'u1', who: 'alice' }],
      key: 'creatorId'
    })
    const section = members.table({ title: 'Members', detail: { rows: keys, on: 'creatorId' } })

    expect(section.view).toMatchObject({ type: 'table', detail: { dataset: 'keys', on: 'creatorId' } })
    expect(section.extraDatasets?.map((d) => d.id)).toEqual(['keys'])

    const result = capabilityResult({ sections: [section] })

    expect(result.datasets.map((d) => d.id)).toEqual(['members', 'keys'])
    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('record keyvalue view shape and validates', () => {
    const r = record<{ plan: string; seats: number }>({
      id: 'acct',
      fields: [
        { key: 'plan', role: 'label', label: 'Plan' },
        { key: 'seats', role: 'count', label: 'Seats' }
      ],
      value: { plan: 'Pro', seats: 5 }
    })
    const section = r.keyvalue({ title: 'Account' })

    expect(section.view).toEqual({ type: 'keyvalue', dataset: 'acct', title: 'Account' })
    const result = capabilityResult({ sections: [section] })

    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('record.fromColumns builds a valid record from a runtime-assembled Column[] (no cast)', () => {
    const fields: Column[] = [{ key: 'currentMtd', role: 'money', currency: 'USD', label: 'This month' }]
    const value: Record<string, unknown> = { currentMtd: 12.5 }

    // The dynamic shape a preset uses: push optional fields, then build without a per-row generic.
    fields.push({ key: 'plan', role: 'label', label: 'Plan' })
    value.plan = 'Pro'

    const r = record.fromColumns({ id: 'account', fields, value })
    const result = capabilityResult({ sections: [r.stat()] })

    expect(result.datasets[0]?.id).toBe('account')
    expect(result.views?.[0]).toEqual({ type: 'stat', dataset: 'account' })
    expect(validateCapabilityResult(result)).toEqual([])
  })
})
