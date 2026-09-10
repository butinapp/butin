import type { RecordDataset, TableDataset } from '@butinapp/sdk/data'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { currentMonthKey } from '@butinapp/sdk/util'
import { describe, expect, it, test } from 'vitest'

import {
  buildBillingReport,
  buildDnsimpleAccessTokensResult,
  buildDnsimpleAccountResult,
  buildDnsimpleBillingResult,
  buildDnsimpleMembers,
  buildDnsimpleSummaryResult,
  dnsimplePlugin,
  hasNextPage,
  parseAccessTokens,
  parseAccountId,
  parseAccountProfile,
  parseApiLimits,
  parseDomains,
  parseInvoiceCount,
  parseInvoices,
  parsePlan
} from './main.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(dnsimplePlugin)).toEqual([])
})

// --- fixtures (dashboard HTML structure; account id + values fully synthetic) ---

const BILLING_HTML = `
<main class="three-col-grid">
  <section class="col">
    <div class="action-card">
      <h3>Teams plan</h3>
      <div class="action-card-container">
        <table>
          <tr><td class="pr4">DNS queries (at $0.10 / million)</td><td class="text-right">$0.10</td></tr>
          <tr><td class="pr4">1 × Teams (at $29.00 / month)</td><td class="text-right">$29.00</td></tr>
          <tr><td class="pr4">8 × Teams Active Zone (at $0.50 / month)</td><td class="text-right">$4.00</td></tr>
          <tr><td class="pr4">3 × Teams Extra Seat (at $29.00 / month)</td><td class="text-right">$87.00</td></tr>
          <tr><td colspan="2"><div class="table-separator"></div></td></tr>
          <tr>
            <td class="pr4">Total <em>(estimated)</em> due on <time datetime="2026-07-06" title="06 Jul 2026">Jul 06, 2026</time></td>
            <td class="text-right">$120.10</td>
          </tr>
        </table>
      </div>
    </div>
    <div class="action-card">
      <h3><span id="cc-brand-icon" class="cc-brand-mastercard mr2"></span><span>**** **** **** 5240</span></h3>
      <div class="action-card-container"><p><span>Expires 04/29</span></p></div>
    </div>
    <div class="action-card">
      <h3>Invoices</h3>
      <div class="action-card-container"><p>Last Invoice was $120.10 on <time datetime="2026-06-06">Jun 06, 2026</time></p></div>
    </div>
  </section>
</main>`

const invoiceRow = (id: string, date: string, items: number, summary: string, total: string, status = 'Collected') => `
<tr class="${status.toLowerCase()}">
  <td width="13%">${id}</td>
  <td width="13%"><time datetime="${date}" title="x">x</time></td>
  <td width="6%">${items}</td>
  <td width="34%" class="summary">${summary}</td>
  <td width="10%">${total}</td>
  <td class="state" width="12%">${status}</td>
  <td class="text-right"><a href="/a/00000/account/invoices/${id}/download">Download</a></td>
</tr>`

const invoicesPage = (rows: string, withNext: boolean, count = 162) => `
<table class="invoices-table model-table with-hover">
  <thead><tr><th>Invoice #</th><th>Date</th><th>Items</th><th>Summary</th><th>Total</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="text-centered">
  <span class="mr2">${count} invoices</span>
  <ul class="pagination-custom">
    <li class="page-item active"><span class="page-link">1</span></li>
    ${withNext ? '<li class="page-item next"><a class="page-link" rel="next" href="/a/00000/account/invoices?page=2">Next</a></li>' : ''}
  </ul>
</div>`

const PAGE_1 = invoicesPage(
  invoiceRow('3656932-00000', '2026-06-06', 4, 'Teams Plan Renewal (2026-06-06 t...)', '$120.10') +
    invoiceRow('3636758-00000', '2026-05-15', 1, 'Auto Renew example.app', '$22.50') +
    invoiceRow('3627804-00000', '2026-05-06', 4, 'Teams Plan Renewal (2026-05-06 t...)', '$120.10'),
  true
)

