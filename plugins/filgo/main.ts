import { type CollectContext, defineCapability, definePlugin } from '@butinapp/sdk'
import { type CapabilityResult, capabilityResult, table } from '@butinapp/sdk/data'
import { billing } from '@butinapp/sdk/presets'
import { byDayDesc, isoDay, parseDecimalAmount, round2, squish } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { sampleFilgoActifs, sampleFilgoDeliveries, sampleFilgoStatements } from './sample.js'

// Filgo (filgo.ca) — a Québec propane / heating-fuel supplier. The customer portal ("Mon Filgo") is a
// Microsoft Power Pages site at portail.monfilgo.ca (Dataverse-backed, Azure App Service). You sign in
// through Azure AD B2C (filgoenergies.b2clogin.com); the portal session then rides on a durable
// `.AspNet.ApplicationCookie` set on portail.monfilgo.ca.
//
// AUTH is cookie + a Power Pages anti-forgery header: every write-ish POST (the Cloudflow triggers) carries
// `__RequestVerificationToken`, minted per fetch from GET /_layout/tokenhtml against the session's
// anti-forgery cookie — so `cookie-csrf` with a resolve() hook that scrapes that token.
//
// RENDER shapes: the assets page is server-rendered HTML (cheerio scrape of the account + reservoir cards);
// the statements + delivery history come back as Power Automate Cloudflow triggers that return a
// doubly-stringified JSON envelope (`{ json: "{ resultat: \"[…]\" }" }`).
//
// MONEY is CAD throughout (statement totals, delivery prices) — kept in CAD dollars (the reportingCurrency),
// never fake-converted to USD.

const PORTAL = 'https://portail.monfilgo.ca'
const ACTIFS_PATH = '/actifs/'
const TOKEN_PATH = '/_layout/tokenhtml'
const CURRENCY = 'CAD'
// Power Automate Cloudflow trigger ids wired into this portal (stable per deployment). The statement flow
// pulls Laserfiche account statements; the delivery flow pulls a tank's fuel-delivery ("ticket") history.
const FLOW_STATEMENTS = 'cd93aee0-4fd7-ef11-a731-0022483e9aac'
const FLOW_DELIVERIES = '4a2c2f49-aad9-ef11-a730-6045bd5f1c2e'

// ── types: raw wire shapes (exported for sample.ts) + normalized domain rows ─────────

// One Laserfiche statement document. The date/total/number live in the French-keyed metadata; the accents
// make the keys fragile to match, so we read metadataV2 by a case-insensitive ASCII substring of the key.
export interface RawStatementDoc {
  name?: string
  templateName?: string
  creationTime?: string
  url?: string
  metadataV2?: Array<{ key?: string; value?: string | number }>
}

// One fuel-delivery ticket. Volumes are litres, prices/totals are CAD dollars; most fields of the wide
// backend record are irrelevant here.
export interface RawDelivery {
  tickref?: string
  createdt?: string
  net_vol?: number | null
  gross_vol?: number | null
  net_price?: number | null
  grand_total?: number | null
  fill?: string
  prodcd?: string
}

export interface FilgoAccount {
  guid: string
  number: string
  name: string
}

export interface FilgoTank {
  // The Dataverse asset guid — the reservoir card's div id, and the delivery-flow lookup key.
  assetId: string
  name: string | null
  product: string | null
  capacity: string | null
  serviceState: string | null
  address: string | null
}

// The fetch bundles each capability's `build` consumes.
export interface FilgoActifs {
  accounts: FilgoAccount[]
  tanks: FilgoTank[]
}

export interface FilgoStatementsRaw {
  account: string | null
  statements: RawStatementDoc[]
}

export interface FilgoDeliveriesRaw {
  deliveries: RawDelivery[]
}

// ── shared helpers ────────────────────────────────────────────────────────────────

// A page GET must look like a navigation, not an XHR — the Power Pages endpoints content-negotiate, so ask
// for HTML explicitly rather than axios's JSON-first default.
const HTML_ACCEPT = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

