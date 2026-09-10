import { members } from '@butinapp/sdk/presets'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildNgrokBilling,
  buildNgrokBillingTab,
  buildNgrokCredentials,
  buildNgrokKeysResult,
  buildNgrokMembers,
  buildNgrokSummaryResult,
  extractCsrfToken,
  maskId,
  ngrokPlugin,
  type RawApiKeyList,
  type RawAuthtokenList,
  type RawInvitationList,
  type RawInvoiceList,
  type RawSubscription,
  type RawTeamMemberList
} from './main.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(ngrokPlugin)).toEqual([])
})

// Synthetic Connect-RPC shapes (structure copied from the gateway responses; values invented). Money is
// cents; dates are epoch-second `{ seconds }` wrappers, so the expected ISO days are derived by structure.
const subscription: RawSubscription = {
  intervalMonths: 1,
  renewsAt: { seconds: '1781150400' }, // 2026-06-11
  plan: { productId: 'v2_pro_monthly', quantity: '12', description: 'Pro Monthly' },
  currentBillingPeriodStartDate: { seconds: '1778472000' }, // 2026-05-11
  currentBillingPeriodEndDate: { seconds: '1781150400' }, // 2026-06-11
  additionalUsageToDateInCents: 9800 // $98.00
}

const invoices: RawInvoiceList = {
  invoices: [
    {
      total: '109800',
      amountDue: '109800',
      status: 'Draft',
      createdAt: { seconds: '1781150400' }, // 2026-06-11
      invoiceUrl: 'https://invoices.example.com/view?token=abc'
    },
    {
      total: '111204',
      amountDue: '111204',
      amountPaid: '111204',
      status: 'Paid',
      issuedAt: { seconds: '1778515602' } // 2026-05-11
    }
  ]
}

// --- descriptor: cookie session over node transport (Connect-RPC needs Origin/Sec-Fetch-*) ---

test('ngrok is a plain cookie session on node transport (not requiresBrowserEngine)', () => {
  expect(ngrokPlugin.auth.kind).toBe('cookie')
  expect(ngrokPlugin.transport?.engine).toBe('node')
  expect(ngrokPlugin.transport?.requiresBrowserEngine).toBeUndefined()
  expect(ngrokPlugin.session?.cookieDomains).toContain('ngrok.com')
})

// --- CSRF scrape ---

test('extractCsrfToken reads the <meta> token, falls back to the bootstrap JSON, throws when absent', () => {
  expect(extractCsrfToken('<meta name="ngrok-proxy-csrf-token" content="tok-123">')).toBe('tok-123')
  expect(extractCsrfToken('window.__data = ["proxyCsrfToken","tok-456"];')).toBe('tok-456')
  expect(() => extractCsrfToken('<html>no token here</html>')).toThrow(/proxy-csrf/)
})

// --- billing ---

test('billing normalizes cents → USD dollars and epoch seconds → ISO day, newest first', () => {
  const b = buildNgrokBilling(subscription, invoices)

  expect(b.plan).toBe('Pro Monthly')
  expect(b.seats).toBe(12)
  expect(b.intervalMonths).toBe(1)
  expect(b.renewsAt).toBe('2026-06-11')
  expect(b.periodStart).toBe('2026-05-11')
  expect(b.periodEnd).toBe('2026-06-11')
  expect(b.usageToDate).toBe(98)

  expect(b.invoices[0]).toMatchObject({ date: '2026-06-11', amount: 1098, status: 'Draft' })
  expect(b.invoices[0].hostedUrl).toBe('https://invoices.example.com/view?token=abc')
  expect(b.invoices[1]).toMatchObject({ date: '2026-05-11', amount: 1112.04, status: 'Paid' })
})

test('billing invoice date prefers issued, then created, then due', () => {
  const b = buildNgrokBilling(null, {
    invoices: [
      { total: '100', issuedAt: { seconds: '1778515602' }, createdAt: { seconds: '1' }, dueAt: { seconds: '2' } },
      { total: '200', createdAt: { seconds: '1781150400' }, dueAt: { seconds: '2' } },
      { total: '300', dueAt: { seconds: '1778472000' } }
    ]
  })

  // Sorted newest-first by the resolved date.
  expect(b.invoices.map((i) => i.date)).toEqual(['2026-06-11', '2026-05-11', '2026-05-11'])
})