describe('parseInvoices', () => {
  it('extracts rows with ISO dates and dollar totals', () => {
    const rows = parseInvoices(PAGE_1)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      id: '3656932-00000',
      date: '2026-06-06',
      items: 4,
      summary: 'Teams Plan Renewal (2026-06-06 t...)',
      amount: 120.1,
      status: 'collected'
    })
    expect(rows[1]!.amount).toBe(22.5)
  })

  it('returns [] when there is no invoices table', () => {
    expect(parseInvoices('<div>nope</div>')).toEqual([])
  })
})

describe('parseInvoiceCount / hasNextPage', () => {
  it('reads the total count from the footer', () => {
    expect(parseInvoiceCount(PAGE_1)).toBe(162)
  })

  it('detects the next-page link', () => {
    expect(hasNextPage(PAGE_1)).toBe(true)
    expect(hasNextPage(invoicesPage(invoiceRow('1-1', '2025-01-01', 1, 'x', '$1.00'), false))).toBe(false)
  })
})

describe('parsePlan', () => {
  it('extracts plan name, line items, estimated next, and card', () => {
    const plan = parsePlan(BILLING_HTML)

    expect(plan.planName).toBe('Teams plan')
    expect(plan.lineItems).toHaveLength(4)
    expect(plan.lineItems[1]).toEqual({ label: '1 × Teams (at $29.00 / month)', amount: 29 })
    expect(plan.estimatedNext).toBe(120.1)
    expect(plan.estimatedNextDate).toBe('2026-07-06')
    expect(plan.cardBrand).toBe('mastercard')
    expect(plan.cardLast4).toBe('5240')
    expect(plan.cardExpiry).toBe('04/29')
  })

  it('degrades to safe defaults on empty HTML', () => {
    const plan = parsePlan('')

    expect(plan.planName).toBe('Unknown')
    expect(plan.lineItems).toEqual([])
    expect(plan.estimatedNext).toBe(0)
    expect(plan.cardBrand).toBe('unknown')
  })
})

describe('buildBillingReport', () => {
  it('assembles a fully-shaped report (dollars), newest first', () => {
    const report = buildBillingReport(BILLING_HTML, [PAGE_1])

    expect(report.planName).toBe('Teams plan')
    expect(report.estimatedNext).toBe(120.1)
    expect(report.invoices).toHaveLength(3)
    expect(report.invoices[0]!.date).toBe('2026-06-06')
    expect(report.latestAmount).toBe(120.1)
    expect(report.trailing12moTotal).toBe(262.7) // 120.10 + 22.50 + 120.10
    expect(report.invoiceCount).toBe(162)
  })

  it('merges multiple invoice pages', () => {
    const page2 = invoicesPage(invoiceRow('3600000-00000', '2025-08-06', 4, 'Teams Plan Renewal', '$59.70'), false)
    const report = buildBillingReport(BILLING_HTML, [PAGE_1, page2])

    expect(report.invoices).toHaveLength(4)
    expect(report.invoices.at(-1)!.id).toBe('3600000-00000')
  })

  it('never throws on empty input — returns zeroed report', () => {
    const report = buildBillingReport('', [])

    expect(report.invoices).toEqual([])
    expect(report.latestAmount).toBe(0)
    expect(report.trailing12moTotal).toBe(0)
    expect(report.invoiceCount).toBe(0)
    expect(report.planName).toBe('Unknown')
  })
})

