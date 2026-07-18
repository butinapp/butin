import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  buildGoogleWorkspaceBilling,
  buildGoogleWorkspaceBillingTab,
  buildGoogleWorkspaceSummaryResult,
  buildGoogleWorkspaceUsage,
  buildGoogleWorkspaceUsageResult,
  extractPageTokens,
  extractPricing,
  googleWorkspacePlugin,
  isCommerceApp,
  parseBatchExecute,
  parseSubscriptions,
  subscriptionsCurrency
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

// SYNTHETIC fixtures — faithful to the admin `batchexecute` payload SHAPES (the indices the parsers read)
// but with fabricated names/seats/prices/ids. No real account data. A committed annual Standard sub
// (120 committed seats @ 14.72/mo) + a flexible Starter sub (7 assigned @ 11.00/mo).
const SUBS_RAW: unknown = [
  [
    [
      [
        'sub-bs',
        2,
        [1760000000, 0],
        null,
        null,
        null,
        [3, [1791660735, 0]],
        1,
        2,
        null,
        20,
        'USD',
        null,
        ['sub-bs'],
        'US'
      ],
      [
        ['en', 'Acme Workspace Standard', '', ''],
        'logo',
        null,
        1,
        null,
        null,
        ['en', ''],
        null,
        'GOOGLE.GAU_2021',
        '1010020028'
      ],
      [
        1,
        2,
        3,
        null,
        'token',
        null,
        ['en', 'Annual Plan (Monthly Payment)', [null, ''], [null, '']],
        ['user', 'users'],
        null,
        null,
        'USD'
      ],
      ['acct-1'],
      null,
      ['cust', 'GOOGLE.GAU_2021', 2, 106, 120, 14, 5, null, true, null, null, null, null, []]
    ],
    [
      ['sub-st', 2, [1762000000, 0], null, null, null, null, 1, 2, null, 2, 'USD', null, ['sub-st'], 'US'],
      [
        ['en', 'Acme Workspace Starter', '', ''],
        'logo',
        null,
        1,
        null,
        null,
        ['en', ''],
        null,
        'GOOGLE.GAB_2021',
        '1010020027'
      ],
      [
        1,
        2,
        3,
        null,
        'token',
        null,
        ['en', 'Flexible Plan', [null, ''], [null, '']],
        ['user', 'users'],
        null,
        null,
        'USD'
      ],
      ['acct-1'],
      null,
      ['cust', 'GOOGLE.GAB_2021', 2, 7, null, null, 5, null, true, null, null, null, null, []]
    ]
  ]
]

// KRm3O license-settings tree: a price entry is `[null, <skuInfo>, <priceArr>]`; within priceArr, per-seat
// monthly prices are `["USD",u,n]` immediately followed by `[2,1]`. Standard: current 14.72, renewal 18.40.
// Starter: a single 11.00 rate, no renewal. (The leading ["USD",220,…]/[3,1] is an annual-tagged decoy the
// [2,1] guard must skip.)
const PRICING_RAW: unknown = [
  [
    [
      [
        ['ou', 'acme.com', '/', ['ou']],
        [
          [
            null,
            [
              ['en', 'Acme Workspace Standard'],
              'logo',
              null,
              1,
              null,
              null,
              ['en', ''],
              null,
              'GOOGLE.GAU_2021',
              '1010020028'
            ],
            [
              null,
              [
                null,
                [
                  null,
                  [
                    ['USD', 220, 800000000],
                    [3, 1]
                  ],
                  null,
                  null,
                  [
                    [
                      [
                        [[1760079600], [1791615600]],
                        [
                          [
                            ['USD', 14, 720000000],
                            [2, 1]
                          ],
                          '20',
                          2000
                        ],
                        [1, 12]
                      ],
                      [
                        [[1791615600]],
                        [
                          [
                            ['USD', 18, 400000000],
                            [2, 1]
                          ],
                          '0'
                        ],
                        [1]
                      ]
                    ]
                  ],
                  null,
                  [
                    ['USD', 18, 400000000],
                    [2, 1]
                  ]
                ]
              ]
            ]
          ]
        ]
      ],
      [
        ['ou', 'acme.com', '/', ['ou']],
        [
          [
            null,
            [
              ['en', 'Acme Workspace Starter'],
              'logo',
              null,
              1,
              null,
              null,
              ['en', ''],
              null,
              'GOOGLE.GAB_2021',
              '1010020027'
            ],
            [
              null,
              [
                [
                  [
                    [
                      null,
                      null,
                      [
                        ['USD', 11],
                        [2, 1]
                      ]
                    ]
                  ]
                ]
              ]
            ]
          ]
        ]
      ]
    ]
  ]
]