test('billing tolerates an empty bundle', () => {
  const b = buildNgrokBilling(null, null)

  expect(b.plan).toBe('Unknown plan')
  expect(b.seats).toBe(0)
  expect(b.usageToDate).toBe(0)
  expect(b.invoices).toEqual([])
})

test('summary is lean: spend.mtd from usageToDate + monthly spark, no detail tables', () => {
  const result = buildNgrokSummaryResult(buildNgrokBilling(subscription, invoices))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 98,
    basis: 'accrued',
    spark: { dataset: 'monthly' }
  })
  // Lean: the summary carries no Billing-detail datasets (the subscription record + invoice table live there).
  const ids = result.datasets.map((d) => d.id)

  expect(ids).not.toContain('invoices')
})

test('summary keeps a 0 spend.mtd when there is no metered usage to date, so the service stays in the Overview', () => {
  const result = buildNgrokSummaryResult(buildNgrokBilling({ plan: { description: 'Free' } }, null))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 0 })
})

// --- billing detail tab ---

test('billing tab renders a subscription record + invoice table, no spend.mtd summary', () => {
  const result = buildNgrokBillingTab(buildNgrokBilling(subscription, invoices))

  expect(validateCapabilityResult(result)).toEqual([])
  // Detail datasets present; no rollup summary (the headline + chart belong to the Summary tab).
  const ids = result.datasets.map((d) => d.id)

  expect(ids).toContain('account')
  expect(ids).toContain('invoices')
  expect(result.summaries).toBeUndefined()

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ plan: 'Pro Monthly', seats: 12, period: '2026-05-11 → 2026-06-11' })

  const invoiceDataset = result.datasets.find((d) => d.id === 'invoices') as unknown as {
    rows: Record<string, unknown>[]
    key: unknown
  }

  // A single date can hold two invoices, so (date, amount) is the composite key that accumulates history.
  expect(invoiceDataset.key).toEqual(['date', 'amount'])

  expect(invoiceDataset.rows[0]).toMatchObject({
    date: '2026-06-11',
    amount: 1098,
    status: 'Draft',
    url: 'https://invoices.example.com/view?token=abc'
  })
})

test('billing tab drops the invoice table when there are no invoices', () => {
  const result = buildNgrokBillingTab(buildNgrokBilling(subscription, null))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.map((d) => d.id)).toEqual(['account'])
})

// --- apiKeys: combined credential inventory ---

const apiKeys: RawApiKeyList = {
  apiKeys: [
    {
      description: 'API Key 1',
      createdAt: { seconds: '1768343797' }, // 2026-01-13
      id: { id: 'ak_38Dp3a1M3G6YaZ2MbpfL6kNV0tq' },
      ownerLegacy: { title: 'owner@example.com', name: 'owner@example.com' },
      active: true
    }
  ]
}

const authtokens: RawAuthtokenList = {
  dashAuthtokens: [
    {
      description: 'agent token',
      createdAt: { seconds: '1779981728' }, // 2026-05-28
      id: { id: 'cr_3EMHsvKmSYuDOIejpHa6zCDbZrb' },
      ownerLegacy: { title: 'member@example.com' },
      active: false
    }
  ]
}

test('maskId keeps the prefix and last 4; short/empty ids degrade to an em dash', () => {
  expect(maskId('ak_38Dp3a1M3G6YaZ2MbpfL6kNV0tq')).toBe('ak_38…V0tq')
  expect(maskId('cr_3EMHsvKmSYuDOIejpHa6zCDbZrb')).toBe('cr_3E…bZrb')
  expect(maskId('short')).toBe('short')
  expect(maskId()).toBe('—')
})