describe('buildDnsimpleSummaryResult', () => {
  it('emits plan / latest / trailing-12mo / count stats + the monthly-spend chart', () => {
    const report = buildBillingReport(BILLING_HTML, [PAGE_1])
    const result = buildDnsimpleSummaryResult(report)

    const account = result.datasets.find((d) => d.id === 'account') as RecordDataset

    expect(account.shape).toBe('record')
    expect(account.value.plan).toBe('Teams plan')
    expect(account.value.latest).toBe(120.1)
    expect(account.value.trailing12mo).toBe(262.7)
    expect(account.value.estimatedNext).toBe(120.1)
    expect(account.value.invoiceCount).toBe(162)

    const monthly = result.datasets.find((d) => d.id === 'monthly') as TableDataset

    expect(monthly.shape).toBe('table')
    // Two distinct months in the fixture (2026-05, 2026-06), ascending.
    expect(monthly.rows.map((r) => r.month)).toEqual(['2026-05', '2026-06'])
  })

  it('emits a spend.mtd summary only when the current month has invoices', () => {
    // An invoice dated in the current month → currentMtd is a number → spend.mtd summary present.
    const ym = currentMonthKey()
    const current = buildBillingReport(BILLING_HTML, [
      invoicesPage(invoiceRow('9000000-00000', `${ym}-10`, 1, 'This month', '$42.00'), false)
    ])
    const withMtd = buildDnsimpleSummaryResult(current)

    expect(withMtd.summaries?.[0]?.section).toBe('spend')
    expect(withMtd.summaries?.[0]?.basis).toBe('invoiced')
    expect(withMtd.summaries?.[0]?.value).toBe(42)

    // No invoice in the current month → null currentMtd → no summary (Overview skips it rather than charting 0).
    const stale = buildBillingReport(BILLING_HTML, [
      invoicesPage(invoiceRow('8000000-00000', '2020-01-10', 1, 'Old', '$10.00'), false)
    ])

    expect(buildDnsimpleSummaryResult(stale).summaries).toBeUndefined()
  })

  it('handles an empty report without throwing', () => {
    const result = buildDnsimpleSummaryResult(buildBillingReport('', []))
    const account = result.datasets.find((d) => d.id === 'account') as RecordDataset

    expect(account.value.plan).toBe('Unknown')
    expect(account.value.invoiceCount).toBe(0)
    expect(result.summaries).toBeUndefined()
  })
})

describe('buildDnsimpleBillingResult', () => {
  it('builds an invoices table with id/date/summary/amount/status (no download link)', () => {
    const report = buildBillingReport(BILLING_HTML, [PAGE_1])
    const result = buildDnsimpleBillingResult(report)

    const invoices = result.datasets.find((d) => d.id === 'invoices') as TableDataset

    expect(invoices.shape).toBe('table')
    expect(invoices.columns.map((c) => c.key)).toEqual(['id', 'date', 'summary', 'amount', 'status'])
    // No url-role column → no surfaced download link (CSRF form POST can't be a plain GET).
    expect(invoices.columns.some((c) => c.role === 'url')).toBe(false)
    expect(invoices.rows[0]).toMatchObject({
      id: '3656932-00000',
      date: '2026-06-06',
      amount: 120.1,
      status: 'collected'
    })

    const amountCol = invoices.columns.find((c) => c.key === 'amount')

    expect(amountCol?.role).toBe('money')
    expect(amountCol?.currency).toBe('USD')
    // Keyed by the invoice number so invoices accumulate their history in the ledger.
    expect(invoices.key).toBe('id')
  })

  it('renders the estimated-next-charge line items + total as a keyvalue record', () => {
    const result = buildDnsimpleBillingResult(buildBillingReport(BILLING_HTML, [PAGE_1]))
    const est = result.datasets.find((d) => d.id === 'estimatedNext') as RecordDataset

    expect(est.shape).toBe('record')
    expect(est.value['1 × Teams (at $29.00 / month)']).toBe(29)
    expect(est.value.__total).toBe(120.1)
    expect(result.views?.some((v) => v.type === 'keyvalue' && v.dataset === 'estimatedNext')).toBe(true)
  })

  it('renders the payment method as a record', () => {
    const result = buildDnsimpleBillingResult(buildBillingReport(BILLING_HTML, [PAGE_1]))
    const pm = result.datasets.find((d) => d.id === 'paymentMethod') as RecordDataset

    expect(pm.value.cardBrand).toBe('mastercard')
    expect(pm.value.cardLast4).toBe('5240')
    expect(pm.value.cardExpiry).toBe('04/29')
  })

  it('omits the estimatedNext + paymentMethod records on an empty report', () => {
    const result = buildDnsimpleBillingResult(buildBillingReport('', []))

    expect(result.datasets.find((d) => d.id === 'estimatedNext')).toBeUndefined()
    expect(result.datasets.find((d) => d.id === 'paymentMethod')).toBeUndefined()
    const invoices = result.datasets.find((d) => d.id === 'invoices') as TableDataset

    expect(invoices.rows).toEqual([])
  })
})

