import { rawRecord, rawTable, type CapabilityResult } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  CATEGORICAL_HUES,
  categoricalTone,
  datasetRowId,
  defaultTableSort,
  findCumulativeColumn,
  groupDailyByMonth,
  latestMonthDaily,
  monthlyAggregate,
  recordRows,
  resolveBadgeTone,
  seriesData,
  stackedSeries,
  statCards,
  tableModel,
  type ChartPoint
} from './view-models.js'

const account = rawRecord(
  'account',
  [
    { key: 'currentMtd', label: 'This month', role: 'money', currency: 'USD' },
    { key: 'plan', label: 'Plan', role: 'label' }
  ],
  { currentMtd: 42.1, plan: 'Pro' }
)

const invoices = rawTable(
  'invoices',
  [
    { key: 'date', label: 'Date', role: 'timestamp' },
    { key: 'amount', label: 'Amount', role: 'money', currency: 'USD' },
    { key: 'pdfUrl', label: 'PDF', role: 'url' }
  ],
  [
    { date: '2026-05-10', amount: 30, pdfUrl: 'https://x/a.pdf' },
    { date: '2026-05-20', amount: 12.1, pdfUrl: null }
  ]
)

test('datasetRowId joins the key parts, matching the ledger row identity', () => {
  expect(datasetRowId({ email: 'a@x.test', tier: 'std' }, 'email')).toBe('a@x.test')
  expect(datasetRowId({ a: 'x', b: 2 }, ['a', 'b'])).toBe('x2')
})

test('datasetRowId is undefined for an unkeyed table or a missing/empty key part', () => {
  expect(datasetRowId({ email: 'a@x.test' }, undefined)).toBeUndefined()
  expect(datasetRowId({ email: '' }, 'email')).toBeUndefined()
  expect(datasetRowId({ tier: 'std' }, 'email')).toBeUndefined()
})

test('defaultTableSort: first timestamp column, descending; undefined when none', () => {
  expect(
    defaultTableSort([
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'paid', label: 'Paid', role: 'timestamp' }
    ])
  ).toEqual({ key: 'date', dir: 'desc' })
  expect(defaultTableSort([{ key: 'name', label: 'Name', role: 'label' }])).toBeUndefined()
  // A hidden timestamp (an accumulation key) is never the default sort target.
  expect(defaultTableSort([{ key: 'createdAt', label: 'Created', role: 'timestamp', hidden: true }])).toBeUndefined()
})

test('findCumulativeColumn locates the first keyed table with a cumulative column', () => {
  const result: CapabilityResult = {
    datasets: [
      rawTable('plain', [{ key: 'x', role: 'count' }], []),
      rawTable(
        'members',
        [
          { key: 'email', role: 'label' },
          { key: 'spend', role: 'money', currency: 'USD', accrual: 'cumulative', resetPeriod: 'monthly' }
        ],
        [],
        'email'
      )
    ]
  }

  expect(findCumulativeColumn(result)).toEqual({ datasetId: 'members', columnKey: 'spend' })
})

test('findCumulativeColumn ignores a cumulative column on an unkeyed table, and returns undefined when none', () => {
  const unkeyed: CapabilityResult = {
    datasets: [rawTable('t', [{ key: 'spend', role: 'money', currency: 'USD', accrual: 'cumulative' }], [])]
  }

  expect(findCumulativeColumn(unkeyed)).toBeUndefined()
  expect(findCumulativeColumn({ datasets: [rawTable('t', [{ key: 'x', role: 'count' }], [], 'x')] })).toBeUndefined()
})

const acct = rawRecord(
  'account',
  [
    { key: 'used', label: 'Usage limit', role: 'money', currency: 'USD' },
    { key: 'seats', label: 'Seats', role: 'count' },
    { key: 'delta', label: 'Δ', role: 'money', currency: 'USD' }
  ],
  { used: 10350, seats: 77, delta: -216.55 }
)

test('statCards: max → denominator + progress + percent; unit/caption/tone pass through', () => {
  const cards = statCards(
    acct,
    [
      { key: 'used', max: 20000, unit: '/mo', caption: '52% of cap' },
      { key: 'seats', max: 104 },
      { key: 'delta', tone: 'positive' }
    ],
    'en-US'
  )

  expect(cards[0]).toMatchObject({
    label: 'Usage limit',
    value: '$10,350.00',
    denominator: '$20,000.00',
    progress: 0.5175,
    percentLabel: '52%',
    unit: '/mo',
    caption: '52% of cap'
  })
  expect(cards[1]).toMatchObject({ value: '77', denominator: '104', percentLabel: '74%' })
  expect(cards[2]).toMatchObject({ value: '-$216.55', tone: 'positive' })
})

