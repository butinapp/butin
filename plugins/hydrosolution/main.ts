import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing } from '@butinapp/sdk/presets'
import { byDayDesc, parseFrAmount, squish } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { sampleHydroBilling, sampleHydroEquipment } from './sample.js'

// Hydro-Solution (hydrosolution.com) — a Québec water-heater / water-treatment rental company. The
// customer portal ("Espace client") is a WordPress site behind Cloudflare; there is no JSON API, so
// every capability parses the server-rendered HTML with cheerio.
//
// AUTH is a plain cookie session. You sign in by hand at /espace-client/ (email + password, optional
// "remember me"); the POST 302-redirects and sets `PHPSESSID` (session) + `remember` (durable, ~30d).
// The login page and the authed dashboard share the same url (/espace-client/), so a url marker alone
// can't tell logged-in from logged-out — `requiredCookie: 'remember'` gates the capture on the durable
// cookie that only exists once you're signed in (so check "remember me" when logging in).
//
// CLOUDFLARE: the domain sits behind Cloudflare and only accepts a real browser (`cf_clearance` +
// cdn-cgi/challenge-platform), so `requiresBrowserEngine: true` forces the Electron net.request transport
// with the real browser's TLS identity. The replay UA must match the capture window UA (cf_clearance binds to IP+UA+TLS-identity).
//
// MONEY is CAD (e.g. "18.79$" on the bill table, "18,79 $" in the account summary). No FX rate is
// exposed, so amounts stay in CAD dollars (the plugin's reportingCurrency) — never fake-converted to USD.

const ORIGIN = 'https://www.hydrosolution.com'
const ESPACE_PATH = '/espace-client/'
const FACTURES_PATH = '/espace-client/factures-en-ligne/'
const FACTURES_URL = `${ORIGIN}${FACTURES_PATH}`
const CURRENCY = 'CAD'

// --- shared parsers ---

// "11-06-2026" (DD-MM-YYYY) → "2026-06-11". '' when it doesn't match.
export const frDateToIso = (raw?: string): string => {
  const m = raw?.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/)

  return m ? `${m[3]}-${m[2]}-${m[1]}` : ''
}

// The bill PDF link is relative to the factures page (`?getBillPDF&billID=<base64>`).
const billPdfUrl = (href: string): string =>
  href.startsWith('http') ? href : `${FACTURES_URL}${href.replace(/^\//, '')}`