// --- members fixture (account members page HTML structure; all values fully synthetic) ---

const memberRow = (id: string, name: string, email: string, role: string) => `
<tr data-member-id="${id}">
  <td><span class="member-name">${name}</span></td>
  <td><span class="member-email">${email}</span></td>
  <td><span class="member-role">${role}</span></td>
</tr>`

const MEMBERS_HTML = `
<table class="members-table model-table">
  <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
  <tbody>
    ${memberRow('501', 'Ada Placeholder', 'ada@example.com', 'Owner')}
    ${memberRow('502', 'Grace Placeholder', 'grace@example.com', 'Member')}
    <tr><td colspan="3"><div class="spacer"></div></td></tr>
  </tbody>
</table>`

describe('buildDnsimpleMembers', () => {
  it('maps the members table rows to id/name/email/role', () => {
    const { members } = buildDnsimpleMembers(MEMBERS_HTML)

    expect(members).toHaveLength(2)
    expect(members[0]).toEqual({ id: '501', name: 'Ada Placeholder', email: 'ada@example.com', role: 'Owner' })
    expect(members[1]).toEqual({ id: '502', name: 'Grace Placeholder', email: 'grace@example.com', role: 'Member' })
  })

  it('falls back to the email then the row index when no data-member-id is present', () => {
    const html = `
      <table class="members-table">
        <tbody>
          <tr><td><span class="member-name">No Id</span></td><td><span class="member-email">noid@example.com</span></td><td><span class="member-role">Member</span></td></tr>
          <tr><td><span class="member-name">No Email</span></td><td><span class="member-email"></span></td><td><span class="member-role">Member</span></td></tr>
        </tbody>
      </table>`
    const { members } = buildDnsimpleMembers(html)

    expect(members).toHaveLength(2)
    expect(members[0]!.id).toBe('noid@example.com')
    // Second row has no id and no email → stable fall-back to the row index.
    expect(members[1]!.id).toBe('1')
    expect(members[1]!.email).toBeUndefined()
  })

  it('returns [] on empty / table-less HTML', () => {
    expect(buildDnsimpleMembers('').members).toEqual([])
    expect(buildDnsimpleMembers('<div>nope</div>').members).toEqual([])
  })
})

describe('parseAccountId', () => {
  // The page chrome carries the current account id everywhere; another account shows up only in the switcher.
  const CHROME_HTML = `
    <a href="/dashboard?account_id=78774">Dashboard</a>
    <a href="/a/78774/domain_names">Domains</a>
    <a href="/a/78774/account">Settings</a>
    <a href="/logout?account_id=78774&t=abc">Log out</a>
    <a href="/user?account_id=78774">Profile</a>
    <div class="account-switcher">
      <a href="/a/165249/domain_names">Account 165249</a>
      <a href="/a/165249/account">settings</a>
    </div>`

  it('returns the most-mentioned account id (the current account, not a switcher entry)', () => {
    expect(parseAccountId(CHROME_HTML)).toBe('78774')
  })

  it('reads it from a query param alone', () => {
    expect(parseAccountId('<a href="/dashboard?account_id=999111">x</a>')).toBe('999111')
  })

  it('returns undefined when no account id is present', () => {
    expect(parseAccountId('<div>no account here</div>')).toBeUndefined()
    expect(parseAccountId('')).toBeUndefined()
  })
})

// --- domains fixture (best-effort against DNSimple's model-table structure; values synthetic) ---

