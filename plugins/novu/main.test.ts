import { validateCapabilityResult } from '@butinapp/sdk/data'
import { validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildNovuBilling,
  buildNovuBillingTab,
  buildNovuInvoices,
  buildNovuMembers,
  buildNovuPlan,
  buildNovuSummaryResult,
  buildNovuUsageResult,
  currentMonthInvoiced,
  novuPlugin,
  parseClerkJwt
} from './main.js'

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(novuPlugin)).toEqual([])
})

// Synthetic billing fixture (Stripe amounts in CENTS); ids/values invented.
const invoiceList = {
  has_more: true,
  data: [
    {
      id: 'in_SYNTH1',
      status: 'paid',
      amount_due: 25000,
      total: 25000,
      amount_paid: 25000,
      currency: 'usd',
      effective_at: 1778709014, // 2026-05-13
      finalized_at: 1778709014,
      invoice_pdf: 'https://example.test/invoice/synth1.pdf',
      hosted_invoice_url: 'https://example.test/i/acct_SYNTH/live_a',
      lines: { data: [{ amount: 25000, description: '1 x Plan' }] }
    },
    {
      id: 'in_SYNTH2',
      status: 'open',
      amount_due: 5000,
      currency: 'usd',
      created: 1771020212, // 2026-02-13
      lines: { data: [] }
    }
  ]
}

const subscription = {
  data: {
    apiServiceLevel: 'business',
    isActive: true,
    status: 'active',
    hasPaymentMethod: true,
    currentPeriodStart: '2026-05-13T20:48:57.000Z',
    currentPeriodEnd: '2026-06-13T20:48:57.000Z',
    billingInterval: 'month',
    events: { current: 160000, included: 250000 },
    trial: { isActive: false, start: null, end: null, daysTotal: 0 },
    cancelAt: null
  }
}

test('novu plugin is well-formed', () => {
  expect(novuPlugin.meta.id).toBe('novu')
  expect(novuPlugin.auth.kind).toBe('minted-jwt')
  expect(novuPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
})

// Clerk sets __client (the requiredCookie) before sign-in, so the markers are the only capture gate — they
// must NOT match the entry/sign-in page or the bare host, else capture fires before the security-key step.
test('login markers never match the sign-in page or the bare host (no pre-auth capture)', () => {
  const markers = novuPlugin.session!.dashboardMarkers
  const matches = (url: string) => markers.some((m) => url.includes(m))

  expect(matches(novuPlugin.session!.loginUrl)).toBe(false)
  expect(matches('https://dashboard.novu.co/auth/sign-in')).toBe(false)
  // The classic trap: '/dashboard' matches the 'dashboard.novu.co' host.
  expect(matches('https://dashboard.novu.co/')).toBe(false)
})

test('buildNovuInvoices normalizes cents → USD dollars, unix → ISO day, newest first', () => {
  const invoices = buildNovuInvoices(invoiceList)

  expect(invoices).toEqual([
    {
      date: '2026-05-13',
      amount: 250,
      status: 'paid',
      pdfUrl: 'https://example.test/invoice/synth1.pdf',
      hostedUrl: 'https://example.test/i/acct_SYNTH/live_a'
    },
    {
      date: '2026-02-13',
      amount: 50,
      status: 'open',
      pdfUrl: null,
      hostedUrl: null
    }
  ])
})

test('buildNovuInvoices prefers total over amount_due and falls back to created date', () => {
  const invoices = buildNovuInvoices({
    data: [{ id: 'x', status: 'paid', total: 12345, amount_due: 99999, created: 1771020212, currency: 'usd' }]
  })

  expect(invoices[0]).toMatchObject({ date: '2026-02-13', amount: 123.45 })
})

test('buildNovuInvoices degrades to empty on empty input', () => {
  expect(buildNovuInvoices({})).toEqual([])
  expect(buildNovuInvoices({ data: [] })).toEqual([])
})

test('buildNovuPlan summarizes the subscription (ISO datetimes → UTC days)', () => {
  expect(buildNovuPlan(subscription)).toEqual({
    plan: 'business',
    status: 'active',
    hasPaymentMethod: true,
    billingInterval: 'month',
    currentPeriodStart: '2026-05-13',
    currentPeriodEnd: '2026-06-13',
    trialActive: false,
    cancelAt: undefined
  })
})

test('buildNovuPlan degrades to safe defaults on empty input', () => {
  expect(buildNovuPlan({})).toEqual({
    plan: 'unknown',
    status: 'unknown',
    hasPaymentMethod: false,
    billingInterval: 'month',
    currentPeriodStart: undefined,
    currentPeriodEnd: undefined,
    trialActive: false,
    cancelAt: undefined
  })
})

test('buildNovuSummaryResult is a LEAN summary: monthly chart + headline + spend, NO detail tables', () => {
  const result = buildNovuSummaryResult(buildNovuBilling(invoiceList, subscription))

  expect(validateCapabilityResult(result)).toEqual([])

  // The headline = the latest billed month's invoiced total (May = 250) → a spend summary feeds the Overview.
  expect(result.summaries).toHaveLength(1)
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 250, basis: 'invoiced' })

  // Lean: the only datasets are the headline `account` stat + the `monthly` spark — no `invoices` detail table.
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['account', 'monthly'])

  // The headline stat carries the title-cased plan + invoice-count + status + the latest month's spend.
  const account = result.datasets.find((d) => d.id === 'account')

  if (account?.shape === 'record') {
    expect(account.value.currentMtd).toBe(250)
    expect(account.value.plan).toBe('Business')
    expect(account.value.invoiceCount).toBe(2)
    expect(account.value.status).toBe('active')
  }

  // The monthly-spend spark buckets both invoices by calendar month.
  const monthly = result.datasets.find((d) => d.id === 'monthly')

  if (monthly?.shape === 'table') {
    expect(monthly.rows).toEqual([
      { month: '2026-02', amount: 50 },
      { month: '2026-05', amount: 250 }
    ])
  }
})

