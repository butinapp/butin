import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { recordFixture, tableFixture } from '../../test/datasets.js'

// echarts needs a real layout box + ResizeObserver, neither of which jsdom provides; the chart canvas is not
// what these tests assert, so stub it to a marker div and let the surrounding view chrome render.
vi.mock('../../components/echart.js', () => ({ EChart: () => <div data-testid="chart" /> }))

import { type TableFilesBridge, DashboardRenderer } from './dashboard-renderer.js'

const account = recordFixture('account', [{ key: 'plan', label: 'Plan', role: 'label' }], { plan: 'Pro' })
const invoices = tableFixture('invoices', [{ key: 'email', label: 'Email', role: 'identifier' }], [{ email: 'a@b.c' }])

test('renders a stat view from a record dataset', () => {
  render(<DashboardRenderer result={{ datasets: [account], views: [{ type: 'stat', dataset: 'account' }] }} />)

  expect(screen.getByText('Plan')).toBeInTheDocument()
  expect(screen.getByText('Pro')).toBeInTheDocument()
})

test('renders a table view with its column header and rows', () => {
  render(<DashboardRenderer result={{ datasets: [invoices], views: [{ type: 'table', dataset: 'invoices' }] }} />)

  expect(screen.getByText('Email')).toBeInTheDocument()
  expect(screen.getByText('a@b.c')).toBeInTheDocument()
})

test('expands a row into its joined child rows via a table detail binding', () => {
  const members = tableFixture(
    'members',
    [{ key: 'who', label: 'Member', role: 'label' }],
    [
      { who: 'alice', creatorId: 'u1' },
      { who: 'bob', creatorId: 'u2' }
    ],
    'creatorId'
  )
  const keys = tableFixture(
    'keys',
    [
      { key: 'name', label: 'Key name', role: 'label' },
      { key: 'creatorId', role: 'identifier', hidden: true }
    ],
    [
      { name: 'alice-prod', creatorId: 'u1' },
      { name: 'bob-ci', creatorId: 'u2' }
    ],
    'name'
  )

  render(
    <DashboardRenderer
      result={{
        datasets: [members, keys],
        views: [{ type: 'table', dataset: 'members', detail: { dataset: 'keys', on: 'creatorId' } }]
      }}
    />
  )

  // Collapsed: no child rows shown yet.
  expect(screen.queryByText('alice-prod')).toBeNull()

  // Expanding alice's row reveals only her key, not bob's.
  fireEvent.click(screen.getAllByLabelText('Toggle row details')[0]!)
  expect(screen.getByText('alice-prod')).toBeInTheDocument()
  expect(screen.queryByText('bob-ci')).toBeNull()
})

test('synthesizes a default stat view when result.views is absent', () => {
  render(<DashboardRenderer result={{ datasets: [account] }} />)

  expect(screen.getByText('Pro')).toBeInTheDocument()
})

test('renders nothing for an empty result without crashing', () => {
  const { container } = render(<DashboardRenderer result={{ datasets: [] }} />)

  expect(container.querySelector('[data-slot="card"]')).toBeNull()
})

test('widens the container for a dense table (>= 6 columns); keeps the narrow cap otherwise', () => {
  const cols = Array.from({ length: 6 }, (_, i) => ({ key: `c${i}`, label: `C${i}`, role: 'text' as const }))
  const big = tableFixture('big', cols, [Object.fromEntries(cols.map((c) => [c.key, 'x']))])

  const { container, rerender } = render(
    <DashboardRenderer result={{ datasets: [big], views: [{ type: 'table', dataset: 'big' }] }} />
  )

  expect(container.firstChild).toHaveClass('max-w-[110rem]')

  rerender(<DashboardRenderer result={{ datasets: [invoices], views: [{ type: 'table', dataset: 'invoices' }] }} />)
  expect(container.firstChild).toHaveClass('max-w-6xl')
})

