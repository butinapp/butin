import { type CollectContext, defineCapability, definePlugin } from '@butinapp/sdk'
import { type CapabilityResult, capabilityResult, record, table } from '@butinapp/sdk/data'
import { isPdfBytes, squish } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { sampleTaxData } from './sample.js'

// CGTSIM's "Taxation scolaire" portal (the GRICS TFP web app) is a server-rendered ASP session: you sign in with an
// email/code + password, and every screen is an HTML page under a single endpoint, TFP.aspx, selected by its `jlrun`
// query param (the screen id). The session is the `.TFPAUTH…` forms cookie alongside ASP.NET_SessionId, replayed
// verbatim. There are no JSON endpoints — the data lives in the anchors of each list page, and those anchors carry
// the identifiers (matricule, dossier, invoice id) in their own query strings, so the collectors read the hrefs
// rather than the surrounding table markup. Money (the tax amounts) is not exposed on the list pages, so this is a
// document portal: a property roster plus downloadable invoice and account-statement PDFs.

// ── constants ────────────────────────────────────────────────────────────────────────
const HOST = 'https://tfp.cgtsim.qc.ca'
// Resolving hrefs against the TFP.aspx page URL handles both `TFP.aspx?…` and query-only `?…` relative anchors.
const PAGE = `${HOST}/asp/TFP.aspx`
const screen = (jlrun: string): string => `${PAGE}?jlsid=1&jlrun=${jlrun}`

const PROPERTIES_URL = `${screen('tfpint.general.MesProprietes')}&jlact=HLK_MesPropr`

// The `jlrun` screen ids the collectors follow: the property roster links out to each property's invoice and
// statement lists, and each of those lists links to a `Produire` document (the PDF the download replays).
const SCREEN = {
  invoiceList: 'tfpint.factenligne.ListeFactEnLigne',
  statementList: 'tfpint.etatcompte.ListeEtatCompte',
  invoiceDoc: 'tfpint.factenligne.Produire',
  statementDoc: 'tfpint.etatcompte.Produire'
} as const

// ── types: the parsed HTML shapes then the fetch bundle ────────────────────────────────
export interface RawProperty {
  matricule: string
  dossier: string
  address: string
  // The property's own list pages, carried so the collectors can walk them and the download can set its referer.
  invoiceListUrl: string | null
  statementListUrl: string | null
}

export interface RawInvoice {
  idFact: string
  // The full invoice number; its first 4 digits are the tax year (e.g. 202601000000001 → 2026).
  noFactComplet: string
  produireUrl: string
}

export interface RawStatement {
  idCr: string
  codeAcces: string
  produireUrl: string
}

// What the shared fetch assembles: the roster, plus each property's invoices/statements tagged with their owner so
// the pure builders can flatten and label rows without re-resolving anything.
export interface RawTaxData {
  properties: RawProperty[]
  invoices: { property: RawProperty; invoice: RawInvoice }[]
  statements: { property: RawProperty; statement: RawStatement }[]
}

// ── shared helpers ─────────────────────────────────────────────────────────────────────
const asUrl = (href: string): URL | null => {
  try {
    return new URL(href, PAGE)
  } catch {
    return null
  }
}

// Every anchor on a TFP page whose `jlrun` names the given screen, as a resolved URL (deduped by an identifying
// query param so a screen linked twice — an icon plus a text link — yields one row).
const screenLinks = (html: string, jlrun: string, dedupeParam: string): URL[] => {
  const $ = cheerio.load(html)
  const seen = new Set<string>()
  const out: URL[] = []

  $('a[href]').each((_, el) => {
    const u = asUrl($(el).attr('href') ?? '')

    if (!u || u.searchParams.get('jlrun') !== jlrun) {
      return
    }

    const key = u.searchParams.get(dedupeParam) ?? ''

    if (!key || seen.has(key)) {
      return
    }

    seen.add(key)
    out.push(u)
  })

  return out
}

// The tax year an invoice belongs to — the 4-digit prefix of its full number.
const invoiceYear = (noFactComplet: string): string => (/^\d{4}/.test(noFactComplet) ? noFactComplet.slice(0, 4) : '—')

