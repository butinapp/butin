import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, members, type MemberInput, type MembersInput } from '@butinapp/sdk/presets'
import { byDayDesc, dayMinus, isoDay, parseDollarAmount, round2, squish, utcDaysAgo } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import {
  sampleDnsimpleAccount,
  sampleDnsimpleApiTokens,
  sampleDnsimpleBilling,
  sampleDnsimpleMembers
} from './sample.js'

// DNSimple (dnsimple.com) — DNS / domain registrar. The account dashboard is server-rendered Rails HTML
// with NO JSON billing API, so every capability scrapes the HTML with cheerio.
//
// AUTH is a plain cookie session — the `_dnsimple_session` Rails cookie, replayed verbatim (no
// minting/rotation), cleared on 401 only (core's default; a 403 is a per-route permission, not a dead
// session).
//
// TRANSPORT: dnsimple.com is fronted by plain nginx (NO Cloudflare), so Node's TLS fingerprint is accepted
// — plain `node` transport (NOT requiresBrowserEngine). GET-only document loads.
//
// ACCOUNT: every dashboard path is keyed by a numeric account id (`/a/<id>/…`). The login URL doesn't carry it,
// so it's scraped from the session's own dashboard chrome (the current account id is rendered throughout the
// nav as `/a/<id>/` paths + `?account_id=<id>` query params); an optional Settings field overrides it to pick a
// non-default account.
//
// MONEY is already DOLLARS, scraped from `$120.10` strings (no cents conversion). USD throughout.
//
// MEMBERS: the same dashboard cookie reaches the server-rendered account members page
// (`/a/<accountId>/account/members`), so the roster is scraped with cheerio — no separate `api.dnsimple.com`
// v2 token needed for a read-only list.

const ORIGIN = 'https://dnsimple.com'
const CURRENCY = 'USD'

// How many invoice pages to walk at most (20 rows/page → ~260 invoices).
const MAX_INVOICE_PAGES = 13
// Stop paginating once the oldest fetched invoice is this many months back.
const HISTORY_MONTHS = 13

// ── types (the data dictionary) ──────────────────────────────────────────────────────

export interface DnsimpleInvoice {
  /** Invoice number, e.g. `3656932-00000`. */
  id: string
  /** 'YYYY-MM-DD' (UTC) from the row's `<time datetime>`. */
  date?: string
  /** Number of line items on the invoice. */
  items: number
  /** Short summary of what was billed, e.g. "Teams Plan Renewal (…)". */
  summary: string
  /** Grand total, USD dollars. */
  amount: number
  /** Lower-cased status, e.g. `collected`. */
  status: string
}

/** One line of the current plan's estimated next charge. */
export interface DnsimpleLineItem {
  label: string
  amount: number
}

export interface DnsimpleBillingReport {
  /** Current plan name, e.g. "Teams plan". */
  planName: string
  /** Per-line breakdown of the estimated next charge (dollars). */
  lineItems: DnsimpleLineItem[]
  /** Estimated next charge total, dollars. */
  estimatedNext: number
  /** Date the next charge is due, 'YYYY-MM-DD'. */
  estimatedNextDate?: string
  /** Payment-method card brand, e.g. "mastercard" (or 'unknown'). */
  cardBrand: string
  /** Last 4 digits of the payment card, or ''. */
  cardLast4: string
  /** Card expiry as shown, e.g. "04/29", or ''. */
  cardExpiry: string
  /** Invoice history (most recent first), dollars. */
  invoices: DnsimpleInvoice[]
  /** Most recent invoice total, dollars. */
  latestAmount: number
  /** Sum of invoice totals in the trailing 12 calendar months, dollars. */
  trailing12moTotal: number
  /** Total number of invoices on the account (from the pagination footer). */
  invoiceCount: number
}

// ── raw wire shapes (what each capability's fetch returns; build* parses them) ──────────

/** The billing page HTML + the walked invoice-page HTMLs — the raw both the Summary and Billing tabs build from. */
export interface DnsimpleBillingRaw {
  billingHtml: string
  invoicePagesHtml: string[]
}