test('width prop pins the container tier, overriding the content-derived one', () => {
  const slim = { datasets: [invoices], views: [{ type: 'table' as const, dataset: 'invoices' }] }

  // A slim table would auto-derive narrow; `width="wide"` forces the roomy container (constant across tabs).
  const { container, rerender } = render(<DashboardRenderer result={slim} width="wide" />)

  expect(container.firstChild).toHaveClass('max-w-[110rem]')

  const cols = Array.from({ length: 6 }, (_, i) => ({ key: `c${i}`, label: `C${i}`, role: 'text' as const }))
  const big = tableFixture('big', cols, [Object.fromEntries(cols.map((c) => [c.key, 'x']))])

  // And a dense table forced narrow stays capped.
  rerender(
    <DashboardRenderer result={{ datasets: [big], views: [{ type: 'table', dataset: 'big' }] }} width="narrow" />
  )
  expect(container.firstChild).toHaveClass('max-w-6xl')
})

test("width='full' drops the cap so the table reaches both edges", () => {
  const { container } = render(
    <DashboardRenderer
      result={{ datasets: [invoices], views: [{ type: 'table', dataset: 'invoices' }] }}
      width="full"
    />
  )

  expect(container.firstChild).not.toHaveClass('max-w-[110rem]')
  expect(container.firstChild).not.toHaveClass('max-w-6xl')
})

test("search='always' pins an open search field above the table", () => {
  const { rerender } = render(
    <DashboardRenderer
      result={{ datasets: [invoices], views: [{ type: 'table', dataset: 'invoices', title: 'People' }] }}
      search="always"
    />
  )

  expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument()

  rerender(
    <DashboardRenderer
      result={{ datasets: [invoices], views: [{ type: 'table', dataset: 'invoices', title: 'People' }] }}
    />
  )
  expect(screen.queryByPlaceholderText('Search…')).not.toBeInTheDocument()
})

test('a timestamp cell renders in the date preset, not as the raw stored value', () => {
  const stamped = tableFixture(
    'runs',
    [
      { key: 'service', label: 'Service', role: 'label' },
      { key: 'asOf', label: 'As of', role: 'timestamp' }
    ],
    [
      { service: 'Sentry', asOf: '2026-09-10T10:41:35.618Z' },
      { service: 'AWS', asOf: '2026-09-09' }
    ]
  )

  render(<DashboardRenderer result={{ datasets: [stamped], views: [{ type: 'table', dataset: 'runs' }] }} />)

  expect(screen.queryByText('2026-09-10T10:41:35.618Z')).not.toBeInTheDocument()
  expect(screen.getByText('Sep 9, 2026')).toBeInTheDocument()
})

test('a timestamp inside an expanded row detail is formatted too', () => {
  const people = tableFixture(
    'people',
    [{ key: 'name', label: 'Name', role: 'label' }],
    [{ name: 'Yann', personId: 'p1' }],
    'personId'
  )
  const access = tableFixture(
    'access',
    [
      { key: 'service', label: 'Service', role: 'label' },
      { key: 'asOf', label: 'As of', role: 'timestamp' },
      { key: 'personId', role: 'identifier', hidden: true }
    ],
    [{ service: 'Sentry', asOf: '2026-09-10', personId: 'p1' }]
  )

  render(
    <DashboardRenderer
      result={{
        datasets: [people, access],
        views: [{ type: 'table', dataset: 'people', detail: { dataset: 'access', on: 'personId' } }]
      }}
    />
  )

  fireEvent.click(screen.getByText('Yann'))

  expect(screen.getByText('Sep 10, 2026')).toBeInTheDocument()
  expect(screen.queryByText('2026-09-10')).not.toBeInTheDocument()
})

