import { describe, expect, it } from 'vitest'

import {
  byServiceRows,
  combinedDaily,
  combinedMonthly,
  currentMtd,
  monthColumns,
  monthStats,
  movers,
  partition,
  pickHeadline,
  spendBreakdown,
  windowTotal,
  type OverviewPlugin
} from './overview-model.js'

const plugins: OverviewPlugin[] = [
  {
    pluginId: 'a',
    pluginName: 'A',
    monthly: [
      { month: '2026-03', amount: 100 },
      { month: '2026-04', amount: 200 },
      { month: '2026-05', amount: 300 }
    ]
  },
  {
    pluginId: 'b',
    pluginName: 'B',
    monthly: [
      { month: '2026-04', amount: 50 },
      { month: '2026-05', amount: 10 }
    ]
  }
]

describe('combinedMonthly', () => {
  it('unions months and sums amounts', () => {
    expect(combinedMonthly(plugins)).toEqual([
      { month: '2026-03', amount: 100 },
      { month: '2026-04', amount: 250 },
      { month: '2026-05', amount: 310 }
    ])
  })

  it('converts each plugin series to the base currency before summing', () => {
    const mixed: OverviewPlugin[] = [
      { pluginId: 'a', pluginName: 'A', currency: 'USD', monthly: [{ month: '2026-06', amount: 100 }] },
      { pluginId: 'b', pluginName: 'B', currency: 'CAD', monthly: [{ month: '2026-06', amount: 100 }] }
    ]

    expect(combinedMonthly(mixed, 'USD', { CAD: 0.5 }).find((p) => p.month === '2026-06')?.amount).toBeCloseTo(150)
  })

  it('skips a plugin whose currency has no rate', () => {
    const mixed: OverviewPlugin[] = [
      { pluginId: 'a', pluginName: 'A', currency: 'USD', monthly: [{ month: '2026-06', amount: 100 }] },
      { pluginId: 'c', pluginName: 'C', currency: 'CHF', monthly: [{ month: '2026-06', amount: 999 }] }
    ]

    expect(combinedMonthly(mixed, 'USD', { CAD: 0.5 }).find((p) => p.month === '2026-06')?.amount).toBeCloseTo(100)
  })
})

describe('spendBreakdown', () => {
  it('is a single base-currency row (no approximation) for an all-base setup', () => {
    const all: OverviewPlugin[] = [
      { pluginId: 'a', pluginName: 'A', currency: 'USD', monthly: [{ month: '2026-06', amount: 100 }] },
      { pluginId: 'b', pluginName: 'B', currency: 'USD', monthly: [{ month: '2026-06', amount: 50 }] }
    ]
    const out = spendBreakdown(all, '2026-06', 'USD', {})

    expect(out.rows).toEqual([{ currency: 'USD', mtd: 150, convertible: true }])
    expect(out.unconverted).toBe(0)
  })

  it('groups by native currency and flags a missing rate as unconverted', () => {
    const mixed: OverviewPlugin[] = [
      { pluginId: 'a', pluginName: 'A', currency: 'USD', monthly: [{ month: '2026-06', amount: 100 }] },
      { pluginId: 'b', pluginName: 'B', currency: 'CAD', monthly: [{ month: '2026-06', amount: 80 }] },
      { pluginId: 'c', pluginName: 'C', currency: 'CHF', monthly: [{ month: '2026-06', amount: 5 }] }
    ]
    const out = spendBreakdown(mixed, '2026-06', 'USD', { CAD: 0.73 })

    expect(out.rows).toEqual(
      expect.arrayContaining([
        { currency: 'USD', mtd: 100, convertible: true },
        { currency: 'CAD', mtd: 80, convertible: true },
        { currency: 'CHF', mtd: 5, convertible: false }
      ])
    )
    expect(out.unconverted).toBe(1)
  })
})