/** The General page HTML + the domain-list HTML — the raw the Account tab builds from. */
export interface DnsimpleAccountRaw {
  accountHtml: string
  domainsHtml: string
}

// ── shared parsers ───────────────────────────────────────────────────────────────────

/** Scrape the invoice rows out of one invoices-page HTML. Cell order: [number, date, items, summary, total, status, actions]. */
export const parseInvoices = (html: string): DnsimpleInvoice[] => {
  const $ = cheerio.load(html)
  const invoices: DnsimpleInvoice[] = []

  $('table.invoices-table tbody tr').each((_, row) => {
    const cells = $(row).find('td')
    const id = cells.eq(0).text().trim()

    if (!id) {
      return
    }

    const date = cells.eq(1).find('time').attr('datetime')?.trim() || undefined
    const items = parseInt(cells.eq(2).text().trim(), 10) || 0
    const summary = squish(cells.eq(3).text())
    const amount = parseDollarAmount(cells.eq(4).text().trim())
    const status = cells.eq(5).text().trim().toLowerCase() || 'unknown'

    invoices.push({ id, date, items, summary, amount, status })
  })

  return invoices
}

/** Total invoice count from the "162 invoices" pagination footer (0 if absent). */
export const parseInvoiceCount = (html: string): number => {
  const m = html.match(/([\d,]+)\s+invoices?/i)

  return m ? parseInt(m[1]!.replace(/,/g, ''), 10) || 0 : 0
}

/** Whether the invoices page has a "Next" page link. */
export const hasNextPage = (html: string): boolean => /rel="next"/.test(html)

// Every authed page renders the current account id throughout its chrome — as `/a/<id>/…` nav paths and as
// `?account_id=<id>` query params on the global links (logout, user, contact, …). Other accounts the user can
// reach appear only once or twice in the account switcher, so the most frequent id is the current account.
const ACCOUNT_ID_RE = /(?:\/a\/|account_id=)(\d+)/g