// A logged-out portal serves the login form (a password field) instead of the dashboard. Throwing on
// that lets core surface "sign in again" rather than rendering an empty report from the login page.
const assertAuthed = (html: string, marker: string): void => {
  if (!html.includes(marker) && /name=["']password["']/i.test(html)) {
    throw new Error('Hydro-Solution session expired — open the connection and sign in again.')
  }
}

// --- billing: the online bill history + the account summary ---

export interface HydroBill {
  /** 'YYYY-MM-DD' (bill date). */
  date: string
  /** CAD dollars. */
  amount: number
  /** Bill number, e.g. "21217786". */
  number: string
  /** Absolute PDF url. */
  pdfUrl: string
}

export interface HydroAccountSummary {
  previousBalance?: number
  payments?: number
  currentCharges?: number
  amountDue?: number
  /** 'YYYY-MM-DD' due date. */
  dueDate?: string
}

// The bill table is a flat CSS grid (`#billsTable`) of repeating cells: .gh_date / .gh_montant /
// .gh_facture / .gh_btn a[href]. Header cells use .gh_titre, so the data classes select only rows.
export const parseHydroBills = (html: string): HydroBill[] => {
  const $ = cheerio.load(html)
  const dates = $('#billsTable .gh_date')
    .toArray()
    .map((e) => $(e).text())
  const amounts = $('#billsTable .gh_montant')
    .toArray()
    .map((e) => $(e).text())
  const numbers = $('#billsTable .gh_facture')
    .toArray()
    .map((e) => $(e).text())
  const hrefs = $('#billsTable .gh_btn a')
    .toArray()
    .map((e) => $(e).attr('href') ?? '')
  const bills: HydroBill[] = []

  for (let i = 0; i < numbers.length; i++) {
    const number = numbers[i].trim()

    if (!number) {
      continue
    }

    bills.push({
      date: frDateToIso(dates[i]),
      amount: parseFrAmount(amounts[i]),
      number,
      pdfUrl: billPdfUrl(hrefs[i] ?? '')
    })
  }

  return bills
}

// "Numéro de compte : </span>00839986724" — the number sits OUTSIDE the label span.
export const parseAccountNumber = (html: string): string | undefined => {
  const m = html.match(/Num.ro de compte\s*:\s*<\/span>\s*([0-9]+)/i)

  return m ? m[1] : undefined
}

// Pull the value of a `<p>Label <span class="floatRight">VALUE</span></p>` row by a label regex
// fragment (accent chars written as `.` so it matches whether the page is utf-8 or mojibake).
const summaryValue = (html: string, labelRe: string): string | undefined => {
  const m = html.match(new RegExp(`${labelRe}[\\s\\S]*?floatRight">\\s*([^<]+?)\\s*<\\/span>`, 'i'))

  return m ? m[1].trim() : undefined
}

// The account-summary box on the portal landing (/espace-client/): previous balance, payments since
// last statement, current charges, last amount due, and the next due date.
export const parseHydroSummary = (html: string): HydroAccountSummary => ({
  previousBalance:
    summaryValue(html, 'Solde pr.c.dent') !== undefined
      ? parseFrAmount(summaryValue(html, 'Solde pr.c.dent'))
      : undefined,
  payments:
    summaryValue(html, 'Paiements et/ou cr.dits') !== undefined
      ? parseFrAmount(summaryValue(html, 'Paiements et/ou cr.dits'))
      : undefined,
  currentCharges:
    summaryValue(html, 'Frais actuels') !== undefined ? parseFrAmount(summaryValue(html, 'Frais actuels')) : undefined,
  amountDue:
    summaryValue(html, 'Dernier montant d.') !== undefined
      ? parseFrAmount(summaryValue(html, 'Dernier montant d.'))
      : undefined,
  dueDate: frDateToIso(summaryValue(html, "Date d'.ch.ance"))
})

// --- Summary tab (its spend.mtd summary is what the cross-service Overview rolls up) ---
// The shared billing.summary preset (account stat + monthly-spend chart + spend.mtd summary), with the
// French labels, plus the account number + bill count as free stats. currentMtd is the amount due (the
// portal's "last amount due", then current charges, then the newest bill); null when none of those is
// available, so the Overview skips Hydro-Solution rather than charting a misleading 0.
export const buildHydroSummaryResult = (
  bills: HydroBill[],
  account?: string,
  summary?: HydroAccountSummary
): CapabilityResult => {
  const sorted = [...bills].sort(byDayDesc)
  const currentMtd = summary?.amountDue ?? summary?.currentCharges ?? sorted[0]?.amount ?? null

  return billing.summary({
    currentMtd,
    currentMtdLabel: 'Montant dû',
    // The amount owed on the latest statement — a consumer utility bill, not a live month-to-date accrual.
    mtdBasis: 'lastInvoice',
    currency: CURRENCY,
    monthlyTitle: 'Facturation mensuelle',
    invoices: sorted.map((b) => ({ date: b.date || undefined, amount: b.amount, status: 'paid' })),
    stats: [
      { key: 'account', label: 'Compte', role: 'identifier', value: account ?? null },
      { key: 'billCount', label: 'Factures', role: 'count', value: sorted.length }
    ]
  })
}

// --- Factures tab: the bill history + the account statement ---
// The bill history as a downloadable table (each row's PDF link is the file URL; the host adds selection +
// Download all/selected + per-row Open + on-disk size — no separate documents tab), plus the account-
// statement keyvalue. The headline (amount due / monthly chart) lives on Summary.

interface HydroInvoiceRow {
  date: string | null
  number: string
  amount: number
  pdfUrl: string
  // Hidden — carried for the download filename, not rendered.
  name: string
}

interface HydroStatementRow {
  previousBalance: number | null
  payments: number | null
  currentCharges: number | null
  amountDue: number | null
  dueDate: string | null
}

export const buildHydroBilling = (bills: HydroBill[], summary?: HydroAccountSummary): CapabilityResult => {
  const sorted = [...bills].sort(byDayDesc)
  const invoices = table<HydroInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Facture', role: 'identifier' },
      { key: 'amount', label: 'Montant', role: 'money', currency: CURRENCY },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: sorted.map((b) => ({
      date: b.date || null,
      number: b.number,
      amount: b.amount,
      pdfUrl: b.pdfUrl,
      name: `Facture ${b.date || b.number}`
    })),
    // The bill number is unique + always present (the parser skips number-less rows) → the ledger key.
    key: 'number'
  })

  const hasStatement = summary && (summary.amountDue != null || summary.dueDate || summary.currentCharges != null)
  const statement = hasStatement
    ? record<HydroStatementRow>({
        id: 'statement',
        fields: [
          { key: 'previousBalance', label: 'Solde précédent', role: 'money', currency: CURRENCY },
          { key: 'payments', label: 'Paiements / crédits', role: 'money', currency: CURRENCY },
          { key: 'currentCharges', label: 'Frais actuels', role: 'money', currency: CURRENCY },
          { key: 'amountDue', label: 'Montant dû', role: 'money', currency: CURRENCY },
          { key: 'dueDate', label: "Date d'échéance", role: 'timestamp' }
        ],
        value: {
          previousBalance: summary.previousBalance ?? null,
          payments: summary.payments ?? null,
          currentCharges: summary.currentCharges ?? null,
          amountDue: summary.amountDue ?? null,
          dueDate: summary.dueDate || null
        }
      })
    : null

  return capabilityResult({
    sections: [
      // The bill-PDF endpoint 403s without the factures-page referer; set referer via transport.download.
      invoices.fileTable({
        title: 'Factures',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Factures'
      }),
      statement?.keyvalue({ title: 'Relevé de compte' })
    ]
  })
}