// The anti-forgery field token GET /_layout/tokenhtml renders into a hidden input.
export const parseCsrfToken = (html: string): string | undefined =>
  html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1]

// A logged-out portal 302s to the B2C sign-in instead of serving the assets page. Throwing on that lets
// core surface "reconnect" rather than parsing an empty report out of the login shell. The trailing clue
// names what actually came back, so a mis-served (non-authed) response is diagnosable.
const assertAuthed = (html: string): void => {
  if (/account-select|reservoir-card|Mes\s*Comptes/i.test(html)) {
    return
  }

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
  const clue = /b2clogin|SignIn|CombinedSigninAndSignup|Account\/Login/i.test(html)
    ? 'got the sign-in page'
    : `got ${html.length} chars${title ? ` — "${title}"` : ''}`

  throw new Error(`Filgo session expired — open the connection and sign in again. (${clue})`)
}

interface CloudflowResponse {
  json?: string
  ErrorCode?: string
}

// The Cloudflow envelope is doubly stringified: { json: "{ \"resultat\": \"[…rows…]\" }" }. An error payload
// (upstream timeout, disabled flow) carries an ErrorCode and no `json` → an empty list, so one dead flow
// leaves the rest of the tab intact.
export const parseCloudflowResult = <T>(raw: CloudflowResponse | null): T[] => {
  if (!raw || typeof raw.json !== 'string') {
    return []
  }

  try {
    const inner = JSON.parse(raw.json) as { resultat?: string }
    const rows = inner.resultat ? JSON.parse(inner.resultat) : []

    return Array.isArray(rows) ? (rows as T[]) : []
  } catch {
    return []
  }
}

const triggerCloudflow = async <T>(
  ctx: CollectContext,
  flowId: string,
  eventData: Record<string, unknown>
): Promise<T[]> => {
  const body = `eventData=${encodeURIComponent(JSON.stringify(eventData))}`
  // The XHR markers the Power Pages Cloudflow endpoint expects — same-origin fetch, not a navigation.
  const raw = await ctx.client
    .post<CloudflowResponse>(`${PORTAL}/_api/cloudflow/v1.0/trigger/${flowId}`, body, {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: PORTAL,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    })
    .catch(() => null)

  return parseCloudflowResult<T>(raw)
}

// ── assets: the accounts + reservoir cards (HTML scrape of /actifs/) ─────────────────

const findLabel = (labels: Record<string, string>, needle: string): string | null => {
  const key = Object.keys(labels).find((k) => k.toLowerCase().includes(needle))

  return key ? labels[key] || null : null
}

// Pure transform — fixture-tested. Scrapes the account `<select>` options + every reservoir card. A card is
// `<div class="reservoir-card" id="<assetGuid>">` with a `.card-title` name, a `.card-address`, a
// `.card-product`, and `<h5 class="card-subtitle">Label</h5><p class="card-text">value</p>` pairs for
// Capacité / État de service.
export const parseFilgoActifs = (html: string): FilgoActifs => {
  const $ = cheerio.load(html)
  const accounts = $('#account-select option')
    .toArray()
    .map((o) => {
      const $o = $(o)

      return {
        guid: $o.attr('data-accountguid') ?? $o.attr('value') ?? '',
        number: $o.attr('data-accountnumber') ?? '',
        name: squish($o.text())
      }
    })
    .filter((a) => a.guid || a.number)

  const tanks = $('.reservoir-card')
    .toArray()
    .map((el) => {
      const $c = $(el)
      const labels: Record<string, string> = {}

      $c.find('.card-subtitle').each((_, h) => {
        const key = squish($(h).text())

        if (key) {
          labels[key] = squish($(h).nextAll('.card-text').first().text())
        }
      })

      return {
        assetId: $c.attr('id') ?? squish($c.find('h5.d-none').first().text()),
        name: squish($c.find('.card-title').first().text()) || null,
        product: squish($c.find('.card-product').first().text()) || null,
        capacity: findLabel(labels, 'capacit'),
        serviceState: findLabel(labels, 'tat de service'),
        address: squish($c.find('.card-address').first().text()) || null
      }
    })

  return { accounts, tanks }
}