/** Scrape the current account id from any authed page's chrome (the most-mentioned `/a/<id>/` | `account_id=<id>`). */
export const parseAccountId = (html: string): string | undefined => {
  const counts = new Map<string, number>()

  for (const m of (html || '').matchAll(ACCOUNT_ID_RE)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
  }

  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** Scrape the current-plan card (name, line items, estimated next charge) and the payment-method card. */
export const parsePlan = (
  html: string
): {
  planName: string
  lineItems: DnsimpleLineItem[]
  estimatedNext: number
  estimatedNextDate?: string
  cardBrand: string
  cardLast4: string
  cardExpiry: string
} => {
  const $ = cheerio.load(html)
  const cards = $('.action-card')

  // First action-card is the plan card: <h3>Plan name</h3> + a table whose rows are [label, amount], the
  // final row being "Total (estimated) due on <time>".
  const planCard = cards.first()
  const planName = planCard.find('h3').first().text().trim() || 'Unknown'

  const lineItems: DnsimpleLineItem[] = []
  let estimatedNext = 0
  let estimatedNextDate: string | undefined

  planCard.find('table tr').each((_, tr) => {
    const tds = $(tr).find('td')

    if (tds.length < 2) {
      return
    }

    const label = squish(tds.eq(0).text())
    const amount = parseDollarAmount(tds.eq(1).text().trim())

    if (!label) {
      return
    }

    if (/total/i.test(label)) {
      estimatedNext = amount
      estimatedNextDate = tds.eq(0).find('time').attr('datetime')?.trim() || undefined
    } else {
      lineItems.push({ label, amount })
    }
  })

  // Payment-method card: an <h3> with a `cc-brand-<brand>` icon + masked number.
  let cardBrand = 'unknown'
  let cardLast4 = ''
  let cardExpiry = ''

  cards.each((_, card) => {
    const $card = $(card)
    const brandClass = $card.find('[class*="cc-brand-"]').attr('class')

    if (!brandClass) {
      return undefined
    }

    const bm = brandClass.match(/cc-brand-([a-z]+)/i)

    cardBrand = bm ? bm[1]! : 'unknown'

    const numText = $card.find('h3').text()
    const last4 = numText.match(/(\d{4})\s*$/)

    cardLast4 = last4 ? last4[1]! : ''

    const exp = $card.text().match(/Expires\s+([\d/]+)/i)

    cardExpiry = exp ? exp[1]! : ''

    return false // first matching card only
  })

  return { planName, lineItems, estimatedNext, estimatedNextDate, cardBrand, cardLast4, cardExpiry }
}

/** 'YYYY-MM' shifted back `count` months. */
const monthsBefore = (yearMonth: string, count: number): string => {
  const [y, m] = yearMonth.split('-').map(Number)
  const zeroBased = y! * 12 + (m! - 1) - count

  return `${String(Math.floor(zeroBased / 12)).padStart(4, '0')}-${String((zeroBased % 12) + 1).padStart(2, '0')}`
}

/** Pure: assemble the report from the billing-page HTML and the invoice-page HTMLs. Always returns a
 * fully-shaped object with safe defaults so a shape drift degrades to zeros rather than crashing. */
export const buildBillingReport = (billingHtml: string, invoicePagesHtml: string[]): DnsimpleBillingReport => {
  const plan = parsePlan(billingHtml || '')

  const invoices = invoicePagesHtml.flatMap((html) => parseInvoices(html || ''))

  invoices.sort(byDayDesc)

  const latest = invoices[0]
  let trailing12moTotal = 0

  if (latest?.date) {
    const cutoff = monthsBefore(latest.date.slice(0, 7), 11)

    trailing12moTotal = invoices
      .filter((inv) => inv.date && inv.date.slice(0, 7) >= cutoff)
      .reduce((sum, inv) => sum + inv.amount, 0)
  }

  const invoiceCount = invoicePagesHtml.reduce((max, html) => Math.max(max, parseInvoiceCount(html || '')), 0)

  return {
    planName: plan.planName,
    lineItems: plan.lineItems,
    estimatedNext: plan.estimatedNext,
    estimatedNextDate: plan.estimatedNextDate,
    cardBrand: plan.cardBrand,
    cardLast4: plan.cardLast4,
    cardExpiry: plan.cardExpiry,
    invoices,
    latestAmount: latest?.amount ?? 0,
    trailing12moTotal: round2(trailing12moTotal),
    invoiceCount: invoiceCount || invoices.length
  }
}

// ── Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ─────────
// The current calendar month's invoiced total is the closest thing to month-to-date spend (the Overview rolls
// it up); a quiet month with no invoice reads as null so the Overview skips DNSimple rather than charting 0.
export const buildDnsimpleSummaryResult = (report: DnsimpleBillingReport): CapabilityResult => {
  const mtd = billing.invoicedMtd(report.invoices)

  return billing.summary({
    currentMtd: mtd > 0 ? mtd : null,
    // Sum of the current calendar month's issued invoices.
    mtdBasis: 'invoiced',
    currency: CURRENCY,
    invoices: report.invoices.map((i) => ({ date: i.date, amount: i.amount, status: i.status })),
    stats: [
      { key: 'plan', label: 'Plan', role: 'label', value: report.planName },
      {
        key: 'estimatedNext',
        label: 'Est. next charge',
        role: 'money',
        value: report.estimatedNext,
        currency: CURRENCY
      },
      { key: 'latest', label: 'Latest invoice', role: 'money', value: report.latestAmount, currency: CURRENCY },
      {
        key: 'trailing12mo',
        label: 'Trailing 12 mo',
        role: 'money',
        value: report.trailing12moTotal,
        currency: CURRENCY
      },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoiceCount }
    ]
  })
}

// ── Billing tab (invoice history + est-next-charge breakdown + payment method) ─────────
// The per-invoice download is a CSRF-protected form POST (not a plain GET), so it is NOT surfaced as a
// downloadable link — it wouldn't resolve outside the authenticated Electron partition.

interface DnsimpleInvoiceRow {
  id: string | null
  date: string | null
  summary: string | null
  amount: number
  status: string | null
}

interface DnsimplePaymentMethodRow {
  cardBrand: string | null
  cardLast4: string | null
  cardExpiry: string | null
}

