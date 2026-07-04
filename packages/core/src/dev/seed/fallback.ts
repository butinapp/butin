// A contract-valid CapabilityResult for a capability that declares no `sample`, chosen by the capability-id
// convention (summary/billing/usage/apiKeys/members) so every plugin has demo data before any migration. An
// unknown id gets a generic stat + small table. All values are deterministic from the seed.

import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, members, usage } from '@butinapp/sdk/presets'
import { round2 } from '@butinapp/sdk/util'

import { type Rng, seeded } from './prng.js'

// Twelve trailing months ending 2026-06 — synthetic invoices with a gently rising amount + noise. A fixed
// reference month keeps the seed reproducible (no Date.now).
const fakeInvoices = (rng: Rng): { id: string; date: string; amount: number; status: string }[] => {
  const out: { id: string; date: string; amount: number; status: string }[] = []

  for (let m = 11; m >= 0; m--) {
    const monthsFromJan = 6 - m // 6 = 2026-06, counting back
    const year = 2026 + Math.floor((monthsFromJan - 1) / 12)
    const mm = ((((monthsFromJan - 1) % 12) + 12) % 12) + 1
    const date = `${year}-${String(mm).padStart(2, '0')}-08`

    out.push({
      id: `inv-${date}`,
      date,
      amount: round2(40 + (11 - m) * 4 + rng() * 20),
      status: 'paid'
    })
  }

  return out
}

export const fallbackSnapshot = (capabilityId: string, baseSeed: string): CapabilityResult => {
  const rng = seeded(baseSeed, 'fallback')

  if (capabilityId === 'summary' || capabilityId === 'billing') {
    const invoices = fakeInvoices(rng)

    return billing.summary({
      currentMtd: invoices.at(-1)!.amount,
      mtdBasis: 'invoiced',
      currency: 'USD',
      invoices,
      stats: [{ key: 'invoiceCount', label: 'Invoices', role: 'count', value: invoices.length }]
    })
  }

  if (capabilityId === 'usage') {
    return usage.result({
      metrics: [
        {
          label: 'Requests',
          value: Math.round(10_000 + rng() * 90_000),
          unit: 'req',
          cost: round2(rng() * 50)
        },
        { label: 'Tokens', value: Math.round(1_000_000 + rng() * 5_000_000), unit: 'tok' }
      ]
    })
  }

  if (capabilityId === 'apiKeys') {
    return keys.result({
      keys: [
        { id: 'k1', name: 'production', masked: '…a1b2', createdAt: '2026-01-04T00:00:00.000Z' },
        { id: 'k2', name: 'staging', masked: '…c3d4', createdAt: '2026-03-19T00:00:00.000Z', revoked: rng() > 0.5 }
      ]
    })
  }

  if (capabilityId === 'members') {
    return members.result({
      members: [
        { id: 'm1', name: 'Alex Stone', email: 'alex@example.com', role: 'owner' },
        { id: 'm2', name: 'Robin Lee', email: 'robin@example.com', role: 'member' }
      ]
    })
  }

  // Unknown capability id → a generic single stat + small table, so the tab is non-empty and renders.
  const items = table<{ label: string; value: number }>({
    id: 'items',
    columns: [
      { key: 'label', role: 'label', label: 'Item' },
      { key: 'value', role: 'count', label: 'Value' }
    ],
    rows: [
      { label: 'Alpha', value: Math.round(rng() * 100) },
      { label: 'Beta', value: Math.round(rng() * 100) }
    ]
  })
  const head = record<{ total: number }>({
    id: 'head',
    fields: [{ key: 'total', role: 'count', label: 'Total' }],
    value: { total: 2 }
  })

  return capabilityResult({ sections: [head.stat(), items.table({ title: 'Items' })] })
}