// Summary + Factures both need the bill history (factures page) + the account statement (landing page); both
// capabilities fetch this raw HTML bundle. The core query cache dedupes the underlying reads across the two
// runs. The factures page is load-bearing (gates the session); the landing summary is best-effort.
export interface HydroBillingRaw {
  /** /espace-client/factures-en-ligne/ — the bill-history grid + account number. */
  facturesHtml: string
  /** /espace-client/ landing — the account-statement box; '' when it didn't load. */
  landingHtml: string
}

const fetchHydroBilling = async (ctx: CollectContext): Promise<HydroBillingRaw> => {
  const facturesHtml = await ctx.client.getText(FACTURES_PATH)

  assertAuthed(facturesHtml, 'billsTable')

  const landingHtml = await ctx.client.getText(ESPACE_PATH).catch(() => '')

  return { facturesHtml, landingHtml }
}

// Pure raw-HTML → result transforms (fixture-tested): scrape the bills/account/statement, then compose.
export const buildHydroSummaryFromRaw = (raw: HydroBillingRaw): CapabilityResult =>
  buildHydroSummaryResult(
    parseHydroBills(raw.facturesHtml),
    parseAccountNumber(raw.facturesHtml),
    raw.landingHtml ? parseHydroSummary(raw.landingHtml) : undefined
  )

export const buildHydroBillingFromRaw = (raw: HydroBillingRaw): CapabilityResult =>
  buildHydroBilling(parseHydroBills(raw.facturesHtml), raw.landingHtml ? parseHydroSummary(raw.landingHtml) : undefined)

// --- equipment: the rented equipment + installation detail ---

export interface HydroWarranty {
  part: string
  remaining: string
}

export interface HydroEquipmentDetail {
  installation: { address?: string; housingType?: string }
  equipment: { name?: string; serial?: string; installDate?: string; rental?: string; warranties: HydroWarranty[] }
}

// The landing page links to each location's detail page (`?account=<base64>`). Follow that link rather
// than asking the user to paste an account id.
export const extractDetailUrl = (landingHtml: string): string | undefined => {
  const $ = cheerio.load(landingHtml)
  const href = $('a.seeEquipmentDetailButton').first().attr('href')

  if (href) {
    return href.startsWith('http') ? href : `${ORIGIN}${href}`
  }

  const m = landingHtml.match(/href="([^"]*detail-espace-client\/?\?account=[^"]+)"/)

  return m ? (m[1].startsWith('http') ? m[1] : `${ORIGIN}${m[1]}`) : undefined
}