// ── properties: the roster (its links seed the invoice/statement fetches) ───────────────
// The roster page links each property to its invoice list AND its statement list, both anchors carrying the same
// property identifiers (matricule, dossier, address). Merging by matricule keeps one property per row while
// capturing both list URLs the other collectors need.
export const parseProperties = (html: string): RawProperty[] => {
  const byMatricule = new Map<string, RawProperty>()

  const record = (u: URL, set: (p: RawProperty) => void): void => {
    const matricule = u.searchParams.get('Matr') ?? ''

    if (!matricule) {
      return
    }

    const property = byMatricule.get(matricule) ?? {
      matricule,
      dossier: u.searchParams.get('Doss') ?? '',
      address: squish(u.searchParams.get('Adr')),
      invoiceListUrl: null,
      statementListUrl: null
    }

    set(property)
    byMatricule.set(matricule, property)
  }

  for (const u of screenLinks(html, SCREEN.invoiceList, 'Matr')) {
    record(u, (p) => (p.invoiceListUrl = u.toString()))
  }

  for (const u of screenLinks(html, SCREEN.statementList, 'Matr')) {
    record(u, (p) => (p.statementListUrl = u.toString()))
  }

  return [...byMatricule.values()]
}

export const parseInvoices = (html: string): RawInvoice[] =>
  screenLinks(html, SCREEN.invoiceDoc, 'ID_FACT').map((u) => ({
    idFact: u.searchParams.get('ID_FACT') ?? '',
    noFactComplet: u.searchParams.get('NO_FACT_COMPL') ?? '',
    produireUrl: u.toString()
  }))

export const parseStatements = (html: string): RawStatement[] =>
  screenLinks(html, SCREEN.statementDoc, 'ID_CR').map((u) => ({
    idCr: u.searchParams.get('ID_CR') ?? '',
    codeAcces: u.searchParams.get('Code_Acces') ?? '',
    produireUrl: u.toString()
  }))

// The rendered row shapes: hidden url/name fields drive the file downloads (produireUrl replayed, referer = listUrl).
interface PropertyRow {
  address: string
  dossier: string
  matricule: string
}

interface StatementRow {
  property: string
  reference: string
  accessCode: string
  produireUrl: string
  listUrl: string
  name: string
}

interface InvoiceRow {
  property: string
  year: string
  invoice: string
  produireUrl: string
  listUrl: string
  name: string
}

interface OverviewRow {
  properties: number
  invoices: number
  statements: number
}