test('credentials combine API keys then auth tokens, with owner + created + active', () => {
  const creds = buildNgrokCredentials(apiKeys, authtokens)

  expect(creds).toEqual([
    {
      kind: 'API key',
      id: 'ak_38Dp3a1M3G6YaZ2MbpfL6kNV0tq',
      owner: 'owner@example.com',
      createdAt: '2026-01-13',
      active: true
    },
    {
      kind: 'Auth token',
      id: 'cr_3EMHsvKmSYuDOIejpHa6zCDbZrb',
      owner: 'member@example.com',
      createdAt: '2026-05-28',
      active: false
    }
  ])
})

test('credentials fall back through owner fields and default active to false', () => {
  const creds = buildNgrokCredentials(
    { apiKeys: [{ id: { id: 'ak_x' }, ownerLegacy: { description: 'svc account' } }] },
    null
  )

  expect(creds[0]).toMatchObject({ owner: 'svc account', active: false, createdAt: undefined })
})

test('credentials tolerate empty input', () => {
  expect(buildNgrokCredentials(null, null)).toEqual([])
  expect(buildNgrokCredentials({}, {})).toEqual([])
})

test('keys result folds kind + owner into the name, masks the id, maps active → status, and is valid', () => {
  const result = buildNgrokKeysResult(buildNgrokCredentials(apiKeys, authtokens))

  expect(validateCapabilityResult(result)).toEqual([])
  const rows = (result.datasets.find((d) => d.id === 'keys') as unknown as { rows: Record<string, unknown>[] }).rows

  expect(rows[0]).toMatchObject({
    name: 'API key · owner@example.com',
    masked: 'ak_38…V0tq',
    createdAt: '2026-01-13',
    status: 'active'
  })
  expect(rows[1]).toMatchObject({
    name: 'Auth token · member@example.com',
    masked: 'cr_3E…bZrb',
    status: 'revoked'
  })
})

test('keys result is valid on empty input', () => {
  expect(validateCapabilityResult(buildNgrokKeysResult([]))).toEqual([])
})

// --- members: team roster (active members + pending invitations) ---

const teamMembers: RawTeamMemberList = {
  teamMembers: [
    {
      id: { id: 'usr_1A2b3C' },
      email: 'owner@example.com',
      name: 'Owner Example',
      permissions: { isAdmin: true, team: 'TeamManage' },
      active: true
    },
    {
      id: { id: 'usr_4D5e6F' },
      email: 'dev@example.com',
      name: 'Dev Example',
      permissions: { isAdmin: false, team: 'TeamView' },
      active: true
    }
  ]
}

const invitations: RawInvitationList = {
  invitations: [
    {
      id: { id: 'inv_7G8h9I' },
      email: 'pending@example.com',
      membershipPermissions: { team: 'TeamView' },
      status: 'Pending'
    }
  ]
}

test('members map active roster to derived roles, then append pending invitations', () => {
  const { members } = buildNgrokMembers(teamMembers, invitations)

  expect(members).toEqual([
    { id: 'usr_1A2b3C', name: 'Owner Example', email: 'owner@example.com', role: 'Admin' },
    { id: 'usr_4D5e6F', name: 'Dev Example', email: 'dev@example.com', role: 'Member' },
    { id: 'inv_7G8h9I', name: undefined, email: 'pending@example.com', role: 'Pending' }
  ])
})

test('member role derives Admin from TeamManage even without isAdmin; falls back to id/email/index', () => {
  const { members } = buildNgrokMembers(
    { teamMembers: [{ email: 'mgr@example.com', permissions: { team: 'TeamManage' } }, { name: 'No Id' }] },
    null
  )

  // First: TeamManage → Admin, id falls back to email. Second: no id/email → index, default Member.
  expect(members[0]).toMatchObject({ id: 'mgr@example.com', role: 'Admin' })
  expect(members[1]).toMatchObject({ id: '1', name: 'No Id', email: undefined, role: 'Member' })
})

test('members tolerate empty input', () => {
  expect(buildNgrokMembers(null, null).members).toEqual([])
  expect(buildNgrokMembers({}, {}).members).toEqual([])
})

test('members result renders a valid members table', () => {
  expect(validateCapabilityResult(members.result(buildNgrokMembers(teamMembers, invitations)))).toEqual([])
})

test('ngrok exposes summary + billing + apiKeys + members capabilities', () => {
  expect(ngrokPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'apiKeys', 'members'])
})