interface TankRow {
  name: string | null
  product: string | null
  capacity: string | null
  serviceState: string | null
  address: string | null
  assetId: string
}

// Pure transform — fixture-tested. The tank roster as one table.
export const buildFilgoTanks = (actifs: FilgoActifs): CapabilityResult => {
  const tanks = table<TankRow>({
    id: 'tanks',
    columns: [
      { key: 'name', label: 'Réservoir', role: 'label' },
      { key: 'product', label: 'Produit', role: 'category' },
      { key: 'capacity', label: 'Capacité', role: 'text' },
      { key: 'serviceState', label: 'État de service', role: 'status', badges: { Fonctionnel: 'success' } },
      { key: 'address', label: 'Adresse', role: 'text', truncate: true },
      { key: 'assetId', role: 'identifier', hidden: true }
    ],
    rows: actifs.tanks.map((t) => ({
      name: t.name,
      product: t.product,
      capacity: t.capacity,
      serviceState: t.serviceState,
      address: t.address,
      assetId: t.assetId
    })),
    // The Dataverse asset guid is each tank's stable identity (its card id + delivery-lookup key), so the ledger
    // accumulates a tank's history even as its capacity / service-state readings change.
    key: 'assetId'
  })

  return capabilityResult({ sections: [tanks.table({ title: 'Réservoirs' })] })
}

const fetchActifs = async (ctx: CollectContext): Promise<FilgoActifs> => {
  const html = await ctx.client.getText(`${PORTAL}${ACTIFS_PATH}`, HTML_ACCEPT)

  assertAuthed(html)

  return parseFilgoActifs(html)
}

// ── statements: Laserfiche account statements (Cloudflow) — the billing headline ─────

export interface FilgoStatement {
  date: string
  number: string
  total: number
  url: string | null
  docName: string
}

const coerceAmount = (v: unknown): number => (typeof v === 'number' ? v : parseDecimalAmount(String(v ?? '')))

const metaValue = (doc: RawStatementDoc, needle: string): unknown =>
  (doc.metadataV2 ?? []).find((m) => (m.key ?? '').toLowerCase().includes(needle))?.value

// Pure transform — fixture-tested. One statement doc → its date / total / number, matching the accented
// metadata keys by ASCII substring; the statement number falls back to the trailing segment of the doc name
// (`ECOI_<account>_<number>`).
export const normalizeStatement = (doc: RawStatementDoc): FilgoStatement => {
  const rawDate = metaValue(doc, 'date')
  const number = String(metaValue(doc, 'relev') ?? doc.name?.split('_').pop() ?? '')

  return {
    date: isoDay(typeof rawDate === 'string' ? rawDate : undefined) ?? '',
    number,
    total: round2(coerceAmount(metaValue(doc, 'total'))),
    url: doc.url ?? null,
    docName: doc.name ?? `Relevé ${number}`
  }
}

interface StatementRow {
  date: string | null
  number: string
  total: number
  url: string | null
  name: string
}

const sortedStatements = (raw: FilgoStatementsRaw): FilgoStatement[] =>
  raw.statements.map(normalizeStatement).sort(byDayDesc)

