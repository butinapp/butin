import type { CollectContext } from '@butinapp/sdk'
import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { epochSecDay } from '@butinapp/sdk/util'
import { describe, expect, it, test } from 'vitest'

import {
  buildChatgptBillingTab,
  buildChatgptMembersResult,
  buildChatgptSummaryResult,
  buildChatgptUsageResult,
  buildCodexReport,
  buildWorkspaceBilling,
  chatgptPlugin,
  CODEX_CREDIT_USD,
  codexCreditsToUsd,
  type FlatChatgptInvoice,
  type RawChatgptBilling,
  type RawCodexBundle,
  type RawInvoice,
  type RawWorkspaceBundle,
  type WorkspaceMember
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of chatgptPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// All fixtures are SYNTHETIC — fabricated workspace/account/member values, no real vendor data.

const bundle: RawWorkspaceBundle = {
  accountId: 'acc-1',
  name: 'Acme Workspace',
  planType: 'team',
  subscription: {
    plan_type: 'team',
    seats_in_use: 67,
    seats_entitled: 91,
    billing_period: 'monthly',
    active_until: '2026-06-16T21:14:40Z',
    will_renew: true,
    billing_currency: 'USD',
    is_delinquent: false
  },
  seatTypeCounts: { seat_type_counts: { default: 61, usage_based: 6 } },
  paymentMethods: {
    payment_methods: [
      { id: 'pm_default', type: 'card', card: { brand: 'mastercard', last4: '2728', exp_month: 5, exp_year: 2028 } },
      { id: 'pm_other', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030 } }
    ],
    default_payment_method_id: 'pm_default'
  },
  billingInfo: {
    name: 'Acme Technologies, Inc.',
    address: {
      line1: '100 Example Street',
      line2: 'Suite 200',
      city: 'Springfield',
      state: 'IL',
      postal_code: '62701',
      country: 'US'
    }
  },
  remainingBalance: {
    balance: '11944.6878400000',
    expiring_balance_details: [
      {
        amount_granted: '25007',
        amount_remaining: '11944.6878400000',
        expiry_date: '2027-06-08T17:31:45Z',
        grant_type: 'auto_recharge_credit'
      }
    ]
  }
}

// The invoice history is now a top-level id-keyed list stamped with the owning accountId + ISO day (as the live
// fetch hoists it). buildWorkspaceBilling regroups by accountId, so the render is identical to the old per-
// bundle shape.
const invoices: FlatChatgptInvoice[] = [
  {
    id: 'in_2',
    accountId: 'acc-1',
    createdIso: '2026-06-08',
    number: 'EX-0050',
    created: 1780939906, // 2026-06-08
    total: 105029, // cents → $1050.29
    currency: 'usd',
    status: 'paid',
    billing_reason: 'manual',
    hosted_invoice_url: 'https://invoice.example.com/x',
    invoice_pdf: 'https://invoice.example.com/x/pdf'
  },
  {
    id: 'in_1',
    accountId: 'acc-1',
    createdIso: '2026-05-09',
    number: 'EX-0049',
    created: 1778347906, // 2026-05-09
    total: 50000, // cents → $500
    currency: 'usd',
    status: 'paid',
    billing_reason: 'subscription_cycle'
  }
]

const CAPTURED = '2026-06-09T18:00:00.000Z'