// Parse the detail page: the installation address box + the equipment/services box (model, serial,
// install date, monthly rental, and the remaining warranties).
export const parseHydroDetail = (html: string): HydroEquipmentDetail => {
  const $ = cheerio.load(html)

  const inst = $('#installationAddress')
  const addressP = inst.find('p').first().clone()

  addressP.find('span').remove()
  const address = squish(addressP.text()) || undefined

  let housingType: string | undefined

  inst.find('p').each((_, p) => {
    const $p = $(p)

    if (/Type de logement/i.test($p.text())) {
      const c = $p.clone()

      c.find('span').remove()
      housingType = squish(c.text()) || undefined
    }
  })

  const eq = $('#esEquipementsServicesDetails')
  const eqText = squish(eq.text())
  const name = squish(eq.find('.esLabel').first().text()) || undefined
  const serial = eqText.match(/s.rie\s*:\s*([0-9]+)/i)?.[1]
  const installDate = frDateToIso(eq.find('.smallText').first().text())
  const rental = eqText.match(/Location.{0,4}?([0-9.,]+\s*\$\s*\/\s*mois)/i)?.[1]?.replace(/\s+/g, '')
  const warranties: HydroWarranty[] = [
    ...eqText.matchAll(/Garantie restante sur ([^:]+?)\s*:\s*([A-Za-zÀ-ÿ0-9 ]+?)(?=Garantie|Cet|$)/g)
  ].map((m) => ({ part: squish(m[1]), remaining: squish(m[2]) }))

  return {
    installation: { address, housingType },
    equipment: { name, serial, installDate: installDate || undefined, rental, warranties }
  }
}

// Renders via the generic dashboard (any result with `datasets` does), so no bespoke UI: installation
// keyvalue + equipment keyvalue + an optional warranties table.

interface HydroInstallationRow {
  address: string | null
  housingType: string | null
}

interface HydroEquipmentRow {
  name: string | null
  serial: string | null
  installDate: string | null
  rental: string | null
}

interface HydroWarrantyRow {
  part: string
  remaining: string
}

export const buildHydroEquipment = (detail: HydroEquipmentDetail): CapabilityResult => {
  const installation = record<HydroInstallationRow>({
    id: 'installation',
    fields: [
      { key: 'address', label: 'Adresse', role: 'text' },
      { key: 'housingType', label: 'Type de logement', role: 'text' }
    ],
    value: { address: detail.installation.address ?? null, housingType: detail.installation.housingType ?? null }
  })

  const equipment = record<HydroEquipmentRow>({
    id: 'equipment',
    fields: [
      { key: 'name', label: 'Équipement', role: 'label' },
      { key: 'serial', label: 'Numéro de série', role: 'identifier' },
      { key: 'installDate', label: 'Installation', role: 'timestamp' },
      { key: 'rental', label: 'Location', role: 'text' }
    ],
    value: {
      name: detail.equipment.name ?? null,
      serial: detail.equipment.serial ?? null,
      installDate: detail.equipment.installDate ?? null,
      rental: detail.equipment.rental ?? null
    }
  })

  const warranties =
    detail.equipment.warranties.length > 0
      ? table<HydroWarrantyRow>({
          id: 'warranties',
          columns: [
            { key: 'part', label: 'Garantie', role: 'text' },
            { key: 'remaining', label: 'Restante', role: 'text' }
          ],
          rows: detail.equipment.warranties.map((w) => ({ part: w.part, remaining: w.remaining })),
          // One warranty per covered part — the part name is always present and unique, so it keys the ledger.
          key: 'part'
        })
      : null

  return capabilityResult({
    sections: [
      equipment.keyvalue({ title: 'Équipement loué' }),
      installation.keyvalue({ title: "Adresse de l'installation" }),
      warranties?.table({ title: 'Garanties' })
    ]
  })
}