// Pure transform — fixture-tested. The Summary tab: the newest statement total as the headline stat, the
// monthly-statements chart, and the spend summary that feeds the cross-service Overview. No receipts table —
// that's the Billing tab.
export const buildFilgoSummary = (raw: FilgoStatementsRaw): CapabilityResult => {
  const statements = sortedStatements(raw)

  return billing.summary({
    currentMtd: statements[0]?.total ?? null,
    currentMtdLabel: 'Dernier relevé',
    // The total of the most recent account statement — a consumer utility figure, not a live accrual.
    mtdBasis: 'lastInvoice',
    currency: CURRENCY,
    monthlyTitle: 'Relevés mensuels',
    invoices: statements.map((s) => ({
      id: s.number || s.date,
      date: s.date || undefined,
      amount: s.total,
      status: 'issued'
    })),
    stats: [
      { key: 'account', label: 'Compte', role: 'identifier', value: raw.account ?? null },
      { key: 'count', label: 'Relevés', role: 'count', value: statements.length }
    ]
  })
}

// Pure transform — fixture-tested. The Billing tab: the downloadable account statements (the Laserfiche PDF per
// row), newest-first. Carries no spend summary — the Summary tab owns the headline.
export const buildFilgoStatements = (raw: FilgoStatementsRaw): CapabilityResult => {
  const statements = sortedStatements(raw)

  if (!statements.length) {
    return capabilityResult({ sections: [] })
  }

  const statementTable = table<StatementRow>({
    id: 'statements',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'No relevé', role: 'identifier' },
      { key: 'total', label: 'Total', role: 'money', currency: CURRENCY },
      { key: 'url', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: statements.map((s) => ({
      date: s.date || null,
      number: s.number,
      total: s.total,
      url: s.url,
      name: s.docName
    })),
    key: 'number'
  }).fileTable({ title: 'Relevés', name: 'name', source: { url: 'url' }, ext: 'pdf', category: 'Relevés' })

  return capabilityResult({ sections: [statementTable] })
}

const fetchStatements = async (ctx: CollectContext): Promise<FilgoStatementsRaw> => {
  const { accounts } = await fetchActifs(ctx)
  const lists = await Promise.all(
    accounts.map((a) =>
      triggerCloudflow<RawStatementDoc>(ctx, FLOW_STATEMENTS, {
        account: a.number,
        templateName: 'lfiche-invoices',
        query: '?limit=50'
      })
    )
  )

  return { account: accounts.map((a) => a.number).join(', ') || null, statements: lists.flat() }
}

// ── deliveries: fuel-delivery history per tank (Cloudflow) — usage ───────────────────

interface DeliveryRow {
  date: string | null
  volume: number | null
  unitPrice: number | null
  total: number | null
  ticket: string
}

// Pure transform — fixture-tested. Each delivery ticket as a row, plus a propane-price trend chart.
export const buildFilgoDeliveries = (raw: FilgoDeliveriesRaw): CapabilityResult => {
  const rows = raw.deliveries
    .map((d) => ({
      date: isoDay(d.createdt) || null,
      volume: d.net_vol ?? null,
      unitPrice: d.net_price ?? null,
      total: d.grand_total ?? null,
      ticket: d.tickref?.trim() ?? ''
    }))
    .sort(byDayDesc)

  const deliveries = table<DeliveryRow>({
    id: 'deliveries',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'volume', label: 'Volume (L)', role: 'count' },
      { key: 'unitPrice', label: 'Prix unitaire', role: 'money', currency: CURRENCY },
      { key: 'total', label: 'Total', role: 'money', currency: CURRENCY },
      { key: 'ticket', label: 'Bon', role: 'identifier' }
    ],
    rows,
    key: 'ticket'
  })

  return capabilityResult({
    sections: [
      rows.length
        ? deliveries.timeseries({ x: 'date', y: 'unitPrice', granularity: 'daily', title: 'Prix du propane ($/L)' })
        : null,
      deliveries.table({ title: 'Livraisons' })
    ]
  })
}