describe('byServiceRows currency', () => {
  it('reports each service total in the base currency', () => {
    const mixed: OverviewPlugin[] = [
      { pluginId: 'b', pluginName: 'B', currency: 'CAD', monthly: [{ month: '2026-05', amount: 100 }] }
    ]
    const row = byServiceRows(mixed, '2026-06', 'USD', { CAD: 0.5 })[0]!

    expect(row.total).toBeCloseTo(50)
    expect(row.lastMo).toBeCloseTo(50)
  })
})

describe('combinedDaily', () => {
  it('sums each service per-day series and ORs the estimated flag', () => {
    const result = combinedDaily([
      {
        pluginId: 'a',
        pluginName: 'A',
        daily: [
          { date: '2026-06-12', value: 4 },
          { date: '2026-06-13', value: 7, estimated: true }
        ]
      },
      {
        pluginId: 'b',
        pluginName: 'B',
        daily: [
          { date: '2026-06-12', value: 1 },
          { date: '2026-06-13', value: 2 }
        ]
      }
    ])

    expect(result).toEqual([
      { date: '2026-06-12', value: 5 },
      { date: '2026-06-13', value: 9, estimated: true }
    ])
  })

  it('is empty when no plugin has captured snapshots', () => {
    expect(combinedDaily(plugins)).toEqual([])
  })
})

describe('monthStats', () => {
  it('computes last full month and run-rate from completed months (nowMonth excluded from "full")', () => {
    const s = monthStats(plugins, '2026-05')

    expect(s.mtd).toBe(310) // 2026-05 = current month-to-date (series fallback: no spend summaries)
    expect(s.lastFullMonth).toBe(250) // 2026-04
    expect(s.annualizedRunRate).toBe(((100 + 250) / 2) * 12) // avg of completed months (03,04) × 12
  })
})

// An arrears-billed service (Anthropic, Sentry) reports its live open-period spend via the spend.mtd summary
// value, but its invoice series has no current-month bar yet. "This month" must read the summary value so the
// Overview matches what the service's own page headlines, instead of reading 0 off the series.
describe('current-month spend from the summary value', () => {
  const arrears: OverviewPlugin[] = [
    {
      pluginId: 'anthropic',
      pluginName: 'Anthropic',
      currency: 'USD',
      monthly: [
        { month: '2026-04', amount: 200 },
        { month: '2026-05', amount: 300 }
      ],
      summaries: [{ section: 'spend', label: 'This month', value: 575, role: 'money', currency: 'USD' }]
    }
  ]

  it('byServiceRows reads THIS MO from the summary value, not the empty current-month bar', () => {
    const row = byServiceRows(arrears, '2026-06')[0]!

    expect(row.mtd).toBe(575) // open-period spend, even though 2026-06 has no invoice
    expect(row.lastMo).toBe(300) // last completed month still comes from the series
  })

  it('monthStats sums each service current-month spend from its summary', () => {
    expect(monthStats(arrears, '2026-06').mtd).toBe(575)
  })

  it('converts the native summary value into the base currency', () => {
    const cad: OverviewPlugin[] = [
      {
        pluginId: 'x',
        pluginName: 'X',
        currency: 'CAD',
        summaries: [{ section: 'spend', label: 'm', value: 100, role: 'money', currency: 'CAD' }]
      }
    ]

    expect(byServiceRows(cad, '2026-06', 'USD', { CAD: 0.5 })[0]!.mtd).toBeCloseTo(50)
  })
})