describe('extractPageTokens', () => {
  const HTML =
    'window.WIZ_global_data = {"SNlM0e":"at-tok-123","FdrFJe":"fsid-456","cfb2h":"dasher-commerce-console_20260615"};'

  it('scrapes the three batchexecute tokens out of a billing page', () => {
    expect(extractPageTokens(HTML)).toEqual({
      at: 'at-tok-123',
      fsid: 'fsid-456',
      bl: 'dasher-commerce-console_20260615'
    })
  })

  it('returns null when a token is missing (e.g. the sign-in shell)', () => {
    expect(extractPageTokens('<html><body>Sign in</body></html>')).toBeNull()
    expect(extractPageTokens('{"SNlM0e":"x","FdrFJe":"y"}')).toBeNull()
  })

  it('isCommerceApp distinguishes the billing app from the sign-in shell', () => {
    expect(isCommerceApp('dasher-commerce-console_20260615')).toBe(true)
    expect(isCommerceApp('dasher-admin_20260615')).toBe(true)
    expect(isCommerceApp('identityfrontendauthui_20260615')).toBe(false)
  })
})

describe('parseBatchExecute', () => {
  // The `)]}'`-prefixed, length-prefixed envelope stream: each wrb.fr row's payload is a JSON STRING.
  const envelope = (rpcid: string, payload: unknown): string =>
    `)]}'\n\n${JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic']])}\n`

  it('strips the prefix and decodes the inner JSON-string payload for a rpcid', () => {
    const body = envelope('KyAUjc', SUBS_RAW)

    expect(parseBatchExecute(body, 'KyAUjc')).toEqual(SUBS_RAW)
  })

  it('returns null when the rpcid is absent', () => {
    const body = envelope('KyAUjc', SUBS_RAW)

    expect(parseBatchExecute(body, 'KRm3O')).toBeNull()
  })

  it('skips length-prefix framing lines without throwing', () => {
    const body = `)]}'\n123\n${JSON.stringify([['wrb.fr', 'KRm3O', JSON.stringify(PRICING_RAW)]])}\n456\n`

    expect(parseBatchExecute(body, 'KRm3O')).toEqual(PRICING_RAW)
  })
})

describe('extractPricing', () => {
  it('maps each SKU to its current + renewal per-seat monthly price (USD dollars)', () => {
    const pricing = extractPricing(PRICING_RAW)

    expect(pricing['GOOGLE.GAU_2021']).toEqual({ currentMonthly: 14.72, renewalMonthly: 18.4 })
    expect(pricing['GOOGLE.GAB_2021']).toEqual({ currentMonthly: 11, renewalMonthly: null })
  })

  it('returns an empty map for missing pricing (defensive)', () => {
    expect(extractPricing(null)).toEqual({})
    expect(extractPricing(undefined)).toEqual({})
  })
})

describe('parseSubscriptions', () => {
  it('extracts sku, plan, seats, renewal and computes the monthly estimate', () => {
    const subs = parseSubscriptions(SUBS_RAW, extractPricing(PRICING_RAW))

    expect(subs).toHaveLength(2)

    const bs = subs[0]!

    expect(bs.skuId).toBe('GOOGLE.GAU_2021')
    expect(bs.skuName).toBe('Acme Workspace Standard')
    expect(bs.planName).toBe('Annual Plan (Monthly Payment)')
    expect(bs.status).toBe('active')
    expect(bs.seatsAssigned).toBe(106)
    expect(bs.seatsCommitted).toBe(120)
    expect(bs.renewalDate).toBe('2026-10-10')
    expect(bs.perSeatMonthly).toBe(14.72)
    expect(bs.renewalPerSeatMonthly).toBe(18.4)
    // committed seats × current per-seat price
    expect(bs.monthlyEstimate).toBeCloseTo(1766.4, 2)

    const starter = subs[1]!

    expect(starter.seatsCommitted).toBeNull()
    expect(starter.seatsAssigned).toBe(7)
    // flexible plan → falls back to assigned seats
    expect(starter.monthlyEstimate).toBeCloseTo(77, 2)
  })

  it('returns [] for empty input', () => {
    expect(parseSubscriptions(null, {})).toEqual([])
    expect(parseSubscriptions([[]], {})).toEqual([])
  })
})

describe('subscriptionsCurrency', () => {
  it('reads the billing currency off the first subscription', () => {
    expect(subscriptionsCurrency(SUBS_RAW)).toBe('USD')
  })

  it('returns undefined for empty/garbage input', () => {
    expect(subscriptionsCurrency(null)).toBeUndefined()
    expect(subscriptionsCurrency([[]])).toBeUndefined()
  })
})

