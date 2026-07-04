// Synthetic sample GENERATOR for the demo seed — builds the admin `batchexecute` payload SHAPES (the indices the
// parsers read) purely from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through
// the SAME `build` the live collector uses, so the demo renders exactly what a real fetch would. `users` scales the
// seat counts. The structural markers the parsers key off — the `[2,1]` monthly-per-unit marker, the `[3,1]`
// annual-tagged decoy, the `GOOGLE.*` SKU ids, the status code `2` — are kept verbatim; only names/seats/prices/
// ids/dates are fabricated.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { GoogleWorkspaceData } from './main.js'

// A committed annual Standard sub + a flexible Starter sub. The two SKU ids are stable Google product codes (not
// PII) and are shared between the subscriptions and the pricing tree so the per-seat estimate resolves.
const SKU_STANDARD = 'GOOGLE.GAU_2021'
const SKU_STARTER = 'GOOGLE.GAB_2021'

// Google Money tuple `[currency, units, nanos]` from a dollar amount.
const moneyTuple = (dollars: number): [string, number, number] => {
  const units = Math.floor(dollars)

  return ['USD', units, Math.round((dollars - units) * 1e9)]
}

// Unix seconds for a synthetic renewal date a few months out (relative to the seeded reference instant).
const renewalSeconds = (g: SampleGen): number =>
  Math.floor(new Date(g.dayString(0)).getTime() / 1000) + g.int(30, 300) * 86_400

export const sampleGoogleWorkspace = (g: SampleGen, config: SampleConfig): GoogleWorkspaceData => {
  const standardName = `${g.company()} Standard`
  const starterName = `${g.company()} Starter`
  const domain = `${g.orgSlug()}.example`

  const stdAssigned = config.users
  const stdCommitted = config.users + g.int(4, 20)
  const starterAssigned = g.int(2, 12)

  const stdCurrent = g.money(10, 16)
  const stdRenewal = stdCurrent + g.money(2, 6) // must differ from current so the renewal rate is detected
  const starterRate = g.money(8, 13)

  const subsRaw: unknown = [
    [
      [
        // meta: [0]=id, [1]=2 (active), [6]=[3,[renewalSeconds,0]], [11]='USD'
        [
          'sub-bs',
          2,
          [g.int(1_700_000_000, 1_770_000_000), 0],
          null,
          null,
          null,
          [3, [renewalSeconds(g), 0]],
          1,
          2,
          null,
          20,
          'USD',
          null,
          ['sub-bs'],
          'US'
        ],
        // skuInfo: [0]=['en', NAME,…], [8]=SKU id
        [['en', standardName, '', ''], 'logo', null, 1, null, null, ['en', ''], null, SKU_STANDARD, '1010020028'],
        // planBlock: [6]=['en', PLAN_NAME, …]
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
        // seats: [3]=assigned, [4]=committed
        ['cust', SKU_STANDARD, 2, stdAssigned, stdCommitted, 14, 5, null, true, null, null, null, null, []]
      ],
      [
        [
          'sub-st',
          2,
          [g.int(1_700_000_000, 1_770_000_000), 0],
          null,
          null,
          null,
          null,
          1,
          2,
          null,
          2,
          'USD',
          null,
          ['sub-st'],
          'US'
        ],
        [['en', starterName, '', ''], 'logo', null, 1, null, null, ['en', ''], null, SKU_STARTER, '1010020027'],
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
        ['cust', SKU_STARTER, 2, starterAssigned, null, null, 5, null, true, null, null, null, null, []]
      ]
    ]
  ]

  // KRm3O license-settings tree: a price entry is `[null, <skuInfo>, <priceArr>]`; per-seat monthly prices are Money
  // tuples immediately followed by `[2,1]`. The leading `[…]/[3,1]` is an annual-tagged decoy the `[2,1]` guard skips.
  const pricingRaw: unknown = [
    [
      [
        [
          ['ou', domain, '/', ['ou']],
          [
            [
              null,
              [['en', standardName], 'logo', null, 1, null, null, ['en', ''], null, SKU_STANDARD, '1010020028'],
              [
                null,
                [
                  null,
                  [moneyTuple(g.money(200, 240)), [3, 1]],
                  null,
                  null,
                  [
                    [
                      [
                        [[1760079600], [1791615600]],
                        [[moneyTuple(stdCurrent), [2, 1]], '20', 2000],
                        [1, 12]
                      ],
                      [[[1791615600]], [[moneyTuple(stdRenewal), [2, 1]], '0'], [1]]
                    ]
                  ],
                  null,
                  [moneyTuple(stdRenewal), [2, 1]]
                ]
              ]
            ]
          ]
        ],
        [
          ['ou', domain, '/', ['ou']],
          [
            [
              null,
              [['en', starterName], 'logo', null, 1, null, null, ['en', ''], null, SKU_STARTER, '1010020027'],
              [null, [[[[null, null, [moneyTuple(starterRate), [2, 1]]]]]]]
            ]
          ]
        ]
      ]
    ]
  ]

  return { subsRaw, pricingRaw }
}