test('statCards: a bare string field is value-only (no progress/denominator)', () => {
  const [c] = statCards(acct, ['seats'], 'en-US')

  expect(c).toMatchObject({ key: 'seats', label: 'Seats', value: '77' })
  expect(c!.progress).toBeUndefined()
  expect(c!.denominator).toBeUndefined()
})

test('statCards: undefined fields renders every record field as a bare card', () => {
  expect(statCards(acct, undefined, 'en-US').map((c) => c.key)).toEqual(['used', 'seats', 'delta'])
})

test('statCards: a non-numeric value or max=0 yields no progress bar', () => {
  const ds = rawRecord('r', [{ key: 'plan', label: 'Plan', role: 'label' }], { plan: 'Pro' })

  expect(statCards(ds, [{ key: 'plan', max: 10 }], 'en-US')[0]!.progress).toBeUndefined()
  expect(statCards(acct, [{ key: 'seats', max: 0 }], 'en-US')[0]!.progress).toBeUndefined()
})

test('stackedSeries pivots long rows into per-category series aligned to a sorted x axis', () => {
  const ds = rawTable(
    'm',
    [
      { key: 'month', role: 'timestamp' },
      { key: 'cat', role: 'label' },
      { key: 'amt', role: 'money', currency: 'USD' }
    ],
    [
      { month: '2026-05', cat: 'Seats', amt: 3 },
      { month: '2026-04', cat: 'Seats', amt: 2 },
      { month: '2026-04', cat: 'Usage', amt: 10 },
      { month: '2026-05', cat: 'Usage', amt: 12 }
    ]
  )

  // categories keep first-seen order (Seats then Usage); x sorted ascending; each cell aligned
  expect(stackedSeries(ds, 'month', 'amt', 'cat')).toEqual({
    labels: ['2026-04', '2026-05'],
    series: [
      { name: 'Seats', values: [2, 3] },
      { name: 'Usage', values: [10, 12] }
    ]
  })
})

test('stackedSeries sums duplicate (x, category) cells and fills a missing cell with 0', () => {
  const ds = rawTable(
    'm',
    [
      { key: 'd', role: 'timestamp' },
      { key: 'cat', role: 'label' },
      { key: 'v', role: 'money', currency: 'USD' }
    ],
    [
      { d: '2026-06-01', cat: 'Opus', v: 5 },
      { d: '2026-06-01', cat: 'Opus', v: 2 }, // same cell → summed
      { d: '2026-06-02', cat: 'Sonnet', v: 4 } // Opus absent on 06-02 → 0
    ]
  )

  expect(stackedSeries(ds, 'd', 'v', 'cat')).toEqual({
    labels: ['2026-06-01', '2026-06-02'],
    series: [
      { name: 'Opus', values: [7, 0] },
      { name: 'Sonnet', values: [0, 4] }
    ]
  })
})

test('monthlyAggregate sums daily points into months, ascending', () => {
  const daily: ChartPoint[] = [
    { key: '2026-05-30', value: 3 },
    { key: '2026-06-01', value: 10 },
    { key: '2026-06-02', value: 5 },
    { key: '2026-05-31', value: 2 }
  ]

  expect(monthlyAggregate(daily)).toEqual([
    { key: '2026-05', value: 5 },
    { key: '2026-06', value: 15 }
  ])
})

test('monthlyAggregate keeps one point per (month, category), categories first-seen', () => {
  const daily: ChartPoint[] = [
    { key: '2026-06-01', value: 4, category: 'Sonnet' },
    { key: '2026-06-01', value: 1, category: 'Opus' },
    { key: '2026-06-02', value: 6, category: 'Sonnet' }
  ]

  expect(monthlyAggregate(daily)).toEqual([
    { key: '2026-06', value: 10, category: 'Sonnet' },
    { key: '2026-06', value: 1, category: 'Opus' }
  ])
})

test('groupDailyByMonth: months newest-first, days ascending, with subtotals', () => {
  const series = [
    { date: '2026-05-31', value: 2 },
    { date: '2026-06-02', value: 5 },
    { date: '2026-06-01', value: 10 },
    { date: '2026-05-01', value: 3 }
  ]

  expect(groupDailyByMonth(series)).toEqual([
    {
      month: '2026-06',
      label: 'June 2026',
      subtotal: 15,
      points: [
        { date: '2026-06-01', value: 10 },
        { date: '2026-06-02', value: 5 }
      ]
    },
    {
      month: '2026-05',
      label: 'May 2026',
      subtotal: 5,
      points: [
        { date: '2026-05-01', value: 3 },
        { date: '2026-05-31', value: 2 }
      ]
    }
  ])
})