describe('buildGoogleWorkspaceBilling', () => {
  it('sums the monthly run-rate into monthlyRunRate', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: SUBS_RAW, pricingRaw: PRICING_RAW, currency: 'USD' })

    expect(billing.currency).toBe('USD')
    expect(billing.monthlyRunRate).toBeCloseTo(1843.4, 2) // 1766.40 + 77.00
    expect(billing.subscriptions).toHaveLength(2)
  })

  it('leaves monthlyRunRate null when no subscription can be priced', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: SUBS_RAW, pricingRaw: null })

    expect(billing.monthlyRunRate).toBeNull()
    // currency defaults to USD when not supplied
    expect(billing.currency).toBe('USD')
  })

  it('never throws on empty/garbage input (defensive defaults)', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: null, pricingRaw: null })

    expect(billing.subscriptions).toEqual([])
    expect(billing.monthlyRunRate).toBeNull()
  })
})

describe('buildGoogleWorkspaceSummaryResult', () => {
  it('produces a LEAN contract-valid summary with the run-rate as spend.mtd and no subscriptions table', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: SUBS_RAW, pricingRaw: PRICING_RAW, currency: 'USD' })
    const result = buildGoogleWorkspaceSummaryResult(billing)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.value).toBeCloseTo(1843.4, 2)
    expect(result.summaries?.[0]?.basis).toBe('flat')

    const account = result.datasets.find((d) => d.id === 'account')

    if (account?.shape === 'record') {
      expect(account.value.baseFee).toBeCloseTo(1843.4, 2)
    }

    // the detail table lives on the Billing tab, not on Summary
    expect(result.datasets.some((d) => d.id === 'subscriptions')).toBe(false)
  })

  it('stays contract-valid with no run-rate (null currentMtd → no summary)', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: SUBS_RAW, pricingRaw: null })
    const result = buildGoogleWorkspaceSummaryResult(billing)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries).toBeUndefined()
  })
})

describe('buildGoogleWorkspaceBillingTab', () => {
  it('produces a contract-valid detail with the subscriptions table and no spend.mtd summary', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: SUBS_RAW, pricingRaw: PRICING_RAW, currency: 'USD' })
    const result = buildGoogleWorkspaceBillingTab(billing)

    expect(validateCapabilityResult(result)).toEqual([])
    const subscriptions = result.datasets.find((d) => d.id === 'subscriptions')

    expect(subscriptions?.shape).toBe('table')
    // Keyed by the SKU name so each subscription accumulates its seats/estimate history in the ledger.
    expect(subscriptions?.shape === 'table' && subscriptions.key).toBe('skuName')
    // detail tab: no rollup summary, no Summary headline cards
    expect(result.summaries).toBeUndefined()
  })

  it('stays contract-valid with zero subscriptions (drops the empty table)', () => {
    const billing = buildGoogleWorkspaceBilling({ subsRaw: null, pricingRaw: null })
    const result = buildGoogleWorkspaceBillingTab(billing)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.some((d) => d.id === 'subscriptions')).toBe(false)
  })
})

describe('buildGoogleWorkspaceUsage', () => {
  it('reports per-SKU seat utilization against the commitment', () => {
    const usage = buildGoogleWorkspaceUsage(SUBS_RAW)

    expect(usage.totalAssigned).toBe(113) // 106 + 7
    expect(usage.totalCommitted).toBe(120)

    const bs = usage.seats[0]!

    expect(bs.seatsAssigned).toBe(106)
    expect(bs.seatsCommitted).toBe(120)
    expect(bs.utilization).toBeCloseTo(106 / 120, 4)

    // flexible plan has no commitment → null utilization
    expect(usage.seats[1]!.utilization).toBeNull()
  })

  it('returns zeros for empty input', () => {
    const usage = buildGoogleWorkspaceUsage(null)

    expect(usage.seats).toEqual([])
    expect(usage.totalAssigned).toBe(0)
    expect(usage.totalCommitted).toBe(0)
  })
})

describe('buildGoogleWorkspaceUsageResult', () => {
  it('produces a contract-valid usage result with the seat table', () => {
    const result = buildGoogleWorkspaceUsageResult(buildGoogleWorkspaceUsage(SUBS_RAW))

    expect(validateCapabilityResult(result)).toEqual([])
    const seats = result.datasets.find((d) => d.id === 'seats')

    expect(seats?.shape).toBe('table')
    // Keyed by the SKU name so each subscription's seat utilization accumulates in the ledger.
    expect(seats?.shape === 'table' && seats.key).toBe('skuName')
  })

  it('stays contract-valid with zero seats', () => {
    const result = buildGoogleWorkspaceUsageResult(buildGoogleWorkspaceUsage(null))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.some((d) => d.id === 'seats')).toBe(false)
  })
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of googleWorkspacePlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

describe('googleWorkspacePlugin descriptor', () => {
  it('is well-formed (cookie auth, node transport, summary/billing/usage tabs)', () => {
    expect(googleWorkspacePlugin.meta.id).toBe('google-workspace')
    expect(googleWorkspacePlugin.auth.kind).toBe('cookie')
    expect(googleWorkspacePlugin.transport?.engine).toBe('node')
    expect(googleWorkspacePlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage'])
  })
})