export const buildDnsimpleBillingResult = (report: DnsimpleBillingReport): CapabilityResult => {
  const invoices = table<DnsimpleInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'id', label: 'Invoice #', role: 'identifier' },
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'summary', label: 'Summary', role: 'text' },
      { key: 'amount', label: 'Total', role: 'money', currency: CURRENCY },
      { key: 'status', label: 'Status', role: 'status' }
    ],
    rows: report.invoices.map((i) => ({
      id: i.id,
      date: i.date ?? null,
      summary: i.summary || null,
      amount: i.amount,
      status: i.status
    })),
    // The invoice number is the stable identity — key it so invoices accumulate their status/amount history in
    // the ledger past the fetch window. An unkeyed table carries no history.
    key: 'id'
  })

  // The estimated-next-charge line items render as a keyvalue (label → amount), plus the total row.
  // Fields are built dynamically from line-item labels, so the Row type is an open string-keyed record
  // and the typed builder is cast at the call site.
  let estimatedNext = null

  if (report.lineItems.length > 0 || report.estimatedNext > 0) {
    const fields = report.lineItems.map((li) => ({
      key: li.label,
      label: li.label,
      role: 'money' as const,
      currency: CURRENCY
    }))
    const value: Record<string, unknown> = {}

    for (const li of report.lineItems) {
      value[li.label] = li.amount
    }

    fields.push({ key: '__total', label: 'Total (estimated)', role: 'money', currency: CURRENCY })
    value.__total = report.estimatedNext

    estimatedNext = record<Record<string, unknown>>({
      id: 'estimatedNext',
      fields: fields as never,
      value
    })
  }

  // Payment method as a small record.
  let paymentMethod = null

  if (report.cardLast4 || report.cardBrand !== 'unknown') {
    paymentMethod = record<DnsimplePaymentMethodRow>({
      id: 'paymentMethod',
      fields: [
        { key: 'cardBrand', label: 'Card', role: 'label' },
        { key: 'cardLast4', label: 'Last 4', role: 'identifier' },
        { key: 'cardExpiry', label: 'Expires', role: 'text' }
      ],
      value: {
        cardBrand: report.cardBrand !== 'unknown' ? report.cardBrand : null,
        cardLast4: report.cardLast4 || null,
        cardExpiry: report.cardExpiry || null
      }
    })
  }

  return capabilityResult({
    sections: [
      invoices.table({ title: 'Invoices' }),
      estimatedNext?.keyvalue({ title: 'Estimated next charge' }),
      paymentMethod?.keyvalue({ title: 'Payment method' })
    ]
  })
}

// ── Members tab (the account member roster, scraped from the dashboard members page) ──────
// The account members page (`/a/<id>/account/members`) is a server-rendered Rails table of the people who
// have access to the account. Each row carries a name, an email, and a role label. Pure transform —
// fixture-tested. Degrades to [] on a shape drift rather than throwing.
export const buildDnsimpleMembers = (html: string): MembersInput => {
  const $ = cheerio.load(html || '')
  const members: MemberInput[] = []

  $('table.members-table tbody tr').each((index, row) => {
    const $row = $(row)
    const name = squish($row.find('.member-name').first().text())
    const email = $row.find('.member-email').first().text().trim()
    const role = squish($row.find('.member-role').first().text())

    // A row with nothing identifying is a layout artefact (spacer/empty state) — skip it.
    if (!name && !email) {
      return
    }

    // Stable id: the row's own data-member-id when present, else the email, else the row index.
    const id = $row.attr('data-member-id')?.trim() || email || String(index)

    members.push({ id, name: name || undefined, email: email || undefined, role: role || undefined })
  })

  return { members }
}

// ── Domains (the account's registered / hosted domains — rendered on the Account tab) ──────
// The domain list at `/a/<id>/domain_names` is server-rendered: each domain links to its detail page, with an
// expiry `<time datetime>` and a status label in the same row. Pure transform — fixture-tested, tolerant of an
// empty list / shape drift (returns []). The row selectors are best-effort against DNSimple's `model-table`
// structure; confirm them against a live account on first run.