describe('buildWorkspaceBilling', () => {
  it('normalizes the subscription incl. seat-type split', () => {
    const w = buildWorkspaceBilling([bundle], invoices, CAPTURED).workspaces[0]!

    expect(w.name).toBe('Acme Workspace')
    expect(w.subscription.seatsInUse).toBe(67)
    expect(w.subscription.seatsEntitled).toBe(91)
    expect(w.subscription.renewsAt).toBe('2026-06-16')
    expect(w.subscription.willRenew).toBe(true)
    expect(w.subscription.seatTypes).toEqual({ default: 61, usage_based: 6 })
  })

  it('normalizes the credit balance from the first grant (dollar strings, not cents)', () => {
    const c = buildWorkspaceBilling([bundle], invoices, CAPTURED).workspaces[0]!.credit

    expect(c).not.toBeNull()
    expect(c!.balance).toBeCloseTo(11944.69, 2)
    expect(c!.granted).toBe(25007)
    expect(c!.grantType).toBe('auto_recharge_credit')
    expect(c!.expiryDate).toBe('2027-06-08')
  })

  it('converts invoice totals from cents to dollars, newest first', () => {
    const inv = buildWorkspaceBilling([bundle], invoices, CAPTURED).workspaces[0]!.invoices

    expect(inv).toHaveLength(2)
    expect(inv[0]).toMatchObject({ number: 'EX-0050', amount: 1050.29, status: 'paid', date: '2026-06-08' })
    expect(inv[1]!.amount).toBe(500)
  })

  it('picks the default payment method (not just the first) and formats the billing contact', () => {
    const w = buildWorkspaceBilling([bundle], invoices, CAPTURED).workspaces[0]!

    expect(w.paymentMethod).toEqual({ brand: 'mastercard', last4: '2728', expMonth: 5, expYear: 2028 })
    expect(w.billingContact?.name).toBe('Acme Technologies, Inc.')
    expect(w.billingContact?.address).toBe('100 Example Street, Suite 200, 62701 Springfield, IL, US')
  })

  it('reports MTD as the sum of the current (captured) month invoices only', () => {
    // Captured 2026-06: only the 2026-06-08 invoice ($1050.29) counts; the 2026-05 one ($500) is prior.
    expect(buildWorkspaceBilling([bundle], invoices, CAPTURED).currentMtd).toBeCloseTo(1050.29, 2)
  })

  it('zeroes void/uncollectible invoices for spend but keeps them in the list', () => {
    const voidInvoices: FlatChatgptInvoice[] = [
      {
        id: 'in_v',
        accountId: 'acc-1',
        createdIso: '2026-06-10',
        number: 'EX-0051',
        created: 1781109811,
        total: 42013,
        currency: 'usd',
        status: 'void'
      },
      {
        id: 'in_u',
        accountId: 'acc-1',
        createdIso: '2026-06-11',
        number: 'EX-0052',
        created: 1781200000,
        total: 10000,
        currency: 'usd',
        status: 'uncollectible'
      },
      {
        id: 'in_p',
        accountId: 'acc-1',
        createdIso: '2026-06-12',
        number: 'EX-0053',
        created: 1781300000,
        total: 50000,
        currency: 'usd',
        status: 'paid'
      }
    ]
    const inv = buildWorkspaceBilling([bundle], voidInvoices, CAPTURED).workspaces[0]!.invoices

    expect(inv).toHaveLength(3)
    const byNumber = new Map(inv.map((i) => [i.number, i]))

    expect(byNumber.get('EX-0051')).toMatchObject({ status: 'void', amount: 0 })
    expect(byNumber.get('EX-0052')).toMatchObject({ status: 'uncollectible', amount: 0 })
    expect(byNumber.get('EX-0053')).toMatchObject({ status: 'paid', amount: 500 })
  })

  it('keeps negative proration adjustments at face value', () => {
    const creditInvoices: FlatChatgptInvoice[] = [
      {
        id: 'in_c',
        accountId: 'acc-1',
        createdIso: '2026-06-10',
        created: 1781109811,
        total: -24969,
        currency: 'usd',
        status: 'paid',
        billing_reason: 'subscription_update'
      }
    ]

    expect(buildWorkspaceBilling([bundle], creditInvoices, CAPTURED).workspaces[0]!.invoices[0]!.amount).toBeCloseTo(
      -249.69,
      2
    )
  })

  it('aggregates MTD + invoices across multiple workspaces', () => {
    const second: RawWorkspaceBundle = { ...bundle, accountId: 'acc-2', name: 'Second WS' }
    // The flat list spans both accounts; each bundle picks up only its own invoices by accountId.
    const combined: FlatChatgptInvoice[] = [
      ...invoices,
      {
        id: 'in_w2',
        accountId: 'acc-2',
        createdIso: '2026-06-08',
        number: 'EX-0060',
        created: 1780939906,
        total: 20000,
        currency: 'usd',
        status: 'paid'
      }
    ]
    const r = buildWorkspaceBilling([bundle, second], combined, CAPTURED)

    expect(r.workspaces).toHaveLength(2)
    // acc-1 June invoice $1050.29 + acc-2 June invoice $200.
    expect(r.currentMtd).toBeCloseTo(1250.29, 2)
  })

  it('handles a missing balance/invoices gracefully (empty input)', () => {
    const minimal: RawWorkspaceBundle = {
      accountId: 'acc-2',
      name: 'Empty',
      planType: 'team',
      subscription: { plan_type: 'team', seats_in_use: 1, seats_entitled: 1 },
      seatTypeCounts: {},
      remainingBalance: {}
    }
    const w = buildWorkspaceBilling([minimal], [], CAPTURED).workspaces[0]!

    expect(w.credit).toBeNull()
    expect(w.paymentMethod).toBeNull()
    expect(w.billingContact).toBeNull()
    expect(w.invoices).toEqual([])
    expect(w.subscription.seatTypes).toEqual({})
  })

  it('reports 0 MTD when nothing was charged this month', () => {
    // Only the May invoice — prior to the captured June month.
    const r = buildWorkspaceBilling([bundle], [invoices[1]!], CAPTURED)

    expect(r.currentMtd).toBe(0)
  })
})