// The landing page links to the location's detail page; follow that link, then scrape the detail HTML.
export interface HydroEquipmentRaw {
  /** /espace-client/detail-espace-client/?account=… — the installation + equipment/warranties detail. */
  detailHtml: string
}

const fetchHydroEquipment = async (ctx: CollectContext): Promise<HydroEquipmentRaw> => {
  const landingHtml = await ctx.client.getText(ESPACE_PATH)

  assertAuthed(landingHtml, 'ec_dashboard')

  const detailUrl = extractDetailUrl(landingHtml)

  if (!detailUrl) {
    throw new Error('Hydro-Solution: no equipment detail link found on the portal landing.')
  }

  return { detailHtml: await ctx.client.getText(detailUrl) }
}

// Pure raw-HTML → result transform (fixture-tested).
export const buildHydroEquipmentFromRaw = (raw: HydroEquipmentRaw): CapabilityResult =>
  buildHydroEquipment(parseHydroDetail(raw.detailHtml))

// French-canonical plugin → ships an `en` map for its rental vocabulary. Note `Location` is French for
// "rental" (not a place) — exactly the domain nuance the app's global dict can't know.
const HYDRO_EN: Record<string, string> = {
  Sommaire: 'Summary',
  Factures: 'Invoices',
  Facture: 'Invoice',
  'Relevé de compte': 'Account statement',
  'Équipement loué': 'Rented equipment',
  Équipement: 'Equipment',
  Garanties: 'Warranties',
  Garantie: 'Warranty',
  Compte: 'Account',
  Adresse: 'Address',
  Location: 'Rental',
  Installation: 'Installation',
  'Numéro de série': 'Serial number',
  'Type de logement': 'Dwelling type',
  'Frais actuels': 'Current charges',
  'Montant dû': 'Amount due',
  Montant: 'Amount',
  'Solde précédent': 'Previous balance',
  Restante: 'Remaining',
  'Paiements / crédits': 'Payments / credits',
  Date: 'Date',
  PDF: 'PDF'
}

export const hydrosolutionPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'hydrosolution',
    name: 'Hydro-Solution',
    vendor: 'Hydro-Solution',
    category: 'rental',
    color: '#0098d8',
    dashboardUrl: 'https://www.hydrosolution.com/espace-client/',
    description: 'Hydro-Solution water-heater rental — bills, account statement, equipment, and bill PDFs.',
    homepage: 'https://www.hydrosolution.com',
    messages: { en: HYDRO_EN }
  },
  session: {
    loginUrl: `${ORIGIN}${ESPACE_PATH}`,
    // The login page and the authed dashboard share /espace-client/ — `requiredCookie` (not a url marker)
    // is what proves you're signed in. The deeper pages only appear once you navigate there.
    dashboardMarkers: ['/espace-client/', '/factures-en-ligne', '/detail-espace-client'],
    cookieDomains: ['hydrosolution.com'],
    // The durable "remember me" cookie — present only after a successful login (check the box at sign-in).
    requiredCookie: 'remember'
  },
  auth: { kind: 'cookie' },
  transport: {
    requiresBrowserEngine: true,
    baseUrl: ORIGIN
    // UA is injected centrally (browser/identity.ts) for both capture and replay, so cf_clearance's (IP, UA, TLS identity)
    // bind always holds — no hand-pinned string here (a frozen version would drift from the real Chromium).
  },
  capabilities: [
    // The bill PDFs aren't a separate documents tab — the Factures table is downloadable (its pdfUrl column).
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchHydroBilling,
      build: buildHydroSummaryFromRaw,
      sample: sampleHydroBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchHydroBilling,
      build: buildHydroBillingFromRaw,
      sample: sampleHydroBilling
    }),
    defineCapability({
      id: 'equipment',
      label: 'Équipement',
      fetch: fetchHydroEquipment,
      build: buildHydroEquipmentFromRaw,
      sample: sampleHydroEquipment
    })
  ],
  probe: async (ctx) => {
    // The bill history is the cheapest authed page — a logged-out portal serves the login form instead.
    assertAuthed(await ctx.client.getText(FACTURES_PATH), 'billsTable')
  }
})