// THIS MO reads the current LOCAL month's bar from the service's own per-month series (what its chart shows for
// this month), so it rolls at the user's local midnight — NOT when a provider resets its billing period on a
// different clock. A provider open-period scalar is used only when the service has no bar for this month yet.
describe('current-month spend from the per-month bar', () => {
  it('reads the current-month bar in preference to a provider open-period scalar', () => {
    const p: OverviewPlugin = {
      pluginId: 'baseten',
      pluginName: 'Baseten',
      currency: 'USD',
      monthly: [
        { month: '2026-05', amount: 5652 },
        { month: '2026-06', amount: 8100 }
      ],
      // The provider period reset early (UTC month), so the scalar is a tiny post-reset figure; the June bar wins.
      summaries: [{ section: 'spend', label: 'Current period', value: 24.75, role: 'money', currency: 'USD' }]
    }

    expect(currentMtd(p, '2026-06')).toBe(8100)
    expect(byServiceRows([p], '2026-06')[0]!.mtd).toBe(8100)
  })

  it('reads a bar even when it is 0, so an explicit no-spend month does not fall through to the scalar', () => {
    const p: OverviewPlugin = {
      pluginId: 'x',
      pluginName: 'X',
      currency: 'USD',
      monthly: [{ month: '2026-06', amount: 0 }],
      summaries: [{ section: 'spend', label: 'Current period', value: 24.75, role: 'money', currency: 'USD' }]
    }

    expect(currentMtd(p, '2026-06')).toBe(0)
  })

  it('uses the captured month peak over a reset scalar when there is no current-month bar (arrears)', () => {
    const p: OverviewPlugin = {
      pluginId: 'anthropic',
      pluginName: 'Anthropic',
      currency: 'USD',
      monthly: [{ month: '2026-05', amount: 104051 }], // May posted; no June invoice yet
      // Captured June climbing to ~72k before the provider reset its open period to July.
      currentMonthAccrual: 71966,
      // The live scalar has already reset for the new (July) period.
      summaries: [{ section: 'spend', label: 'This month', value: 71.94, role: 'money', currency: 'USD' }]
    }

    expect(currentMtd(p, '2026-06')).toBe(71966)
  })

  it('falls back to the summary scalar when nothing was captured this month', () => {
    const p: OverviewPlugin = {
      pluginId: 'anthropic',
      pluginName: 'Anthropic',
      currency: 'USD',
      monthly: [{ month: '2026-05', amount: 300 }], // last month only, no current-month invoice yet
      summaries: [{ section: 'spend', label: 'This month', value: 575, role: 'money', currency: 'USD' }]
    }

    expect(currentMtd(p, '2026-06')).toBe(575)
  })

  it('converts the captured peak into the base currency', () => {
    const p: OverviewPlugin = {
      pluginId: 'x',
      pluginName: 'X',
      currency: 'CAD',
      currentMonthAccrual: 100
    }

    expect(currentMtd(p, '2026-06', 'USD', { CAD: 0.5 })).toBeCloseTo(50)
  })
})

describe('movers', () => {
  it('ranks per-plugin deltas between two months', () => {
    const m = movers(plugins, '2026-04', '2026-05')

    expect(m.increases[0]).toMatchObject({ pluginId: 'a', delta: 100 })
    expect(m.drops[0]).toMatchObject({ pluginId: 'b', delta: -40 })
  })
})

describe('byServiceRows', () => {
  it('builds a row per plugin with mtd/lastMo/momPct/total', () => {
    const rows = byServiceRows(plugins, '2026-05')
    const a = rows.find((r) => r.pluginId === 'a')!

    expect(a.mtd).toBe(300)
    expect(a.lastMo).toBe(200)
    // MoM Δ = last completed month vs the month before it: 2026-04 (200, lastMo) vs 2026-03 (100, prevMo) = +100%.
    expect(a.prevMo).toBe(100)
    expect(a.momPct).toBe(100)
    expect(a.total).toBe(600)
    expect(a.spark).toEqual([100, 200, 300])
    expect(a.byMonth).toEqual({ '2026-03': 100, '2026-04': 200, '2026-05': 300 })
  })

  // The store's keyed-table accumulation preserves INSERTION order, so a month first captured in a later fetch
  // lands at the end of the array (not in month order). prevMo/spark read the series by month, not array position.
  it('reads prevMo and spark chronologically from an unsorted monthly series', () => {
    const unsorted: OverviewPlugin[] = [
      {
        pluginId: 'clickhouse',
        pluginName: 'ClickHouse',
        currency: 'USD',
        monthly: [
          { month: '2026-04', amount: 661.2 },
          { month: '2026-05', amount: 1329.69 },
          { month: '2026-06', amount: 1453.44 },
          { month: '2025-09', amount: 0 } // first seen in a later fetch → appended last on disk
        ],
        summaries: [{ section: 'spend', label: 'This period', value: 1453.44, role: 'money', currency: 'USD' }]
      }
    ]
    const row = byServiceRows(unsorted, '2026-07')[0]!

    expect(row.lastMo).toBe(1453.44) // 2026-06
    expect(row.prevMo).toBe(1329.69) // 2026-05 — NOT the array-last 2025-09 (0)
    expect(row.momPct).toBe(9) // (1453.44 − 1329.69) / 1329.69 ≈ +9%
    expect(row.spark).toEqual([0, 661.2, 1329.69, 1453.44]) // month order, not array order
  })
})