const fetchDeliveries = async (ctx: CollectContext): Promise<FilgoDeliveriesRaw> => {
  const { tanks } = await fetchActifs(ctx)
  const lists = await Promise.all(
    tanks.filter((t) => t.assetId).map((t) => triggerCloudflow<RawDelivery>(ctx, FLOW_DELIVERIES, { id: t.assetId }))
  )

  return { deliveries: lists.flat() }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

// French-canonical plugin → ships an `en` map for the domain vocabulary the app's global dict can't cover.
const FILGO_EN: Record<string, string> = {
  Relevés: 'Statements',
  Réservoirs: 'Tanks',
  Réservoir: 'Tank',
  Livraisons: 'Deliveries',
  Produit: 'Product',
  Capacité: 'Capacity',
  'État de service': 'Service state',
  Adresse: 'Address',
  Compte: 'Account',
  'No relevé': 'Statement no.',
  'Dernier relevé': 'Latest statement',
  'Relevés mensuels': 'Monthly statements',
  'Volume (L)': 'Volume (L)',
  'Prix unitaire': 'Unit price',
  'Prix du propane ($/L)': 'Propane price ($/L)',
  Bon: 'Ticket',
  Date: 'Date',
  Total: 'Total'
}

export const filgoPlugin = definePlugin({
  reportingCurrency: CURRENCY,
  meta: {
    id: 'filgo',
    name: 'Filgo',
    vendor: 'Filgo',
    category: 'rental',
    color: '#00843d',
    description: 'Filgo propane — tanks, account statements, delivery history, and statement PDFs.',
    homepage: 'https://filgo.ca',
    dashboardUrl: `${PORTAL}${ACTIFS_PATH}`,
    messages: { en: FILGO_EN }
  },
  session: {
    // The portal 302s to Azure AD B2C when not signed in; /actifs/ is the authed landing once you are.
    loginUrl: `${PORTAL}${ACTIFS_PATH}`,
    dashboardMarkers: ['/actifs/', '/factures/', '/detail-du-reservoir/', '/demandes/'],
    cookieDomains: ['portail.monfilgo.ca'],
    // The durable ASP.NET portal-auth cookie, present only after a successful B2C sign-in.
    requiredCookie: '.AspNet.ApplicationCookie'
  },
  // cookie + the Power Pages anti-forgery header. A cookie-csrf resolve() REPLACES the default cookie
  // attachment, so it must return the stored session cookie itself alongside the field token (minted per run
  // from tokenhtml against that cookie); core memoizes the resolve() per client.
  auth: {
    kind: 'cookie-csrf',
    resolve: async (ctx) => {
      const cookie = ctx.creds.get('cookie') ?? ''
      const token = parseCsrfToken(await ctx.client.getText(`${PORTAL}${TOKEN_PATH}`, HTML_ACCEPT))
      const headers: Record<string, string> = token ? { __RequestVerificationToken: token } : {}

      return { cookie, headers }
    }
  },
  // Only a Referer in the defaults — the per-request Accept + Sec-Fetch markers differ for a page GET (a
  // navigation) vs a Cloudflow POST (an XHR), so they're set at each call site, not globally. UA + sec-ch-ua
  // are injected centrally.
  transport: {
    baseUrl: PORTAL,
    defaultHeaders: { Referer: `${PORTAL}${ACTIFS_PATH}` }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchStatements,
      build: buildFilgoSummary,
      sample: sampleFilgoStatements
    }),
    defineCapability({
      id: 'statements',
      label: 'Billing',
      fetch: fetchStatements,
      build: buildFilgoStatements,
      sample: sampleFilgoStatements
    }),
    defineCapability({
      id: 'assets',
      label: 'Réservoirs',
      fetch: fetchActifs,
      build: buildFilgoTanks,
      sample: sampleFilgoActifs
    }),
    defineCapability({
      id: 'deliveries',
      label: 'Livraisons',
      fetch: fetchDeliveries,
      build: buildFilgoDeliveries,
      sample: sampleFilgoDeliveries
    })
  ],
  probe: async (ctx) => {
    // The assets page is the cheapest authed read — a logged-out portal serves the B2C sign-in instead.
    assertAuthed(await ctx.client.getText(`${PORTAL}${ACTIFS_PATH}`, HTML_ACCEPT))
  }
})