test('buildNovuSummaryResult honors an explicit month override', () => {
  // Pin February → its lone invoice (50) is the headline instead of the latest month.
  const result = buildNovuSummaryResult(buildNovuBilling(invoiceList, subscription), '2026-02')

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 50, basis: 'invoiced' })
})

test("currentMonthInvoiced sums the month's invoices, null when none have posted", () => {
  const invoices = buildNovuInvoices(invoiceList)

  expect(currentMonthInvoiced(invoices, '2026-05')).toBe(250)
  expect(currentMonthInvoiced(invoices, '2026-02')).toBe(50)
  expect(currentMonthInvoiced(invoices, '2026-06')).toBeNull()
  expect(currentMonthInvoiced([], '2026-06')).toBeNull()
})

test('buildNovuSummaryResult degrades to no-plan, empty chart on empty input', () => {
  const result = buildNovuSummaryResult(buildNovuBilling({}, {}))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()

  const account = result.datasets.find((d) => d.id === 'account')

  if (account?.shape === 'record') {
    expect(account.value.plan).toBeUndefined() // 'unknown' plan → planLabel undefined → no plan stat added
    expect(account.value.invoiceCount).toBe(0)
  }
})

test('buildNovuBillingTab is the DETAIL: subscription record + downloadable invoices, NO chart, NO spend.mtd', () => {
  const result = buildNovuBillingTab(buildNovuBilling(invoiceList, subscription))

  expect(validateCapabilityResult(result)).toEqual([])

  // The detail datasets — the subscription `account` record + the `invoices` file table. No `monthly` chart.
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['account', 'invoices'])
  expect(result.summaries).toBeUndefined()

  // The subscription record carries the title-cased plan, status, billing interval, period, trial, payment method.
  const account = result.datasets.find((d) => d.id === 'account')

  if (account?.shape === 'record') {
    expect(account.value).toMatchObject({
      plan: 'Business',
      status: 'active',
      billingInterval: 'month',
      period: '2026-05-13 → 2026-06-13',
      trial: 'No',
      paymentMethod: 'On file',
      cancelAt: null
    })
  }

  // The invoices table is a downloadable fileTable (PDF), newest-first, falling back to the hosted URL.
  const invoices = result.datasets.find((d) => d.id === 'invoices')

  if (invoices?.shape === 'table') {
    expect(invoices.rows).toEqual([
      {
        date: '2026-05-13',
        amount: 250,
        status: 'paid',
        pdfUrl: 'https://example.test/invoice/synth1.pdf',
        name: 'Invoice 2026-05-13'
      },
      { date: '2026-02-13', amount: 50, status: 'open', pdfUrl: null, name: 'Invoice 2026-02-13' }
    ])
    // one invoice per billing month → keyed by date so status accumulates in the ledger.
    expect(invoices.key).toBe('date')
  }

  const invoicesView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(invoicesView && 'files' in invoicesView ? invoicesView.files?.ext : undefined).toBe('pdf')
})

