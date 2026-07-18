import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  buildOpenaiBilling,
  buildOpenaiBillingTab,
  buildOpenaiKeys,
  buildOpenaiKeysResult,
  buildOpenaiMembers,
  buildOpenaiSpend,
  buildOpenaiSummaryResult,
  openaiPlugin,
  parseMintedSession,
  type RawApiKeyList,
  type RawOrgInvoices,
  type RawOrgUserList,
  type RawOrgUsage,
  type SpendLimits
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('openai plugin is well-formed', () => {
  expect(openaiPlugin.meta.id).toBe('openai-platform')
  expect(openaiPlugin.auth.kind).toBe('minted-jwt')
  expect(openaiPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'apiKeys', 'members'])
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of openaiPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// ── members: org roster, merged + deduped across work orgs ─────────────────────────────────

describe('buildOpenaiMembers', () => {
  const orgA: RawOrgUserList = {
    data: [
      { id: 'user-1', name: 'Ada Byron', email: 'ada@acme.test', role: 'owner' },
      { id: 'user-2', name: 'Grace Mol', email: 'grace@acme.test', role: 'reader' }
    ]
  }
  const orgB: RawOrgUserList = {
    // user-1 also belongs to the second org — first occurrence wins.
    data: [
      { id: 'user-1', name: 'Ada Byron', email: 'ada@acme.test', role: 'reader' },
      { id: 'user-3', name: null, email: 'svc@acme.test', role: 'reader' }
    ]
  }

  it('merges work-org user lists and dedupes by id (first wins)', () => {
    const { members } = buildOpenaiMembers([orgA, orgB])

    expect(members.map((m) => m.id)).toEqual(['user-1', 'user-2', 'user-3'])
    expect(members.find((m) => m.id === 'user-1')?.role).toBe('owner')
  })

  it('maps name/email/role and tolerates a null name', () => {
    const member = buildOpenaiMembers([orgB]).members.find((m) => m.id === 'user-3')!

    expect(member).toMatchObject({ email: 'svc@acme.test', role: 'reader' })
    expect(member.name).toBeUndefined()
  })

  it('handles empty / absent input', () => {
    expect(buildOpenaiMembers(null).members).toEqual([])
    expect(buildOpenaiMembers([{ data: [] }]).members).toEqual([])
  })
})

// Synthetic fixtures. Money fields (total/amount_due/tax/cost) are in CENTS; created/period_start are unix
// seconds; sensitive_id is the already-masked key hint OpenAI returns. No real keys/orgs/emails.
const LIMITS: SpendLimits = { softLimitUsd: 4999.99998, hardLimitUsd: 19999.99998, planTitle: 'Pay-as-you-go' }

// ── billing: invoice history ─────────────────────────────────────────────────────────────

const SMALL_ORG: RawOrgInvoices = {
  orgId: 'org-small',
  orgName: 'Acme Dev',
  invoices: [
    {
      id: 'in_2',
      number: 'AAAA-0048',
      total: 26_924,
      amount_due: 26_924,
      tax: 1_282,
      created: 1_780_349_191, // 2026-06-01
      status: 'paid',
      hosted_invoice_url: 'https://invoice.example/i/hosted2',
      pdf_url: 'https://pay.example/invoice/pdf2'
    },
    {
      id: 'in_1',
      number: 'AAAA-0047',
      total: 42_973,
      amount_due: 42_973,
      tax: 2_046,
      created: 1_777_674_083, // 2026-05-01
      status: 'paid',
      hosted_invoice_url: 'https://invoice.example/i/hosted1',
      pdf_url: null
    }
  ]
}

const BIG_ORG: RawOrgInvoices = {
  orgId: 'org-big',
  orgName: 'Acme Prod',
  invoices: [
    {
      id: 'in_b1',
      number: 'BBBB-0056',
      total: 8_018_914, // $80,189.14
      amount_due: 8_018_914,
      tax: 0,
      created: 1_781_040_000, // 2026-06-10
      status: 'paid',
      hosted_invoice_url: 'https://invoice.example/i/big56',
      pdf_url: 'https://pay.example/invoice/big56'
    }
  ]
}

describe('buildOpenaiBilling', () => {
  it('normalizes cents → USD and the timestamp → YYYY-MM-DD', () => {
    const r = buildOpenaiBilling([SMALL_ORG], LIMITS)
    const first = r.invoices.find((i) => i.id === 'in_2')!

    expect(first.amount).toBeCloseTo(269.24, 2)
    expect(first.amountDue).toBeCloseTo(269.24, 2)
    expect(first.tax).toBeCloseTo(12.82, 2)
    expect(first.date).toBe('2026-06-01')
    expect(first.hostedUrl).toBe('https://invoice.example/i/hosted2')
    expect(first.pdfUrl).toBe('https://pay.example/invoice/pdf2')
    expect(first.orgName).toBe('Acme Dev')
    expect(r.limits.softLimitUsd).toBeCloseTo(4999.99998, 4)
  })

  it('merges invoices across orgs and sorts newest-first', () => {
    const r = buildOpenaiBilling([SMALL_ORG, BIG_ORG], LIMITS)

    expect(r.invoices).toHaveLength(3)
    expect(r.invoices.map((i) => i.id)).toEqual(['in_b1', 'in_2', 'in_1'])
  })

  it('summarizes per-org totals, sorted by descending total', () => {
    const r = buildOpenaiBilling([SMALL_ORG, BIG_ORG], LIMITS)

    expect(r.orgs.map((o) => o.orgId)).toEqual(['org-big', 'org-small'])
    expect(r.orgs[0]!.total).toBeCloseTo(80189.14, 2)
    expect(r.orgs[0]!.count).toBe(1)
    expect(r.orgs[1]!.total).toBeCloseTo(269.24 + 429.73, 2)
    expect(r.orgs[1]!.count).toBe(2)
  })

  it('dates by usage-period start when present (arrears), not created', () => {
    const r = buildOpenaiBilling(
      [
        {
          orgId: 'org-arrears',
          orgName: 'Arrears',
          invoices: [
            {
              id: 'in_arrears',
              total: 8_018_914,
              created: 1_780_349_191, // 2026-06-01 (issued)
              period_start: 1_777_689_600, // 2026-05-02 (usage month: May)
              period_end: 1_780_368_000,
              status: 'paid'
            }
          ]
        }
      ],
      LIMITS
    )

    // Booked into May (the usage month), not June (the issue month).
    expect(r.invoices[0]!.date).toBe('2026-05-02')
  })

  it('returns a fully-shaped report for empty input', () => {
    const r = buildOpenaiBilling([], LIMITS)

    expect(r.invoices).toEqual([])
    expect(r.orgs).toEqual([])
    expect(r.limits).toEqual(LIMITS)
  })

  it('coalesces missing invoice fields to safe defaults', () => {
    const r = buildOpenaiBilling([{ orgId: 'org-x', orgName: 'X', invoices: [{ id: 'in_x' }] }], {
      softLimitUsd: null,
      hardLimitUsd: null,
      planTitle: null
    })
    const inv = r.invoices[0]!

    expect(inv.amount).toBe(0)
    expect(inv.status).toBe('unknown')
    expect(inv.number).toBeNull()
    expect(inv.date).toBeUndefined()
    expect(inv.hostedUrl).toBeNull()
  })

  it('handles null input', () => {
    const r = buildOpenaiBilling(null, LIMITS)

    expect(r.invoices).toEqual([])
    expect(r.orgs).toEqual([])
  })
})

// ── billing: current-month spend ───────────────────────────────────────────────────────

// line-item `cost` is CENTS; fixtures use cents so the dollar totals (190, 185, 160…) read as cents/100.
const PROD: RawOrgUsage = {
  org: { id: 'org-PROD', title: 'Acme Prod', personal: false },
  usage: {
    daily_costs: [
      {
        timestamp: 1_780_272_000, // 2026-06-01
        line_items: [
          { name: 'gpt-5.5, input', cost: 10_000, project_id: 'proj_A', project_name: 'Default' },
          { name: 'gpt-5.5, output', cost: 5_000, project_id: 'proj_A', project_name: 'Default' },
          { name: 'o3, input', cost: 2_500, project_id: 'proj_B', project_name: 'Realtime' }
        ]
      },
      {
        timestamp: 1_780_358_400, // 2026-06-02
        line_items: [{ name: 'gpt-5.5, input', cost: 1_000, project_id: 'proj_A', project_name: 'Default' }]
      }
    ]
  }
}

const INTERNAL: RawOrgUsage = {
  org: { id: 'org-INT', title: 'Acme Internal', personal: false },
  usage: {
    daily_costs: [
      {
        timestamp: 1_780_272_000, // 2026-06-01
        line_items: [{ name: 'gpt-5.5, input', cost: 500, project_id: 'proj_C', project_name: 'Codex users' }]
      }
    ]
  }
}

describe('buildOpenaiSpend', () => {
  it('sums a grand total across orgs (cents → USD)', () => {
    const r = buildOpenaiSpend([PROD, INTERNAL], '2026-06-09T18:00:00.000Z', '2026-06')

    expect(r.grandTotal).toBe(190) // 100+50+25+10 + 5
    expect(r.currentMtd).toBe(190) // captured in the same month it covers → MTD
  })

  it('only reports MTD when the report covers the current (captured) month', () => {
    const past = buildOpenaiSpend([PROD, INTERNAL], '2026-06-09T18:00:00.000Z', '2026-05')

    expect(past.currentMtd).toBeNull()
    expect(past.grandTotal).toBe(190)
  })

  it('produces a daily total series summed across orgs, sorted by date', () => {
    const r = buildOpenaiSpend([PROD, INTERNAL], '2026-06-09T18:00:00.000Z', '2026-06')

    expect(r.daily).toEqual([
      { date: '2026-06-01', value: 180 }, // 100+50+25 (prod) + 5 (internal)
      { date: '2026-06-02', value: 10 }
    ])
  })

  it('handles empty input', () => {
    const r = buildOpenaiSpend(null, '2026-06-09T18:00:00.000Z', '2026-06')

    expect(r.grandTotal).toBe(0)
    expect(r.currentMtd).toBe(0) // current month, zero spend
    expect(r.daily).toEqual([])
  })
})

// ── billing: result composition ──────────────────────────────────────────────────────────

// ── Summary tab — lean: spend.mtd headline + monthly chart + spend-limit stats, no detail tables ────────

describe('buildOpenaiSummaryResult', () => {
  it('is lean: spend.mtd headline + monthly chart, no per-org / invoice detail datasets', () => {
    const billing = buildOpenaiBilling([SMALL_ORG, BIG_ORG], LIMITS)
    const spend = buildOpenaiSpend([PROD, INTERNAL], '2026-06-09T18:00:00.000Z', '2026-06')
    const r = buildOpenaiSummaryResult(billing, spend)

    expect(validateCapabilityResult(r)).toEqual([]) // contract-valid
    expect(r.summaries?.[0]?.section).toBe('spend')
    expect(r.summaries?.[0]?.basis).toBe('accrued') // a live open-period accrual, so backfill seeds the open month's bar
    expect(r.summaries?.[0]?.value).toBe(190) // the live MTD, not the arrears invoice total
    expect(r.datasets.find((d) => d.id === 'monthly')).toBeDefined() // the spark/chart stays

    // The detail tables belong to the Billing tab — they must NOT be on Summary.
    expect(r.datasets.find((d) => d.id === 'orgs')).toBeUndefined()
    expect(r.datasets.find((d) => d.id === 'invoices')).toBeUndefined()

    // budget used = MTD spend / hard limit, as a 0..1 fraction the percent role formats
    const account = r.datasets.find((d) => d.id === 'account')

    if (account?.shape === 'record') {
      expect(account.fields.find((f) => f.key === 'budgetUsed')?.role).toBe('percent')
      expect(account.value.budgetUsed).toBeCloseTo(190 / 19999.99998, 6)
    }
  })

  it('buckets each arrears invoice under the month it covers, not its issue month', () => {
    // OpenAI issues a day or two into a month billing the prior month: these are real issue instants — 2026-07-02
    // (covers June) and 2026-06-01 (covers May). The monthly chart / Overview must show them under June / May,
    // else the current month reads a phantom bar equal to last month's bill. A plain day-minus-1 wouldn't reach
    // the prior month from Jul 02.
    const arrears: RawOrgInvoices = {
      orgId: 'org-arrears',
      orgName: 'Arrears',
      invoices: [
        { id: 'jul', total: 7_757_168, created: 1_782_957_933, status: 'paid' }, // issued 2026-07-02 → covers June
        { id: 'jun', total: 8_018_914, created: 1_780_348_753, status: 'paid' } // issued 2026-06-01 → covers May
      ]
    }
    const billing = buildOpenaiBilling([arrears], LIMITS)
    const spend = buildOpenaiSpend([PROD, INTERNAL], '2026-07-14T18:00:00.000Z', '2026-07')
    const r = buildOpenaiSummaryResult(billing, spend)
    const monthly = r.datasets.find((d) => d.id === 'monthly')
    const months = monthly?.shape === 'table' ? monthly.rows.map((row) => row.month) : []

    expect(months).toContain('2026-06') // the Jul-01 invoice lands in June
    expect(months).toContain('2026-05') // the Jun-01 invoice lands in May
    expect(months).not.toContain('2026-07') // the current month has no invoice bar — the headline MTD stands
  })

  it('omits the spend summary when there is no current-month spend (past period)', () => {
    const billing = buildOpenaiBilling([SMALL_ORG], LIMITS)
    const spend = buildOpenaiSpend([PROD], '2026-06-09T18:00:00.000Z', '2026-05') // past month → currentMtd null
    const r = buildOpenaiSummaryResult(billing, spend)

    expect(r.summaries).toBeUndefined()
  })
})

// ── Billing tab — the detail: per-org breakdown + downloadable invoices, no spend.mtd rollup ────────────

describe('buildOpenaiBillingTab', () => {
  it('emits the per-org + invoice detail datasets, with no spend.mtd summary', () => {
    const billing = buildOpenaiBilling([SMALL_ORG, BIG_ORG], LIMITS)
    const r = buildOpenaiBillingTab(billing)

    expect(validateCapabilityResult(r)).toEqual([]) // contract-valid
    expect(r.summaries ?? []).toEqual([]) // detail tab — never feeds the Overview rollup
    expect(r.datasets.find((d) => d.id === 'orgs')).toBeDefined()
    expect(r.datasets.find((d) => d.id === 'invoices')).toBeDefined()
    expect(r.datasets.find((d) => d.id === 'monthly')).toBeUndefined() // the chart lives on Summary

    // Both detail tables carry a ledger key off the unique provider id (threaded hidden) so they accumulate.
    const orgs = r.datasets.find((d) => d.id === 'orgs')
    const invoices = r.datasets.find((d) => d.id === 'invoices')

    expect(orgs?.shape === 'table' && orgs.key).toBe('orgId')
    expect(invoices?.shape === 'table' && invoices.key).toBe('id')
    expect(invoices?.shape === 'table' && invoices.rows.find((row) => row.status === 'paid')?.id).toBe('in_b1')
  })

  it('drops a section with zero rows', () => {
    const r = buildOpenaiBillingTab(buildOpenaiBilling([], LIMITS))

    expect(r.datasets.find((d) => d.id === 'orgs')).toBeUndefined()
    expect(r.datasets.find((d) => d.id === 'invoices')).toBeUndefined()
  })
})

// ── apiKeys ────────────────────────────────────────────────────────────────────────────

// sensitive_id is the already-masked hint OpenAI returns (sk-…suffix) — synthetic here.
const ORG_KEYS: RawApiKeyList = {
  data: [
    {
      sensitive_id: 'sk-svcac****5x0A',
      name: 'integration-production',
      tracking_id: 'key_a',
      created: 1_780_075_593,
      last_use: 1_781_000_000,
      enabled: true,
      deleted_at: null,
      organization: { id: 'org-PROD', title: 'Acme Prod' },
      project: { id: 'proj_3', title: 'Integration' },
      user: { id: 'u1', name: 'svc prod', is_service_account: true }
    },
    {
      sensitive_id: 'sk-abc****dead',
      name: 'deleted key',
      tracking_id: 'key_del',
      created: 1_700_000_000,
      last_use: null,
      enabled: true,
      deleted_at: 1_779_000_000, // deleted → excluded
      organization: { id: 'org-PROD', title: 'Acme Prod' },
      project: { id: 'proj_3', title: 'Integration' },
      user: { id: 'u1', name: 'svc prod', is_service_account: true }
    }
  ]
}

const USER_KEYS: RawApiKeyList = {
  data: [
    {
      sensitive_id: 'sk-LCwdG****UecX',
      name: 'legacy-app',
      tracking_id: 'key_legacy',
      created: 1_683_731_406,
      last_use: 1_683_731_857,
      enabled: true,
      deleted_at: null,
      organization: null,
      project: null, // legacy / user-level key
      user: { id: 'uY', name: 'Sam Example', is_service_account: false }
    }
  ]
}

describe('buildOpenaiKeys', () => {
  it('flattens org + legacy keys, dropping deleted ones', () => {
    const r = buildOpenaiKeys([ORG_KEYS], USER_KEYS)

    expect(r.totalKeys).toBe(2) // deleted key excluded
    expect(r.keys.map((k) => k.id).sort()).toEqual(['key_a', 'key_legacy'])
  })

  it('marks project-less keys as legacy and counts them', () => {
    const r = buildOpenaiKeys([ORG_KEYS], USER_KEYS)
    const legacy = r.keys.find((k) => k.id === 'key_legacy')!

    expect(legacy.legacy).toBe(true)
    expect(legacy.projectTitle).toBeNull()
    expect(legacy.creator).toBe('Sam Example')
    expect(r.legacyKeys).toBe(1)
  })

  it('normalizes org/project/last-used for project keys', () => {
    const r = buildOpenaiKeys([ORG_KEYS], USER_KEYS)
    const k = r.keys.find((k) => k.id === 'key_a')!

    expect(k.orgTitle).toBe('Acme Prod')
    expect(k.projectTitle).toBe('Integration')
    expect(k.legacy).toBe(false)
    expect(k.isServiceAccount).toBe(true)
    expect(k.lastUsed).toBe('2026-06-09')
    expect(k.created).toBe('2026-05-29')
  })

  it('sorts by last used desc, never-used last', () => {
    const withNever: RawApiKeyList = {
      data: [
        {
          tracking_id: 'k_never',
          name: 'never',
          created: 1_700_000_000,
          last_use: null,
          enabled: true,
          project: { id: 'p', title: 'P' },
          organization: { id: 'o', title: 'O' }
        },
        {
          tracking_id: 'k_recent',
          name: 'recent',
          created: 1_700_000_000,
          last_use: 1_781_000_000,
          enabled: true,
          project: { id: 'p', title: 'P' },
          organization: { id: 'o', title: 'O' }
        }
      ]
    }
    const r = buildOpenaiKeys([withNever], { data: [] })

    expect(r.keys.map((k) => k.id)).toEqual(['k_recent', 'k_never'])
  })

  it('handles empty input', () => {
    const r = buildOpenaiKeys(null, null)

    expect(r.keys).toEqual([])
    expect(r.totalKeys).toBe(0)
  })
})

describe('buildOpenaiKeysResult', () => {
  it('maps the inventory onto the apiKeys table with masked hints', () => {
    const r = buildOpenaiKeysResult(buildOpenaiKeys([ORG_KEYS], USER_KEYS))
    const keysTable = r.datasets.find((d) => d.id === 'keys')!

    expect(keysTable.shape).toBe('table')
    const rows = keysTable.shape === 'table' ? keysTable.rows : []
    const masks = rows.map((row) => row.masked)

    expect(masks).toContain('sk-svcac****5x0A')
    expect(masks).toContain('sk-LCwdG****UecX')
  })

  it('folds the project title into the key name', () => {
    const r = buildOpenaiKeysResult(buildOpenaiKeys([ORG_KEYS], { data: [] }))
    const keysTable = r.datasets.find((d) => d.id === 'keys')!
    const rows = keysTable.shape === 'table' ? keysTable.rows : []

    expect(rows.some((row) => row.name === 'integration-production · Integration')).toBe(true)
  })

  it('emits a contract-valid result', () => {
    const r = buildOpenaiKeysResult(buildOpenaiKeys([ORG_KEYS], USER_KEYS))

    expect(validateCapabilityResult(r)).toEqual([])
  })
})

// ── auth mint ──────────────────────────────────────────────────────────────────────────

describe('parseMintedSession', () => {
  it('reads the sess token and org list (nested user.session shape)', () => {
    const r = parseMintedSession({
      user: {
        session: { sensitive_id: 'sess-abc123' },
        orgs: {
          data: [
            { id: 'org-1', title: 'Acme Prod', personal: false },
            { id: 'org-personal', title: 'Personal', personal: true }
          ]
        }
      }
    })

    expect(r.sessToken).toBe('sess-abc123')
    expect(r.orgs).toHaveLength(2)
    expect(r.orgs[0]).toEqual({ id: 'org-1', title: 'Acme Prod', personal: false })
    expect(r.orgs[1]!.personal).toBe(true)
  })

  it('tolerates the flat session shape', () => {
    const r = parseMintedSession({ session: { sensitive_id: 'sess-flat' }, user: { orgs: { data: [] } } })

    expect(r.sessToken).toBe('sess-flat')
    expect(r.orgs).toEqual([])
  })

  it('defaults org title to its id and personal to false', () => {
    const r = parseMintedSession({ user: { session: { sensitive_id: 'sess-x' }, orgs: { data: [{ id: 'org-9' }] } } })

    expect(r.orgs[0]).toEqual({ id: 'org-9', title: 'org-9', personal: false })
  })

  it('returns an empty session for missing/empty input', () => {
    expect(parseMintedSession(null).sessToken).toBe('')
    expect(parseMintedSession({}).orgs).toEqual([])
  })
})