// ── summary: the landing — a count overview, the property roster, and downloadable statements ─────
// The portal exposes no money on its list pages, so there is no spend rollup. The Summary tab instead carries the
// two single-entity sections — the property roster and the account statements — that would each otherwise be a
// one-row tab, above a glanceable count of what was found. Statements stay downloadable here (fetchStatementPdf).
export const buildSummary = (data: RawTaxData): CapabilityResult => {
  const statementRows: StatementRow[] = data.statements
    .map(({ property, statement }) => ({
      property: property.address || property.matricule,
      reference: statement.idCr,
      accessCode: statement.codeAcces,
      produireUrl: statement.produireUrl,
      listUrl: property.statementListUrl ?? '',
      name: `État de compte ${statement.idCr} ${property.matricule}`
    }))
    .sort((a, b) => b.reference.localeCompare(a.reference))

  const overview = record<OverviewRow>({
    id: 'overview',
    fields: [
      { key: 'properties', label: 'Properties', role: 'count' },
      { key: 'invoices', label: 'Invoices', role: 'count' },
      { key: 'statements', label: 'Statements', role: 'count' }
    ],
    value: { properties: data.properties.length, invoices: data.invoices.length, statements: statementRows.length }
  }).stat({})

  const properties = table<PropertyRow>({
    id: 'properties',
    columns: [
      { key: 'address', label: 'Address', role: 'text', truncate: true },
      { key: 'dossier', label: 'File', role: 'identifier' },
      { key: 'matricule', label: 'Matricule', role: 'identifier' }
    ],
    rows: data.properties.map((p) => ({ address: p.address, dossier: p.dossier, matricule: p.matricule })),
    key: 'matricule'
  }).table({ title: 'Properties' })

  const statements = table<StatementRow>({
    id: 'statements',
    columns: [
      { key: 'property', label: 'Property', role: 'text', truncate: true },
      { key: 'reference', label: 'Reference', role: 'identifier' },
      { key: 'accessCode', label: 'Access code', role: 'identifier' },
      { key: 'produireUrl', role: 'url', hidden: true },
      { key: 'listUrl', role: 'url', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: statementRows,
    key: 'reference'
  }).fileTable({ title: 'Statements', name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Statements' })

  return capabilityResult({ sections: [overview, properties, statements] })
}

// ── billing: the downloadable school-tax invoices ────────────────────────────────────────
export const buildBilling = (data: RawTaxData): CapabilityResult => {
  const rows: InvoiceRow[] = data.invoices
    .map(({ property, invoice }) => ({
      property: property.address || property.matricule,
      year: invoiceYear(invoice.noFactComplet),
      invoice: invoice.noFactComplet || invoice.idFact,
      produireUrl: invoice.produireUrl,
      listUrl: property.invoiceListUrl ?? '',
      name: `Taxe scolaire ${invoiceYear(invoice.noFactComplet)} ${property.matricule}`
    }))
    .sort((a, b) => b.year.localeCompare(a.year) || b.invoice.localeCompare(a.invoice))

  return capabilityResult({
    sections: [
      table<InvoiceRow>({
        id: 'invoices',
        columns: [
          { key: 'property', label: 'Property', role: 'text', truncate: true },
          { key: 'year', label: 'Year', role: 'category' },
          { key: 'invoice', label: 'Invoice', role: 'identifier' },
          { key: 'produireUrl', role: 'url', hidden: true },
          { key: 'listUrl', role: 'url', hidden: true },
          { key: 'name', role: 'label', hidden: true }
        ],
        rows,
        key: 'invoice'
      }).fileTable({ title: 'Invoices', name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Invoices' })
    ]
  })
}

// ── shared fetch: roster, then each property's invoice + statement lists ─────────────────
// One fetch backs both tabs — the core query cache dedupes the repeated page reads when both tabs open.
// Each list is best-effort: a property whose list page fails to load simply contributes no rows.
const fetchTaxData = async (ctx: CollectContext): Promise<RawTaxData> => {
  const properties = parseProperties(await ctx.client.getText(PROPERTIES_URL))
  const invoices: RawTaxData['invoices'] = []
  const statements: RawTaxData['statements'] = []

  for (const property of properties) {
    if (property.invoiceListUrl) {
      const html = await ctx.client.getText(property.invoiceListUrl).catch(() => '')

      for (const invoice of parseInvoices(html)) {
        invoices.push({ property, invoice })
      }
    }

    if (property.statementListUrl) {
      const html = await ctx.client.getText(property.statementListUrl).catch(() => '')

      for (const statement of parseStatements(html)) {
        statements.push({ property, statement })
      }
    }
  }

  return { properties, invoices, statements }
}

// A page's `<meta http-equiv="refresh" content="5; URL=…">` target (the portal drives its async generation flow
// entirely by these), resolved absolute. `&amp;` entities are decoded so the URL's own params survive.
const META_REFRESH = /http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'>]+)/i

export const metaRefreshUrl = (html: string): string | null => {
  const m = META_REFRESH.exec(html)
  const u = m ? asUrl(m[1].replace(/&amp;/g, '&').trim()) : null

  return u ? u.toString() : null
}

// The binary PDF link the Visionneuse exposes once a document is ready — the `tfpint.lot.PDFViewer` screen, wherever
// it appears (a meta-refresh target, an anchor href, or an inline `window.open`).
export const pdfViewerUrl = (html: string): string | null => {
  const refresh = metaRefreshUrl(html)

  if (refresh?.includes('tfpint.lot.PDFViewer')) {
    return refresh
  }

  const [viewer] = screenLinks(html, 'tfpint.lot.PDFViewer', 'File')

  if (viewer) {
    return viewer.toString()
  }

  const inline = /TFP\.aspx\?[^"'<> ]*jlrun=tfpint\.lot\.PDFViewer[^"'<> ]*/i.exec(html)
  const u = inline ? asUrl(inline[0].replace(/&amp;/g, '&')) : null

  return u ? u.toString() : null
}

// An invoice's `Produire` link streams its PDF straight to a real browser navigation (not an XHR — the server
// answers those with an HTML page), so anchor the window on the invoice list to warm the session, then navigate the
// Produire URL for its bytes.
const fetchInvoicePdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  if (!ctx.browser) {
    throw new Error('cgtsim: document download needs an authenticated browser session')
  }

  const produireUrl = String(row.produireUrl)
  const listUrl = String(row.listUrl || PROPERTIES_URL)

  return ctx.browser.open(listUrl, async (page) => {
    const bytes = await page.download(produireUrl, { referer: listUrl })

    ctx.log('cgtsim: invoice download', { produireUrl, bytes: bytes.length, isPdf: isPdfBytes(bytes) })

    if (!isPdfBytes(bytes)) {
      throw new Error('cgtsim: invoice download did not return a PDF')
    }

    return bytes
  })
}

// An account statement is generated ASYNCHRONOUSLY: its `Produire` link returns a "Visionneuse" page that
// meta-refreshes on itself while the server builds the image, then hands out a `PDFViewer` binary link. So warm the
// session on the statement list, request Produire, and follow the meta-refresh chain (reading raw HTML per hop, not
// letting the browser auto-navigate) until a viewer link appears — then download its bytes. Each hop is logged so a
// flow that stalls or changes shape is diagnosable from the Logs tab.
const STATEMENT_POLL_ATTEMPTS = 15
const fetchStatementPdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  if (!ctx.browser) {
    throw new Error('cgtsim: document download needs an authenticated browser session')
  }

  const produireUrl = String(row.produireUrl)
  const listUrl = String(row.listUrl || PROPERTIES_URL)

  return ctx.browser.open(listUrl, async (page) => {
    let step = await page.fetchText(produireUrl)

    ctx.log('cgtsim: statement Produire', { produireUrl, status: step.status, bytes: step.text.length })
    let viewer = pdfViewerUrl(step.text)

    for (let attempt = 0; attempt < STATEMENT_POLL_ATTEMPTS && !viewer; attempt++) {
      const next = metaRefreshUrl(step.text)

      ctx.log('cgtsim: statement poll', { attempt, next, hasViewer: !!viewer })

      if (!next) {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000))
      step = await page.fetchText(next)
      viewer = pdfViewerUrl(step.text)
    }

    if (!viewer) {
      ctx.log('cgtsim: statement viewer link not found', { snippet: step.text.slice(0, 600) })
      throw new Error('cgtsim: statement PDF was not ready (no viewer link)')
    }

    const bytes = await page.download(viewer, { referer: produireUrl })

    ctx.log('cgtsim: statement download', { viewer, bytes: bytes.length, isPdf: isPdfBytes(bytes) })

    if (!isPdfBytes(bytes)) {
      throw new Error('cgtsim: statement download did not return a PDF')
    }

    return bytes
  })
}

// ── descriptor ──────────────────────────────────────────────────────────────────────────
export const cgtsimPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'cgtsim',
    name: 'Montréal - Taxe Scolaire',
    vendor: 'CGTSIM',
    category: 'finance',
    color: '#2c6e9b',
    description: 'Montréal school-tax properties, invoices, and account statements from the CGTSIM portal.',
    homepage: 'https://cgtsim.qc.ca',
    dashboardUrl: screen('tfpint.general.Menu')
  },
  session: {
    loginUrl: `${screen('tfpint.general.Accueil')}&site=int`, // the Connexion landing (French portal)
    // The URL settles on the authenticated menu / property roster once signed in.
    dashboardMarkers: ['tfpint.general.Menu', 'tfpint.general.MesProprietes'],
    cookieDomains: ['cgtsim.qc.ca']
  },
  auth: { kind: 'cookie' },
  transport: {
    engine: 'node',
    defaultHeaders: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  },
  capabilities: [
    // No spend is extractable, so the Summary tab holds the property roster + downloadable statements (each a
    // single-entity section) rather than a monetary rollup; Billing holds the downloadable invoices.
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchTaxData,
      build: buildSummary,
      sample: sampleTaxData,
      fetchFile: fetchStatementPdf
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchTaxData,
      build: buildBilling,
      sample: sampleTaxData,
      fetchFile: fetchInvoicePdf
    })
  ],
  // The property roster is the cheapest authed page — a session that has expired is served the login page (HTTP 200),
  // so prove liveness by the roster's own screen id being present rather than by status alone.
  probe: async (ctx) => {
    const html = await ctx.client.getText(PROPERTIES_URL)

    if (!html.includes('MesProprietes') && /mot de passe|se connecter/i.test(html)) {
      throw new Error('cgtsim: session expired (login page returned)')
    }
  }
})