describe('buildChatgptSummaryResult', () => {
  it('is a LEAN summary: spend.mtd + headline stat cards + monthly spark, no detail tables', () => {
    const result = buildChatgptSummaryResult(buildWorkspaceBilling([bundle], invoices, CAPTURED))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.value).toBeCloseTo(1050.29, 2)
    expect(result.summaries?.[0]?.basis).toBe('invoiced')
    // The headline account record carries the seat + credit + renewal stats; no account/invoice detail datasets.
    const account = result.datasets.find((d) => d.id === 'account')!

    expect(account.shape).toBe('record')
    expect((account as { value: Record<string, unknown> }).value.currentMtd).toBeCloseTo(1050.29, 2)
    expect((account as { value: Record<string, unknown> }).value.seats).toBe('67 / 91')
    expect((account as { value: Record<string, unknown> }).value.credit).toBeCloseTo(11944.69, 2)

    expect(result.datasets.find((d) => d.id === 'accountInfo')).toBeUndefined()
    expect(result.datasets.find((d) => d.id === 'invoices')).toBeUndefined()
  })

  it('keeps a 0 spend summary when there is no billing data, so the service stays in the Overview', () => {
    const empty: RawWorkspaceBundle = {
      accountId: 'acc-x',
      name: 'X',
      planType: 'team',
      subscription: { plan_type: 'team', seats_in_use: 0, seats_entitled: 0 },
      seatTypeCounts: {},
      remainingBalance: {}
    }
    const result = buildChatgptSummaryResult(buildWorkspaceBilling([empty], [], CAPTURED))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 0 })
  })
})