test('buildNovuBillingTab drops the invoices section when there are none', () => {
  const result = buildNovuBillingTab(buildNovuBilling({}, {}))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.map((d) => d.id)).toEqual(['account'])
})

// Synthetic /v1/activity/charts body — scorecard pairs + a 2-day delivery/runs trend + top workflows.
const charts = {
  data: {
    'messages-delivered': { currentPeriod: 320000, previousPeriod: 280000 },
    'active-subscribers': { currentPeriod: 120000, previousPeriod: 110000 },
    'avg-messages-per-subscriber': { currentPeriod: 2.68, previousPeriod: 2.42 },
    'total-interactions': { currentPeriod: 66, previousPeriod: 75 },
    'workflow-by-volume': [
      { workflowName: 'Quota Reached', count: 160000 },
      { workflowName: 'Auto-Recharge Success', count: 4 }
    ],
    'workflow-runs-trend': [
      { timestamp: '2026-06-16', completed: 7158, error: 0 },
      { timestamp: '2026-06-17', completed: 6960, error: 0 }
    ],
    'delivery-trend': [
      { timestamp: '2026-06-16', inApp: 7158, email: 7000, sms: 0, chat: 0, push: 0 },
      { timestamp: '2026-06-17', inApp: 6960, email: 6800, sms: 0, chat: 0, push: 0 }
    ]
  }
}

test('buildNovuUsageResult: allowance card (used/included) + engagement scorecards with prior-period deltas', () => {
  const result = buildNovuUsageResult(subscription, charts)

  expect(validateCapabilityResult(result)).toEqual([])

  // Headline stat row: the workflow-run allowance + the four scorecards.
  const usage = result.datasets.find((d) => d.id === 'usage')

  if (usage?.shape === 'record') {
    expect(usage.value).toMatchObject({
      workflowRuns: 160000,
      messagesDelivered: 320000,
      activeSubscribers: 120000,
      interactions: 66,
      avgPerSubscriber: 2.68
    })
  }

  const stat = result.views?.find((v) => v.type === 'stat')
  const statFields = stat && 'fields' in stat ? stat.fields : []

  // The allowance card carries the included quota as its denominator (progress bar) + the billing period.
  expect(statFields).toContainEqual({ key: 'workflowRuns', max: 250000, caption: '2026-05-13 → 2026-06-13' })
  // Deltas: compacted with a sign, a decline reads negative.
  expect(statFields).toContainEqual({ key: 'messagesDelivered', caption: '+40.0K vs prior period' })
  expect(statFields).toContainEqual({ key: 'interactions', caption: '-9 vs prior period' })
  expect(statFields).toContainEqual({ key: 'avgPerSubscriber', caption: '+0.3 vs prior period' })
})

test('buildNovuUsageResult: delivery trend stacks only non-zero channels; runs + top-workflows tables', () => {
  const result = buildNovuUsageResult(subscription, charts)

  // Delivery is stacked by channel; the all-zero sms/chat/push channels are dropped (only In-App + Email rows).
  const delivery = result.datasets.find((d) => d.id === 'delivery')

  if (delivery?.shape === 'table') {
    expect([...new Set(delivery.rows.map((r) => r.channel))]).toEqual(['In-App', 'Email'])
    expect(delivery.rows).toHaveLength(4) // 2 channels × 2 days
    // (day, channel) uniquely keys each delivery count so the trend accumulates.
    expect(delivery.key).toEqual(['day', 'channel'])
  }

  const deliveryView = result.views?.find((v) => v.type === 'timeseries' && v.dataset === 'delivery')

  expect(deliveryView && 'stackBy' in deliveryView ? deliveryView.stackBy : undefined).toBe('channel')

  // Runs trend reads `completed` per day; top workflows passes volume through (newest API order kept).
  const runs = result.datasets.find((d) => d.id === 'runs')

  if (runs?.shape === 'table') {
    expect(runs.rows).toEqual([
      { day: '2026-06-16', runs: 7158 },
      { day: '2026-06-17', runs: 6960 }
    ])
    expect(runs.key).toBe('day') // one point per day → keyed so the trend accumulates
  }

  const top = result.datasets.find((d) => d.id === 'topWorkflows')

  if (top?.shape === 'table') {
    expect(top.rows).toEqual([
      { workflow: 'Quota Reached', count: 160000 },
      { workflow: 'Auto-Recharge Success', count: 4 }
    ])
    expect(top.key).toBe('workflow') // one row per workflow → keyed so the aggregate accumulates
  }
})