test('short scalar columns get noWrap; free-text columns wrap', () => {
  const svc = tableFixture(
    'svc',
    [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'desc', label: 'Service', role: 'text' }
    ],
    [{ date: '2020-02-26', desc: 'Visite, examen ou consultation' }]
  )
  const { container } = render(
    <DashboardRenderer result={{ datasets: [svc], views: [{ type: 'table', dataset: 'svc' }] }} />
  )

  // exactly one body cell stays on one line — the timestamp, not the free text.
  expect(container.querySelectorAll('td.whitespace-nowrap').length).toBe(1)
})

test('name (label) and enum (category) columns stay on one line, not wrapped to min-content', () => {
  const svc = tableFixture(
    'svc',
    [
      { key: 'holder', label: 'Holder', role: 'label' },
      { key: 'kind', label: 'Kind', role: 'category' },
      { key: 'note', label: 'Note', role: 'text' }
    ],
    [{ holder: 'Alex Tremblay / Sam Gagnon', kind: 'propane', note: 'a long free-text note that may wrap' }]
  )
  const { container } = render(
    <DashboardRenderer result={{ datasets: [svc], views: [{ type: 'table', dataset: 'svc' }] }} />
  )

  // holder + kind stay single-line; only the free-text note wraps.
  expect(container.querySelectorAll('td.whitespace-nowrap').length).toBe(2)
})

test('a status column auto-tones from the lexicon, with a badges entry overriding', () => {
  const invoices = tableFixture(
    'invoices',
    [{ key: 'status', label: 'Status', role: 'status', badges: { trialing: 'warning' } }],
    [{ status: 'paid' }, { status: 'failed' }, { status: 'trialing' }]
  )

  render(<DashboardRenderer result={{ datasets: [invoices], views: [{ type: 'table', dataset: 'invoices' }] }} />)

  // labels are title-cased; tones come from the built-in lexicon, except 'trialing' which the map overrides.
  expect(screen.getByText('Paid')).toHaveClass('bg-emerald-500/15') // lexicon → success
  expect(screen.getByText('Failed')).toHaveClass('bg-red-500/15') // lexicon → danger
  expect(screen.getByText('Trialing')).toHaveClass('bg-amber-500/15') // override → warning
})

test('a category column renders a distinct-hue badge with no plugin-declared tone', () => {
  const members = tableFixture('members', [{ key: 'role', label: 'Role', role: 'category' }], [{ role: 'owner' }])

  render(<DashboardRenderer result={{ datasets: [members], views: [{ type: 'table', dataset: 'members' }] }} />)

  const owner = screen.getByText('Owner') // title-cased

  expect(owner).toHaveAttribute('data-slot', 'badge')
})

const Y = new Date().getFullYear()

// A money series spanning two calendar years. The rich TimeseriesChart renders a year picker (labelled
// 'Years') in monthly mode, so that control is the DOM marker the tests assert on (the echarts canvas is mocked).
const monthlyMoney = tableFixture(
  'spend',
  [
    { key: 'month', label: 'Month', role: 'timestamp' },
    { key: 'amount', label: 'Amount', role: 'money' }
  ],
  [
    { month: `${Y - 1}-06`, amount: 10 },
    { month: `${Y}-01`, amount: 20 }
  ]
)

test('a monthly-granularity money series renders the rich chart with a year picker', () => {
  render(
    <DashboardRenderer
      result={{
        datasets: [monthlyMoney],
        views: [{ type: 'timeseries', dataset: 'spend', x: 'month', y: 'amount', granularity: 'monthly' }]
      }}
    />
  )

  expect(screen.getByLabelText('Years')).toBeInTheDocument()
})

test('a daily money series opens Monthly with a Monthly|Daily drill-down toggle', () => {
  const dailySpend = tableFixture(
    'spend',
    [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'value', label: 'Spend', role: 'money', currency: 'USD' }
    ],
    [
      { date: `${Y}-05-31`, value: 3 },
      { date: `${Y}-06-01`, value: 10 },
      { date: `${Y}-06-02`, value: 5 }
    ]
  )

  render(
    <DashboardRenderer
      result={{
        datasets: [dailySpend],
        views: [{ type: 'timeseries', dataset: 'spend', x: 'date', y: 'value', granularity: 'daily' }]
      }}
    />
  )

  // Daily source → the chart aggregates to Monthly by default and exposes the toggle to drill into days.
  expect(screen.getByText('Daily')).toBeInTheDocument()
  expect(screen.getByText('Monthly')).toBeInTheDocument()
})