describe('buildChatgptBillingTab', () => {
  it('is the DETAIL tab: account keyvalue + downloadable invoices fileTable, no spend.mtd summary', () => {
    const result = buildChatgptBillingTab(buildWorkspaceBilling([bundle], invoices, CAPTURED))

    expect(validateCapabilityResult(result)).toEqual([])
    // The detail tab carries NO rollup summary (the headline + chart live on Summary).
    expect(result.summaries).toBeUndefined()

    const account = result.datasets.find((d) => d.id === 'accountInfo') as
      | { value: Record<string, unknown> }
      | undefined

    expect(account?.value.card).toBe('mastercard ···· 2728')
    expect(account?.value.cardExpiry).toBe('05/2028')
    expect(account?.value.billedTo).toBe('Acme Technologies, Inc.')

    const invoicesView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

    expect(invoicesView).toBeDefined()
    expect((invoicesView as { files?: unknown }).files).toMatchObject({ source: { url: 'pdfUrl' }, ext: 'pdf' })

    // Keyed by the Stripe invoice id (number can be null) so invoices accumulate.
    const invoicesDs = result.datasets.find((d) => d.id === 'invoices')

    expect(invoicesDs?.shape === 'table' && invoicesDs.key).toBe('id')

    // The account keyvalue renders before the long invoices table.
    const accountIdx = result.views!.findIndex((v) => v.dataset === 'accountInfo')
    const invoicesIdx = result.views!.findIndex((v) => v.dataset === 'invoices')

    expect(accountIdx).toBeLessThan(invoicesIdx)
  })

  it('drops both sections when there is no billing data', () => {
    const empty: RawWorkspaceBundle = {
      accountId: 'acc-x',
      name: 'X',
      planType: 'team',
      subscription: { plan_type: 'team', seats_in_use: 0, seats_entitled: 0 },
      seatTypeCounts: {},
      remainingBalance: {}
    }
    const result = buildChatgptBillingTab(buildWorkspaceBilling([empty], [], CAPTURED))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.find((d) => d.id === 'accountInfo')).toBeUndefined()
    expect(result.datasets.find((d) => d.id === 'invoices')).toBeUndefined()
  })
})

// ── usage ───────────────────────────────────────────────────────────────────────────

const codexBundle: RawCodexBundle = {
  leaderboard: {
    metric: 'tokens_used',
    window: '1m',
    rows: [
      {
        user_id: 'user-A',
        display_name: 'Ada L',
        value: 3020433462,
        credits_used: 66941.45,
        lines_of_code: 72424,
        rank: 1
      },
      {
        user_id: 'user-Z',
        display_name: 'Zed Q',
        email: 'zed@example.com',
        value: 100,
        credits_used: 1.5,
        lines_of_code: 0,
        rank: 2
      }
    ]
  },
  freshness: {
    min_timestamp_across_data_source: '2026-06-09T12:05:02.596652Z',
    generated_at: '2026-06-09T17:47:50.040608Z'
  }
}

// The workspace roster the Usage tab joins on. user-Z is intentionally absent — an active Codex member who
// no longer holds a seat (exercises the unmatched-row path).
const roster = new Map<string, WorkspaceMember>([
  ['user-A', { userId: 'user-A', seatType: 'usage_based', email: 'ada@example.com', name: 'Ada L' }]
])

describe('codexCreditsToUsd', () => {
  it('converts credits to USD at the invoice-derived $0.04/credit rate', () => {
    expect(CODEX_CREDIT_USD).toBe(0.04)
    expect(codexCreditsToUsd(25007)).toBeCloseTo(1000.28, 2)
    expect(codexCreditsToUsd(67158)).toBeCloseTo(2686.32, 2)
  })
})