test('latestMonthDaily: only the newest month, days ascending', () => {
  const series = [
    { date: '2026-05-31', value: 2 },
    { date: '2026-06-02', value: 5 },
    { date: '2026-06-01', value: 10 },
    { date: '2026-05-01', value: 3 }
  ]

  expect(latestMonthDaily(series)).toEqual([
    { date: '2026-06-01', value: 10 },
    { date: '2026-06-02', value: 5 }
  ])
})

test('latestMonthDaily: empty series → empty', () => {
  expect(latestMonthDaily([])).toEqual([])
})

test('recordRows turns a record into formatted label/value rows', () => {
  expect(recordRows(account)).toEqual([
    { label: 'This month', value: '$42.10' },
    { label: 'Plan', value: 'Pro' }
  ])
})

test('recordRows honors a fields filter, in the given order', () => {
  expect(recordRows(account, ['plan'])).toEqual([{ label: 'Plan', value: 'Pro' }])
})

test('tableModel returns header labels and formatted cells', () => {
  const m = tableModel(invoices)

  expect(m.columns).toEqual([
    { key: 'date', label: 'Date' },
    { key: 'amount', label: 'Amount' },
    { key: 'pdfUrl', label: 'PDF' }
  ])
  expect(m.rows[0]).toEqual([
    { text: '2026-05-10' },
    { text: '$30.00' },
    { text: 'https://x/a.pdf', href: 'https://x/a.pdf' }
  ])
})

test('a url cell with no value renders an em dash and no href', () => {
  const m = tableModel(invoices)

  expect(m.rows[1][2]).toEqual({ text: '—' })
})

test('tableModel honors a columns filter, in the given order', () => {
  const m = tableModel(invoices, ['amount', 'date'])

  expect(m.columns).toEqual([
    { key: 'amount', label: 'Amount' },
    { key: 'date', label: 'Date' }
  ])
})

const monthly = rawTable(
  'monthly',
  [
    { key: 'month', label: 'Month', role: 'timestamp' },
    { key: 'amount', label: 'Spend', role: 'money' }
  ],
  [
    { month: '2026-04', amount: 25 },
    { month: '2026-06', amount: 40 }
  ]
)

test('seriesData gap-fills a YYYY-MM x axis to a continuous range', () => {
  const s = seriesData(monthly, 'month', 'amount', '2026-06')

  expect(s.labels).toEqual(['2026-04', '2026-05', '2026-06'])
  expect(s.values).toEqual([25, 0, 40])
})

test('seriesData extends a month axis to nowMonth when later than the last row', () => {
  const s = seriesData(monthly, 'month', 'amount', '2026-07')

  expect(s.labels).toEqual(['2026-04', '2026-05', '2026-06', '2026-07'])
  expect(s.values).toEqual([25, 0, 40, 0])
})

test('seriesData passes non-month x values through in row order', () => {
  const daily = rawTable(
    'daily',
    [
      { key: 'day', label: 'Day', role: 'timestamp' },
      { key: 'n', label: 'N', role: 'count' }
    ],
    [
      { day: '2026-05-10', n: 3 },
      { day: '2026-05-11', n: 5 }
    ]
  )
  const s = seriesData(daily, 'day', 'n')

  expect(s.labels).toEqual(['2026-05-10', '2026-05-11'])
  expect(s.values).toEqual([3, 5])
})

test('resolveBadgeTone: override wins, else the built-in lexicon, else neutral', () => {
  const badges = { active: 'warning', custom: 'danger' } as const

  expect(resolveBadgeTone('active', badges)).toBe('warning') // override beats the lexicon's success
  expect(resolveBadgeTone('Active', badges)).toBe('warning') // case-insensitive
  expect(resolveBadgeTone('custom', badges)).toBe('danger') // override-only value
  expect(resolveBadgeTone('paid', badges)).toBe('success') // not overridden → lexicon
  expect(resolveBadgeTone('failed', undefined)).toBe('danger') // lexicon with no map at all
  expect(resolveBadgeTone('mystery', badges)).toBe('neutral') // in neither
  expect(resolveBadgeTone(null, badges)).toBe('neutral')
  expect(resolveBadgeTone('', badges)).toBe('neutral')
})

test('categoricalTone is stable per value and cycles the hues', () => {
  expect(categoricalTone('owner')).toBe(categoricalTone('owner')) // deterministic
  expect(categoricalTone('Owner')).toBe(categoricalTone('owner')) // case-insensitive
  expect(CATEGORICAL_HUES).toContain(categoricalTone('admin'))
  expect(categoricalTone(null)).toBe(CATEGORICAL_HUES[0]) // empty → first hue
})

test('seriesData on an empty table is empty', () => {
  const empty = rawTable(
    'm',
    [
      { key: 'month', label: 'M', role: 'timestamp' },
      { key: 'a', label: 'A', role: 'money' }
    ],
    []
  )

  expect(seriesData(empty, 'month', 'a')).toEqual({ labels: [], values: [] })
})