test('a stat field with max renders a progress bar + denominator; caption + unit show', () => {
  const acct = recordFixture('account', [{ key: 'used', label: 'Usage limit', role: 'money', currency: 'USD' }], {
    used: 10350
  })

  render(
    <DashboardRenderer
      result={{
        datasets: [acct],
        views: [
          {
            type: 'stat',
            dataset: 'account',
            fields: [{ key: 'used', max: 20000, unit: '/mo', caption: '52% of cap' }]
          }
        ]
      }}
    />
  )

  expect(screen.getByText('Usage limit')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
  expect(screen.getByText('52% of cap')).toBeInTheDocument()
  expect(screen.getByText('/mo')).toBeInTheDocument()
  expect(screen.getByText('52%')).toBeInTheDocument()
  expect(screen.getByText('/ $20,000.00')).toBeInTheDocument()
})

test('a keyed cumulative column gets a Trend sparkline column when per-row daily series are provided', () => {
  const members = tableFixture(
    'members',
    [
      { key: 'email', label: 'Member', role: 'label' },
      {
        key: 'spend',
        label: 'Spend (MTD)',
        role: 'money',
        currency: 'USD',
        accrual: 'cumulative',
        resetPeriod: 'monthly'
      }
    ],
    [{ email: 'a@b.c', spend: 40 }],
    'email'
  )
  const result = { datasets: [members], views: [{ type: 'table' as const, dataset: 'members' }] }

  // Without per-row daily data: no Trend column.
  const { container, rerender } = render(<DashboardRenderer result={result} />)

  expect(screen.queryByText('Trend')).not.toBeInTheDocument()

  // With it: a Trend header + a sparkline path for the row whose id (the email key) has a >=2-point series.
  rerender(
    <DashboardRenderer
      result={result}
      rowDaily={{
        members: {
          'a@b.c': [
            { date: '2026-06-14', value: 10 },
            { date: '2026-06-15', value: 30 }
          ]
        }
      }}
    />
  )

  expect(screen.getByText('Trend')).toBeInTheDocument()
  expect(container.querySelector('svg path')).toBeInTheDocument()
})

test('a cumulative-column row expands to its per-day detail, grouped into month sections', () => {
  const members = tableFixture(
    'members',
    [
      { key: 'email', label: 'Member', role: 'label' },
      {
        key: 'spend',
        label: 'Spend (MTD)',
        role: 'money',
        currency: 'USD',
        accrual: 'cumulative',
        resetPeriod: 'monthly'
      }
    ],
    [{ email: 'a@b.c', spend: 40 }],
    'email'
  )
  const result = { datasets: [members], views: [{ type: 'table' as const, dataset: 'members' }] }

  render(
    <DashboardRenderer
      result={result}
      rowDaily={{
        members: {
          'a@b.c': [
            { date: '2026-05-30', value: 4 },
            { date: '2026-06-14', value: 10 },
            { date: '2026-06-15', value: 30 }
          ]
        }
      }}
    />
  )

  // The detail is hidden until the row's chevron is clicked.
  expect(screen.queryByText('Jun 15')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /toggle row details/i }))

  expect(screen.getByText('Per day')).toBeInTheDocument()
  // Every month is a section header (newest first); only the current month is open by default, so its days
  // show while a previous month's days stay collapsed behind its header.
  expect(screen.getByText('June 2026')).toBeInTheDocument()
  expect(screen.getByText('May 2026')).toBeInTheDocument()
  expect(screen.getByText('Jun 15')).toBeInTheDocument()
  expect(screen.getByText('Jun 14')).toBeInTheDocument()
  expect(screen.queryByText('May 30')).not.toBeInTheDocument()

  // Each month expands individually; clicking the collapsed month reveals its days.
  fireEvent.click(screen.getByRole('button', { name: /May 2026/ }))
  expect(screen.getByText('May 30')).toBeInTheDocument()
})