describe('buildCodexReport', () => {
  it('joins leaderboard rows to the workspace roster by user_id (seat + email) and converts credits → USD', () => {
    const r = buildCodexReport(codexBundle, roster, CAPTURED, '1m')
    const ada = r.members.find((m) => m.userId === 'user-A')!

    expect(ada.email).toBe('ada@example.com')
    expect(ada.seatType).toBe('usage_based')
    expect(ada.tokens).toBe(3020433462)
    expect(ada.credits).toBeCloseTo(66941.45)
    expect(ada.codexUsd).toBeCloseTo(2677.66, 2)
    expect(ada.linesOfCode).toBe(72424)
  })

  it('keeps an unmatched leaderboard row, falling back to its own email/display_name with a null seat', () => {
    const zed = buildCodexReport(codexBundle, roster, CAPTURED, '1m').members.find((m) => m.userId === 'user-Z')!

    expect(zed.email).toBe('zed@example.com')
    expect(zed.name).toBe('Zed Q')
    expect(zed.seatType).toBeNull()
  })

  it('derives dataAsOf + echoes window/capturedAt and sums org totals', () => {
    const r = buildCodexReport(codexBundle, roster, CAPTURED, '1m')

    expect(r.dataAsOf).toBe('2026-06-09')
    expect(r.window).toBe('1m')
    expect(r.capturedAt).toBe(CAPTURED)
    expect(r.totalTokens).toBe(3020433562)
    expect(r.totalCredits).toBeCloseTo(66942.95)
    expect(r.totalCodexUsd).toBeCloseTo(2677.72, 2)
    expect(r.activeMembers).toBe(2)
  })

  it('handles empty input', () => {
    const r = buildCodexReport({ leaderboard: {}, freshness: {} }, new Map(), CAPTURED, '1m')

    expect(r.members).toEqual([])
    expect(r.totalTokens).toBe(0)
    expect(r.totalCodexUsd).toBe(0)
    expect(r.activeMembers).toBe(0)
    expect(r.dataAsOf).toBe('')
  })
})

describe('buildChatgptUsageResult', () => {
  it('produces a contract-valid usage result with a usage.primary spend + seat-badged leaderboard table', () => {
    const result = buildChatgptUsageResult(buildCodexReport(codexBundle, roster, CAPTURED, '1m'))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('other')
    expect(result.summaries?.[0]?.value).toBeCloseTo(2677.72, 2)
    const board = result.datasets.find((d) => d.id === 'leaderboard') as { rows: Array<Record<string, unknown>> }

    // Costliest member first, badged with the workspace seat type.
    expect(board.rows[0]!.name).toBe('Ada L')
    expect(board.rows[0]!.codexUsd).toBeCloseTo(2677.66, 2)
    expect(board.rows[0]!.seatType).toBe('usage_based')
    expect(result.views?.some((v) => v.type === 'table' && v.dataset === 'leaderboard')).toBe(true)

    // The Codex spend ($) owns the per-member Trend/drilldown — not the token or credit counts.
    const boardDs = result.datasets.find((d) => d.id === 'leaderboard')
    const trended = boardDs?.shape === 'table' ? boardDs.columns.filter((c) => c.accrual === 'cumulative') : []

    expect(trended.map((c) => c.key)).toEqual(['codexUsd'])
  })

  it('renders zeroed org-total cards and no leaderboard for empty input', () => {
    const result = buildChatgptUsageResult(
      buildCodexReport({ leaderboard: {}, freshness: {} }, new Map(), CAPTURED, '1m')
    )

    expect(validateCapabilityResult(result)).toEqual([])
    // The Codex-usage metric always carries a (zeroed) cost, so the usage.primary rollup is present at $0.
    expect(result.summaries?.[0]?.section).toBe('other')
    expect(result.summaries?.[0]?.value).toBe(0)
    expect(result.datasets.find((d) => d.id === 'leaderboard')).toBeUndefined()
  })
})

describe('buildChatgptMembersResult', () => {
  const members: WorkspaceMember[] = [
    { userId: 'user-Z', seatType: 'usage_based', email: 'zed@example.com', name: 'Zed Q' },
    { userId: 'user-A', seatType: 'default', email: 'ada@example.com', name: 'Ada L' }
  ]

  it('renders the roster as a keyed members table sorted by name, seat as a status column', () => {
    const result = buildChatgptMembersResult(members)

    expect(validateCapabilityResult(result)).toEqual([])
    const table = result.datasets.find((d) => d.id === 'members') as {
      key?: string
      rows: Array<Record<string, unknown>>
    }

    expect(table.key).toBe('userId')
    // Sorted alphabetically by name.
    expect(table.rows.map((r) => r.name)).toEqual(['Ada L', 'Zed Q'])
    expect(table.rows[0]!.seatType).toBe('default')
    // No rollup summary — a roster answers "who", not "how much".
    expect(result.summaries).toBeUndefined()
  })

  it('handles an empty roster', () => {
    const result = buildChatgptMembersResult([])

    expect(validateCapabilityResult(result)).toEqual([])
    expect((result.datasets.find((d) => d.id === 'members') as { rows: unknown[] }).rows).toEqual([])
  })
})