export interface DnsimpleDomain {
  name: string
  status: string
  /** 'YYYY-MM-DD' registry expiry, when shown. */
  expiresOn?: string
  autoRenew: boolean
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export const parseDomains = (html: string): DnsimpleDomain[] => {
  const $ = cheerio.load(html || '')
  const domains: DnsimpleDomain[] = []
  const seen = new Set<string>()

  // A domain row is anchored by its detail link (`…/domains/<name>`); the surrounding row carries the expiry +
  // status. Keying off the link survives a table-vs-card layout and skips sub-resource links (records, etc.).
  $('a[href*="/domains/"]').each((_, a) => {
    const href = $(a).attr('href') ?? ''
    const name = decodeURIComponent(href.match(/\/domains\/([^/?#]+)/)?.[1] ?? '').toLowerCase()

    if (!DOMAIN_RE.test(name) || seen.has(name)) {
      return
    }

    seen.add(name)

    const row = $(a).closest('tr, li, .domain, .card, .model-row')
    const expiresOn = isoDay(row.find('time[datetime]').first().attr('datetime'))
    const status = squish(row.find('.status, .badge, [class*="status"]').first().text())

    domains.push({
      name,
      status: status.toLowerCase() || 'registered',
      expiresOn,
      autoRenew: /auto[\s-]?renew/i.test(row.text())
    })
  })

  return domains.sort((a, b) => a.name.localeCompare(b.name))
}

interface DnsimpleDomainRow {
  name: string
  status: string
  expiresOn: string | null
  autoRenew: string
}

// ── Account tab (the account profile + the account's domains) ──────────────────────────────
// The General page (`/a/<id>/account`) renders label→value <tr> pairs in its action-cards; the billing-
// notification address sits as the <p> after its bold label in the Notifications card. Pure — fixture-tested.

export interface DnsimpleAccountProfile {
  name?: string
  identifier?: string
  country?: string
  notificationEmail?: string
  billingEmail?: string
}

export const parseAccountProfile = (html: string): DnsimpleAccountProfile => {
  const $ = cheerio.load(html || '')
  const rows = new Map<string, string>()

  $('.action-card table tr').each((_, tr) => {
    const tds = $(tr).find('td')

    if (tds.length < 2) {
      return
    }

    const label = squish(tds.eq(0).text()).toLowerCase()
    const value = squish(tds.eq(1).text())

    if (label && value && !rows.has(label)) {
      rows.set(label, value)
    }
  })

  // The Notifications card lists account + billing addresses as the <p> following each bold label.
  let billingEmail: string | undefined

  $('.action-card').each((_, card) => {
    const ps = $(card)
      .find('p')
      .toArray()
      .map((p) => squish($(p).text()))
    const i = ps.findIndex((t) => /billing notifications will be sent to/i.test(t))

    if (i >= 0 && ps[i + 1]) {
      billingEmail = ps[i + 1]

      return false
    }

    return undefined
  })

  return {
    name: rows.get('name'),
    identifier: rows.get('account identifier'),
    country: rows.get('country'),
    notificationEmail: rows.get('notification email'),
    billingEmail
  }
}

// The Account tab: the profile keyvalue, a domains header (total + expiring-soon counts), and the domains
// table. `today` is injectable for deterministic expiring-soon tests.
export const buildDnsimpleAccountResult = (
  profile: DnsimpleAccountProfile,
  domains: DnsimpleDomain[],
  today = utcDaysAgo(0)
): CapabilityResult => {
  const account = record<Record<string, string | null>>({
    id: 'account',
    fields: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'identifier', label: 'Account identifier', role: 'identifier' },
      { key: 'country', label: 'Country', role: 'label' },
      { key: 'notificationEmail', label: 'Notification email', role: 'label' },
      { key: 'billingEmail', label: 'Billing email', role: 'label' }
    ],
    value: {
      name: profile.name ?? null,
      identifier: profile.identifier ?? null,
      country: profile.country ?? null,
      notificationEmail: profile.notificationEmail ?? null,
      billingEmail: profile.billingEmail ?? null
    }
  })

  // Domains whose expiry falls within the next 60 days — the number worth a glance for a registrar.
  const soon = dayMinus(today, -60)
  const expiring = domains.filter((d) => d.expiresOn && d.expiresOn >= today && d.expiresOn <= soon).length

  const header = record<{ total: number; expiring: number }>({
    id: 'domainsHeader',
    fields: [
      { key: 'total', label: 'Domains', role: 'count' },
      { key: 'expiring', label: 'Expiring ≤ 60 days', role: 'count' }
    ],
    value: { total: domains.length, expiring }
  })

  const list = table<DnsimpleDomainRow>({
    id: 'domains',
    columns: [
      { key: 'name', label: 'Domain', role: 'identifier' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'expiresOn', label: 'Expires', role: 'timestamp' },
      { key: 'autoRenew', label: 'Auto-renew', role: 'label' }
    ],
    rows: domains.map((d) => ({
      name: d.name,
      status: d.status,
      expiresOn: d.expiresOn ?? null,
      autoRenew: d.autoRenew ? 'On' : 'Off'
    })),
    // The domain name is its stable identity (parseDomains dedupes it), so each domain's status/expiry
    // accumulates in the ledger.
    key: 'name'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Account' }),
      domains.length > 0 ? header.stat() : null,
      domains.length > 0 ? list.table({ title: 'Domains' }) : null
    ]
  })
}

// ── Access Tokens tab (the account's API access tokens + the current API rate-limit window) ─────
// Both come off `/a/<id>/account/api_tokens`: the rate-limit grid (requests/hour, remaining, reset) and the
// access-tokens table. Pure — fixture-tested; tolerant of an empty token list (a fresh account has none).

export interface DnsimpleApiLimits {
  limit?: number
  remaining?: number
  /** ISO datetime the current window resets. */
  resetAt?: string
}

export interface DnsimpleAccessToken {
  name: string
  created?: string
  lastUsed?: string
}

const cardByHeading = ($: cheerio.CheerioAPI, heading: RegExp) =>
  $('.action-card')
    .filter((_, c) => heading.test($(c).find('h3').first().text()))
    .first()

export const parseApiLimits = (html: string): DnsimpleApiLimits | null => {
  const $ = cheerio.load(html || '')
  const card = cardByHeading($, /api limits/i)

  if (card.length === 0) {
    return null
  }

  const toNum = (s: string): number | undefined => parseInt(s.replace(/[^\d]/g, ''), 10) || undefined
  const limits: DnsimpleApiLimits = {}

  card.find('.col-third').each((_, col) => {
    const text = squish($(col).text())
    const strong = $(col).find('strong').first()

    if (/requests\/hour limit/i.test(text)) {
      limits.limit = toNum(strong.text())
    } else if (/requests remaining/i.test(text)) {
      limits.remaining = toNum(strong.text())
    } else if (/limit reset/i.test(text)) {
      limits.resetAt = strong.find('time').attr('datetime')?.trim() || undefined
    }
  })

  return limits
}

export const parseAccessTokens = (html: string): DnsimpleAccessToken[] => {
  const $ = cheerio.load(html || '')
  const tokens: DnsimpleAccessToken[] = []

  cardByHeading($, /access tokens/i)
    .find('table tbody tr')
    .each((_, tr) => {
      const name = squish($(tr).find('td').eq(0).text())

      if (!name) {
        return
      }

      const days = $(tr)
        .find('time[datetime]')
        .toArray()
        .map((t) => isoDay($(t).attr('datetime')))

      tokens.push({ name, created: days[0], lastUsed: days[1] })
    })

  return tokens
}

export const buildDnsimpleAccessTokensResult = (
  tokens: DnsimpleAccessToken[],
  limits: DnsimpleApiLimits | null
): CapabilityResult => {
  const limitsRecord =
    limits && (limits.limit != null || limits.remaining != null)
      ? record<{ limit: number | null; remaining: number | null; resetAt: string | null }>({
          id: 'apiLimits',
          fields: [
            { key: 'limit', label: 'Requests / hour', role: 'count' },
            { key: 'remaining', label: 'Remaining', role: 'count' },
            { key: 'resetAt', label: 'Window resets', role: 'timestamp' }
          ],
          value: { limit: limits.limit ?? null, remaining: limits.remaining ?? null, resetAt: limits.resetAt ?? null }
        })
      : null

  const table_ = table<{ name: string; created: string | null; lastUsed: string | null }>({
    id: 'tokens',
    columns: [
      { key: 'name', label: 'Token', role: 'label' },
      { key: 'created', label: 'Created', role: 'timestamp' },
      { key: 'lastUsed', label: 'Last used', role: 'timestamp' }
    ],
    rows: tokens.map((t) => ({ name: t.name, created: t.created ?? null, lastUsed: t.lastUsed ?? null })),
    // The token name is its identity on the account, so each token's last-used history accumulates in the ledger.
    key: 'name'
  })

  return capabilityResult({ sections: [limitsRecord?.stat(), table_.table({ title: 'Access tokens' })] })
}

// ── collectors ─────────────────────────────────────────────────────────────────────────

// The numeric account id keys every dashboard path. It's read from Settings when set; otherwise it's scraped
// from the session's own dashboard chrome (so the user never has to find it — the dashboard URL doesn't carry
// it), with the Settings field as an override for picking a non-default account.
const resolveAccountId = async (ctx: CollectContext<DnsimpleConfig>): Promise<string> => {
  const configured = ctx.config.accountId?.trim()

  if (configured) {
    return configured
  }

  const id = parseAccountId(await ctx.client.getText(`${ORIGIN}/dashboard`).catch(() => ''))

  if (!id) {
    throw new Error(
      'DNSimple: could not determine the account id from the dashboard — set it in Settings (the /a/<id>/ segment of your dashboard URL).'
    )
  }

  return id
}

// Both tabs need the billing page + the walked invoice pages; both bind this fetch. The core query cache
// dedupes the underlying reads across the two runs. The pagination walk lives here (not in the pure build*()):
// walk pages until ~13 months of history or the page cap, following the footer's rel="next" link.
const fetchDnsimpleBilling = async (ctx: CollectContext<DnsimpleConfig>): Promise<DnsimpleBillingRaw> => {
  const id = await resolveAccountId(ctx)
  const base = `${ORIGIN}/a/${id}/account`

  const billingHtml = await ctx.client.getText(`${base}/billing_and_plans`).catch(() => '')

  const invoicePagesHtml: string[] = []
  let oldest: string | undefined

  for (let page = 1; page <= MAX_INVOICE_PAGES; page++) {
    const html = await ctx.client.getText(`${base}/invoices?page=${page}`)

    invoicePagesHtml.push(html)

    const pageInvoices = parseInvoices(html)
    const pageOldest = pageInvoices
      .map((i) => i.date)
      .filter((d): d is string => !!d)
      .sort()[0]

    if (pageOldest && (!oldest || pageOldest < oldest)) {
      oldest = pageOldest
    }

    if (!hasNextPage(html)) {
      break
    }

    if (oldest) {
      const newest = pageInvoices
        .map((i) => i.date)
        .filter((d): d is string => !!d)
        .sort()
        .at(-1)
      const cutoff = monthsBefore((newest ?? oldest).slice(0, 7), HISTORY_MONTHS)

      if (oldest.slice(0, 7) <= cutoff) {
        break
      }
    }
  }

  return { billingHtml, invoicePagesHtml }
}

// The Account tab pairs the profile page with the domain list (one account id resolution, two scrapes).
const fetchDnsimpleAccount = async (ctx: CollectContext<DnsimpleConfig>): Promise<DnsimpleAccountRaw> => {
  const id = await resolveAccountId(ctx)
  const [accountHtml, domainsHtml] = await Promise.all([
    ctx.client.getText(`${ORIGIN}/a/${id}/account`).catch(() => ''),
    ctx.client.getText(`${ORIGIN}/a/${id}/domain_names`).catch(() => '')
  ])

  return { accountHtml, domainsHtml }
}

const fetchDnsimpleMembers = (ctx: CollectContext<DnsimpleConfig>): Promise<string> =>
  resolveAccountId(ctx).then((id) => ctx.client.getText(`${ORIGIN}/a/${id}/account/members`).catch(() => ''))

const fetchDnsimpleApiTokens = (ctx: CollectContext<DnsimpleConfig>): Promise<string> =>
  resolveAccountId(ctx).then((id) => ctx.client.getText(`${ORIGIN}/a/${id}/account/api_tokens`).catch(() => ''))

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const dnsimpleConfigSchema = defineConfigSchema([
  {
    key: 'accountId',
    label: 'Account ID',
    kind: 'text',
    required: false,
    placeholder: 'auto-detected',
    help: 'Auto-detected from your session. Set it only to pick a specific account (the /a/<id>/ segment of your dashboard URL).'
  }
])

export type DnsimpleConfig = ConfigOf<typeof dnsimpleConfigSchema>

export const dnsimplePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'dnsimple',
    name: 'DNSimple',
    vendor: 'DNSimple',
    category: 'devtools',
    color: '#1a5ec6',
    description:
      'DNSimple account — billing (invoice history, current plan, estimated next charge), members, API access tokens, and the account profile with its domains (expiry, status).',
    homepage: 'https://dnsimple.com',
    dashboardUrl: 'https://dnsimple.com/dashboard'
  },
  session: {
    loginUrl: 'https://dnsimple.com/login',
    dashboardMarkers: ['/dashboard', '/a/'],
    cookieDomains: ['dnsimple.com'],
    // The Rails session lands after sign-in; gate the capture on it so a half-set jar isn't grabbed.
    requiredCookie: '_dnsimple_session',
    // Google sign-in is omniauth, which stashes the OAuth `state` in the Rails `_dnsimple_session` cookie. A
    // stale `_dnsimple_session` left in the shared partition poisons that state on the callback, so the handshake
    // fails and the browser lands back on the login page (works once from a clean jar, fails every reconnect
    // after). Drop it at the start of each capture so the OAuth round-trip begins clean; the authed
    // `_dnsimple_session` is then re-set on the callback and captured.
    clearCookiesBeforeCapture: ['_dnsimple_session'],
    // Prefill the account id from the dashboard URL (dnsimple.com/a/<id>/) when the capture settles on it.
    captureFromUrl: [{ pattern: '/a/(\\d+)', storeAs: 'accountId' }]
  },
  auth: { kind: 'cookie' },
  transport: {
    // dnsimple.com is plain nginx (NO Cloudflare) — Node TLS is accepted, so the default node transport.
    engine: 'node',
    baseUrl: ORIGIN
  },
  config: dnsimpleConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchDnsimpleBilling,
      build: (raw) => buildDnsimpleSummaryResult(buildBillingReport(raw.billingHtml, raw.invoicePagesHtml)),
      sample: sampleDnsimpleBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchDnsimpleBilling,
      build: (raw) => buildDnsimpleBillingResult(buildBillingReport(raw.billingHtml, raw.invoicePagesHtml)),
      sample: sampleDnsimpleBilling
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchDnsimpleMembers,
      build: (html) => members.result(buildDnsimpleMembers(html)),
      sample: sampleDnsimpleMembers
    }),
    defineCapability({
      id: 'access_tokens',
      label: 'Access Tokens',
      fetch: fetchDnsimpleApiTokens,
      build: (html) => buildDnsimpleAccessTokensResult(parseAccessTokens(html), parseApiLimits(html)),
      sample: sampleDnsimpleApiTokens
    }),
    defineCapability({
      id: 'account',
      label: 'Account',
      fetch: fetchDnsimpleAccount,
      build: (raw) => buildDnsimpleAccountResult(parseAccountProfile(raw.accountHtml), parseDomains(raw.domainsHtml)),
      sample: sampleDnsimpleAccount
    })
  ],
  probe: async (ctx) => {
    // The invoices page is the cheapest authed scrape — a 200 proves the session is live (the account id is
    // resolved from Settings or scraped from the dashboard chrome).
    await ctx.client.getText(`${ORIGIN}/a/${await resolveAccountId(ctx)}/account/invoices?page=1`)
  }
})