const DOMAINS_HTML = `
<table class="model-table with-hover domains-table">
  <tbody>
    <tr>
      <td><a href="/a/00000/domains/example.com">example.com</a></td>
      <td><span class="status">Registered</span></td>
      <td><time datetime="2027-03-15">Mar 15, 2027</time></td>
      <td>Auto-renew on</td>
    </tr>
    <tr>
      <td><a href="/a/00000/domains/example.org">example.org</a></td>
      <td><span class="status">Hosted</span></td>
      <td></td>
      <td></td>
    </tr>
    <tr>
      <td><a href="/a/00000/domains/example.com/dns_records">Records</a></td>
    </tr>
  </tbody>
</table>`

describe('parseDomains', () => {
  it('extracts domain name, status, expiry, and auto-renew (newest sub-resource links ignored)', () => {
    const domains = parseDomains(DOMAINS_HTML)

    expect(domains).toEqual([
      { name: 'example.com', status: 'registered', expiresOn: '2027-03-15', autoRenew: true },
      { name: 'example.org', status: 'hosted', expiresOn: undefined, autoRenew: false }
    ])
  })

  it('returns [] when there are no domains', () => {
    expect(parseDomains('<div>no domains</div>')).toEqual([])
    expect(parseDomains('')).toEqual([])
  })
})

// --- account profile fixture (mirrors the General page's action-card structure; values synthetic) ---

const ACCOUNT_HTML = `
<section class="col">
  <div class="action-card">
    <h3>Account</h3>
    <table>
      <tr><td class="pr3">Name</td><td>Acme, Inc</td></tr>
      <tr><td>Notification email</td><td>ops@example.com</td></tr>
      <tr><td class="pr3">Account Identifier</td><td> 019a5ef4-ffd9-72aa-b528-b957c2d9b754 <a href="#"><span class="icon-question"></span></a></td></tr>
    </table>
    <p class="b mt2 mb0">Location</p>
    <div class="action-card-container"><table><tr><td class="pr3">Country</td><td>Canada</td></tr></table></div>
  </div>
  <div class="action-card">
    <h3>Notifications</h3>
    <p class="b mt2 mb0">Account notifications will be sent to:</p>
    <p>ops@example.com</p>
    <p class="b mt2 mb0">Billing notifications will be sent to:</p>
    <p>billing@example.com</p>
  </div>
</section>`

describe('parseAccountProfile', () => {
  it('reads name, identifier, country, and notification + billing emails', () => {
    expect(parseAccountProfile(ACCOUNT_HTML)).toEqual({
      name: 'Acme, Inc',
      identifier: '019a5ef4-ffd9-72aa-b528-b957c2d9b754',
      country: 'Canada',
      notificationEmail: 'ops@example.com',
      billingEmail: 'billing@example.com'
    })
  })

  it('degrades to all-undefined on empty HTML', () => {
    expect(parseAccountProfile('')).toEqual({
      name: undefined,
      identifier: undefined,
      country: undefined,
      notificationEmail: undefined,
      billingEmail: undefined
    })
  })

  it('renders the account record (missing fields → null) + the domains table and header', () => {
    // today = 2027-02-01 → example.com (expires 2027-03-15) is within 60 days; example.org has no expiry.
    const result = buildDnsimpleAccountResult({ name: 'Acme, Inc' }, parseDomains(DOMAINS_HTML), '2027-02-01')

    expect(validateCapabilityResult(result)).toEqual([])

    const account = result.datasets.find((d) => d.id === 'account') as RecordDataset

    expect(account.value.name).toBe('Acme, Inc')
    expect(account.value.country).toBeNull()

    const header = result.datasets.find((d) => d.id === 'domainsHeader') as RecordDataset

    expect(header.value).toEqual({ total: 2, expiring: 1 })

    const domains = result.datasets.find((d) => d.id === 'domains') as TableDataset

    expect(domains.rows.map((r) => r.name)).toEqual(['example.com', 'example.org'])
    expect(domains.rows[0]).toMatchObject({ status: 'registered', expiresOn: '2027-03-15', autoRenew: 'On' })
    // Keyed by the domain name so each domain accumulates its status/expiry history in the ledger.
    expect(domains.key).toBe('name')
  })

  it('omits the domains header + table when the account has no domains', () => {
    const result = buildDnsimpleAccountResult({ name: 'Acme, Inc' }, [])

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.map((d) => d.id)).toEqual(['account'])
  })
})