// ── incremental billing fetch ─────────────────────────────────────────────────────────

const billingCapability = () => chatgptPlugin.capabilities.find((c) => c.id === 'billing')!

describe('billing incremental fetch', () => {
  it('declares the top-level flat invoice list as its incremental key', () => {
    expect(billingCapability().incremental).toMatchObject({ listKey: 'invoices', id: 'id', timestamp: 'createdIso' })
    // summary shares the fetch but is NOT incremental — it always renders the full history.
    expect(chatgptPlugin.capabilities.find((c) => c.id === 'summary')!.incremental).toBeUndefined()
  })

  it('stops the invoice cursor walk once a page is entirely older than ctx.since, and stamps accountId/createdIso', async () => {
    // Newest-first pages: page 0 is inside the since window, page 1 is entirely older (→ stop), page 2 must
    // never be fetched.
    const pages: RawInvoice[][] = [
      [
        { id: 'in_new1', created: 1780939906, total: 100 }, // 2026-06-08
        { id: 'in_new2', created: 1781000000, total: 100 } // 2026-06-09
      ],
      [
        { id: 'in_old1', created: 1775000000, total: 100 }, // 2026-04
        { id: 'in_old2', created: 1774000000, total: 100 } // 2026-04
      ],
      [{ id: 'in_never', created: 1770000000, total: 100 }] // must NOT be reached
    ]
    let invoicePage = 0
    const client = {
      get: async (url: string) => {
        if (url.includes('/backend-api/accounts/check')) {
          return {
            accounts: {
              w1: { account: { account_id: 'acc-1', name: 'WS', structure: 'workspace', plan_type: 'team' } }
            }
          }
        }

        if (url.includes('/backend-api/invoices')) {
          const data = pages[invoicePage] ?? []

          invoicePage += 1

          // has_more stays true so only the since watermark stops the walk (not a natural end-of-cursor).
          return { data, has_more: true }
        }

        return {}
      }
    }
    const ctx = { client, since: '2026-05-01' } as unknown as CollectContext

    const raw = (await billingCapability().incremental!.fetch(ctx)) as RawChatgptBilling

    // Page 0 (in window) + page 1 (the older page that triggered the stop) were fetched; page 2 was not.
    expect(invoicePage).toBe(2)
    expect(raw.invoices.map((i) => i.id)).toEqual(['in_new1', 'in_new2', 'in_old1', 'in_old2'])

    // Every hoisted invoice is stamped with its workspace + ISO day (= epochSecDay(created)).
    for (const inv of raw.invoices) {
      expect(inv.accountId).toBe('acc-1')
      expect(inv.createdIso).toBe(epochSecDay(inv.created))
    }

    // The bundle no longer carries invoices — they live only on the top-level list.
    expect(raw.bundles[0]).not.toHaveProperty('invoices')
  })
})

test('chatgpt plugin is well-formed', () => {
  expect(chatgptPlugin.meta.id).toBe('chatgpt')
  expect(chatgptPlugin.auth.kind).toBe('minted-jwt')
  expect(chatgptPlugin.transport?.requiresBrowserEngine).toBe(true)
  // The Codex leaderboard rides the admin.openai.com backend, a separate login (cookie session) with its own
  // capture declared on the backend.
  expect(chatgptPlugin.backends?.admin?.auth.kind).toBe('cookie')
  expect(chatgptPlugin.backends?.admin?.session?.loginUrl).toContain('admin.openai.com')
  expect(chatgptPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
})