describe('windowTotal', () => {
  it('sums only the displayed months, reading the current month from mtd', () => {
    const row = byServiceRows(plugins, '2026-05').find((r) => r.pluginId === 'a')!

    // a.byMonth = {03:100, 04:200, 05:300}; mtd(05) = 300; all-time total = 600.
    // Displayed [05, 04] → mtd(300) + byMonth[04](200) = 500 (≠ the 600 all-time).
    expect(windowTotal(row, ['2026-05', '2026-04'], '2026-05')).toBe(500)
    // A displayed month with no data contributes 0.
    expect(windowTotal(row, ['2026-05', '2026-01'], '2026-05')).toBe(300)
  })
})

describe('monthColumns', () => {
  it('returns older completed months newest-first, excluding nowMonth and the last completed month', () => {
    // completed < 2026-06 = [03, 04, 05]; drop the last completed (05 = "Last mo"), reverse → [04, 03].
    expect(monthColumns(plugins, '2026-06')).toEqual(['2026-04', '2026-03'])
  })

  it('caps the column count at `max`', () => {
    expect(monthColumns(plugins, '2026-06', 1)).toEqual(['2026-04'])
  })

  it('is empty when there is one or fewer completed months', () => {
    expect(monthColumns(plugins, '2026-04')).toEqual([])
  })
})

const bank: OverviewPlugin = {
  pluginId: 'bank',
  pluginName: 'Bank',
  summaries: [
    { section: 'spend', label: 'Card', value: 100, role: 'money', currency: 'CAD' },
    { section: 'balance', label: 'Net', value: 5000, role: 'money', currency: 'CAD' }
  ]
}

describe('partition', () => {
  it('places a service in each monetary section it reports; Others only when it has neither', () => {
    const p = partition([bank])

    expect(p.spend.map((x) => x.pluginId)).toContain('bank')
    expect(p.balances.map((x) => x.pluginId)).toContain('bank')
    expect(p.others).toHaveLength(0)
  })

  it('keeps a billing service that also reports a usage-cost out of Others', () => {
    const billed: OverviewPlugin = {
      pluginId: 'claude',
      pluginName: 'Claude',
      summaries: [
        { section: 'spend', label: 'This month', value: 100, role: 'money', currency: 'USD' },
        { section: 'other', label: 'On-demand', value: 20, role: 'money', currency: 'USD' }
      ]
    }
    const p = partition([billed])

    expect(p.spend.map((x) => x.pluginId)).toEqual(['claude'])
    expect(p.others).toHaveLength(0)
  })

  it('puts a usage/count-only service in others, with no summaries in none', () => {
    const p = partition([
      {
        pluginId: 'carnet',
        pluginName: 'Carnet',
        summaries: [{ section: 'other', label: 'Items', value: 412, role: 'count' }]
      }
    ])

    expect(p.others.map((x) => x.pluginId)).toEqual(['carnet'])
    expect(p.spend).toHaveLength(0)
    expect(p.balances).toHaveLength(0)
  })
})

describe('pickHeadline', () => {
  it('prefers spend over balance over other', () => {
    expect(pickHeadline(bank)?.section).toBe('spend')
  })

  it('honors an explicit headline override', () => {
    const p: OverviewPlugin = {
      ...bank,
      summaries: [
        { section: 'spend', label: 'Card', value: 100, role: 'money', currency: 'CAD' },
        { section: 'balance', label: 'Net', value: 5000, role: 'money', currency: 'CAD', headline: true }
      ]
    }

    expect(pickHeadline(p)?.section).toBe('balance')
  })
})