test('a stacked multi-year monthly money series renders the rich chart with a year picker', () => {
  // Long-format seats/usage rows across two calendar years. A stacked series now routes to the rich
  // TimeseriesChart too, so its monthly-mode 'Years' picker appears (the year-spanning marker).
  const ds = tableFixture(
    'byCat',
    [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'category', label: 'Category', role: 'label' },
      { key: 'amount', label: 'Spend', role: 'money', currency: 'USD' }
    ],
    [
      { month: `${Y - 1}-12`, category: 'Seats', amount: 3 },
      { month: `${Y - 1}-12`, category: 'Usage', amount: 12 },
      { month: `${Y}-01`, category: 'Seats', amount: 4 },
      { month: `${Y}-01`, category: 'Usage', amount: 9 }
    ]
  )

  render(
    <DashboardRenderer
      result={{
        datasets: [ds],
        views: [
          {
            type: 'timeseries',
            dataset: 'byCat',
            x: 'month',
            y: 'amount',
            stackBy: 'category',
            granularity: 'monthly',
            title: 'Spend by category'
          }
        ]
      }}
    />
  )

  expect(screen.getByText('Spend by category')).toBeInTheDocument()
  expect(screen.getByTestId('chart')).toBeInTheDocument()
  expect(screen.getByLabelText('Years')).toBeInTheDocument()
})

test('hidden columns are filtered out and new-shape files source.url drives the View action', () => {
  // A table with:
  //   - download_url: hidden url column that folds into the View action via source.url
  //   - internalId:   a second hidden machinery column that is NOT the url column and NOT groupBy
  //     — this one genuinely exercises .filter((c) => !c.hidden); the url column would also be
  //     removed by the downloadable url-hiding path regardless of c.hidden, so it alone is not
  //     a sufficient guard.
  const docs = tableFixture(
    'docs',
    [
      { key: 'title', label: 'Title', role: 'text' as const },
      { key: 'download_url', label: 'URL', role: 'url' as const, hidden: true },
      { key: 'internalId', label: 'InternalID', role: 'identifier' as const, hidden: true }
    ],
    [
      { title: 'Invoice #1', download_url: 'https://example.com/invoice-1.pdf', internalId: 'id-001' },
      { title: 'Invoice #2', download_url: '', internalId: 'id-002' }
    ]
  )

  const bridge: TableFilesBridge = {
    located: {},
    statuses: {},
    selection: new Set(),
    onSelectionChange: () => {},
    onDownload: () => {},
    onOpen: () => {},
    busy: false
  }

  const { container } = render(
    <DashboardRenderer
      result={{
        datasets: [docs],
        views: [
          {
            type: 'table',
            dataset: 'docs',
            files: { name: 'title', source: { url: 'download_url' }, ext: 'pdf' }
          }
        ]
      }}
      downloads={bridge}
    />
  )

  // Both hidden columns must be absent — their labels must not appear anywhere.
  expect(screen.queryByText('URL')).toBeNull()
  // InternalID is the genuine guard: without .filter((c) => !c.hidden) it would render as a column header.
  expect(screen.queryByText('InternalID')).not.toBeInTheDocument()

  // The View action (ExternalLink icon as <a href>) appears exactly once — only row 0 has a non-empty url.
  // Using within(container) scopes the query to the render result and asserts the exact count to catch
  // double-render regressions (toBeGreaterThan(0) would pass even if each row emitted two anchors).
  const links = within(container)
    .queryAllByRole('link')
    .filter((el) => el.getAttribute('href') === 'https://example.com/invoice-1.pdf')

  expect(links).toHaveLength(1)
})