test('buildNovuUsageResult degrades to just the allowance card when the charts call fails', () => {
  const result = buildNovuUsageResult(subscription, {})

  expect(validateCapabilityResult(result)).toEqual([])

  // Only the allowance card survives — no scorecard fields, no trend/table sections.
  const usage = result.datasets.find((d) => d.id === 'usage')

  if (usage?.shape === 'record') {
    expect(Object.keys(usage.value)).toEqual(['workflowRuns'])
  }

  expect(result.datasets.map((d) => d.id)).toEqual(['usage'])
})

test('buildNovuUsageResult: an unlimited allowance (no included quota) omits the progress denominator', () => {
  const result = buildNovuUsageResult({ data: { events: { current: 10 } } }, {})
  const stat = result.views?.find((v) => v.type === 'stat')
  const fields = stat && 'fields' in stat ? (stat.fields ?? []) : []
  const field = fields.find((f) => typeof f === 'object' && f.key === 'workflowRuns')

  expect(field && typeof field === 'object' ? field.max : 'MISSING').toBeUndefined()
})

test('parseClerkJwt returns the active session JWT from a /v1/client body', () => {
  const body = {
    response: {
      last_active_session_id: 'sess_ACTIVE',
      sessions: [
        { id: 'sess_OTHER', last_active_token: { jwt: 'jwt_other' } },
        { id: 'sess_ACTIVE', last_active_token: { jwt: 'jwt_active' } }
      ]
    }
  }

  expect(parseClerkJwt(body)).toBe('jwt_active')
})

test('parseClerkJwt throws on a stale cookie (no active session)', () => {
  expect(() => parseClerkJwt({ response: { sessions: [] } })).toThrow(/No active Clerk session/)
})

test('parseClerkJwt throws when the active session carries no token', () => {
  expect(() => parseClerkJwt({ response: { last_active_session_id: 'sess_A', sessions: [{ id: 'sess_A' }] } })).toThrow(
    /no active token/
  )
})

// Clerk org-memberships shape from /v1/organizations/{org}/memberships; all ids/names/emails synthetic.
const membershipList = {
  response: {
    data: [
      {
        id: 'orgmem_SYNTH1',
        role: 'org:owner',
        role_name: 'Owner',
        public_user_data: {
          user_id: 'user_SYNTH1',
          identifier: 'ada@example.test',
          first_name: 'Ada',
          last_name: 'Lovelace'
        }
      },
      {
        id: 'orgmem_SYNTH2',
        role: 'org:viewer',
        public_user_data: {
          user_id: 'user_SYNTH2',
          identifier: 'grace@example.test',
          first_name: 'Grace',
          last_name: null
        }
      }
    ]
  }
}

test('buildNovuMembers maps Clerk memberships → MembersInput (joined name, identifier email, un-prefixed role)', () => {
  expect(buildNovuMembers(membershipList)).toEqual({
    members: [
      { id: 'user_SYNTH1', name: 'Ada Lovelace', email: 'ada@example.test', role: 'owner' },
      { id: 'user_SYNTH2', name: 'Grace', email: 'grace@example.test', role: 'viewer' }
    ]
  })
})

test('buildNovuMembers falls back to the orgmem id and leaves name undefined when no user data', () => {
  expect(buildNovuMembers({ response: { data: [{ id: 'orgmem_SYNTH3', role: 'org:admin' }] } })).toEqual({
    members: [{ id: 'orgmem_SYNTH3', name: undefined, email: undefined, role: 'admin' }]
  })
})

test('buildNovuMembers degrades to empty on empty input', () => {
  expect(buildNovuMembers({})).toEqual({ members: [] })
  expect(buildNovuMembers({ response: { data: [] } })).toEqual({ members: [] })
})