// --- api tokens fixture (API limits grid + a synthetic access-token row) ---

const API_TOKENS_HTML = `
<div class="action-card">
  <h3>API Limits &amp; Usage</h3>
  <div class="three-col-grid">
    <div class="col-third"><strong>2,400</strong> requests/hour limit</div>
    <div class="col-third"><strong>2,350</strong> requests remaining</div>
    <div class="col-third"><strong><time datetime="2026-06-17T23:45:17.000Z">1h</time></strong> limit reset</div>
  </div>
</div>
<div class="action-card">
  <h3>Access tokens</h3>
  <table class="model-table with-hover">
    <tbody>
      <tr><td>CI deploy token</td><td><time datetime="2025-01-02">Jan 02, 2025</time></td><td><time datetime="2026-06-01">Jun 01, 2026</time></td></tr>
    </tbody>
  </table>
</div>`

describe('parseApiLimits / parseAccessTokens', () => {
  it('reads the rate-limit window', () => {
    expect(parseApiLimits(API_TOKENS_HTML)).toEqual({
      limit: 2400,
      remaining: 2350,
      resetAt: '2026-06-17T23:45:17.000Z'
    })
  })

  it('returns null when the limits card is absent', () => {
    expect(parseApiLimits('<div>nope</div>')).toBeNull()
  })

  it('extracts access-token rows (name + created + last-used days)', () => {
    expect(parseAccessTokens(API_TOKENS_HTML)).toEqual([
      { name: 'CI deploy token', created: '2025-01-02', lastUsed: '2026-06-01' }
    ])
  })

  it('returns [] when the account has no access tokens', () => {
    const empty = '<div class="action-card"><h3>Access tokens</h3><table><tbody></tbody></table></div>'

    expect(parseAccessTokens(empty)).toEqual([])
  })

  it('builds the limits stat + tokens table', () => {
    const result = buildDnsimpleAccessTokensResult(parseAccessTokens(API_TOKENS_HTML), parseApiLimits(API_TOKENS_HTML))

    expect(validateCapabilityResult(result)).toEqual([])

    const limits = result.datasets.find((d) => d.id === 'apiLimits') as RecordDataset

    expect(limits.value).toMatchObject({ limit: 2400, remaining: 2350 })

    const tokens = result.datasets.find((d) => d.id === 'tokens') as TableDataset

    expect(tokens.rows[0]).toMatchObject({ name: 'CI deploy token' })
    // Keyed by the token name so each token's last-used history accumulates in the ledger.
    expect(tokens.key).toBe('name')
  })
})

describe('capabilities', () => {
  it('exposes the tabs in order (domains live on the Account tab; no name server sets)', () => {
    expect(dnsimplePlugin.capabilities.map((c) => c.id)).toEqual([
      'summary',
      'billing',
      'members',
      'access_tokens',
      'account'
    ])
  })
})

describe('session', () => {
  it('prefills the account id from the dashboard URL', () => {
    expect(dnsimplePlugin.session?.captureFromUrl).toContainEqual({ pattern: '/a/(\\d+)', storeAs: 'accountId' })
  })

  // Google sign-in is omniauth; the OAuth state rides the Rails `_dnsimple_session` cookie, so a stale one must
  // be cleared before each capture or the callback's state check fails and login lands back on the login page.
  it('clears the omniauth state cookie before capture', () => {
    expect(dnsimplePlugin.session?.clearCookiesBeforeCapture).toContain('_dnsimple_session')
  })
})
