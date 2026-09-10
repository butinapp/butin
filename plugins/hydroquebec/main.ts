import {
  type BrowserContext,
  type BrowserPage,
  type CollectContext,
  defineCapability,
  definePlugin
} from '@butinapp/sdk'
import { type CapabilityResult, capabilityResult, table } from '@butinapp/sdk/data'
import { billing, type BillingStat } from '@butinapp/sdk/presets'
import { byDayDesc, isoDay, parseFrAmount, round2, squish, startCase } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'
import { randomUUID } from 'node:crypto'

import { sampleHydroPortfolio } from './sample.js'

// Hydro-Québec Espace client. One login (Azure AD B2C) reaches EVERY relationship the partner can act on —
// their own accounts plus any business relationship they administer — and each relationship holds one or more
// billing accounts (comptes), each with one or more consumption contracts (a metered address). The acting
// relationship is chosen purely by the `no_partenaire_titulaire` request header, so a headless replay walks the
// whole portfolio by re-issuing each API call once per relationship. Every money value is CAD in major units.

// ── constants ────────────────────────────────────────────────────────────────────────
const SPA_ORIGIN = 'https://session.hydroquebec.com'
const API = 'https://services-cl.solutions.hydroquebec.com'
const WSAPI = `${API}/wsapi/web/prive/api`
const CONSO = `${API}/conso/portraitweb/api/v3_0`
const EEWEB = `${API}/conso/eeweb/api/v1`
const LSW = `${API}/lsw/portail/fr/group/clientele`
const HISTORY_COMPTES = `${LSW}/historique-des-comptes`
const HISTORY_OPS = `${LSW}/historique-des-operations`

// The invoice-history page embeds one download anchor per issued invoice; each href carries the invoice number
// and the per-invoice `idFacturePDF` hash — the pair the portal PDF endpoint needs to stream the file.
const INVOICE_HREF = /noFacture=(\d+)&(?:amp;)?idFacturePDF=([0-9A-Fa-f]+)/

// ── types: the wire shapes (Raw*) then the fetch bundle ────────────────────────────────
export interface RawRelation {
  noPartenaireDemandeur: string
  noPartenaireTitulaire: string
  nom1Titulaire: string
  nom2Titulaire: string
  typeRelation: string
  indEcActif?: boolean
}

// calculerSommaireContractuel — the account→contract map for the acting relationship.
interface RawCompteContratRef {
  noCompteContrat: string
  listeNoContrat: string[]
  titulaire: string
}
interface RawSommaireContractuel {
  comptesContrats?: RawCompteContratRef[]
}

// infoCompte — per-account balances, amounts, dates, billing address, payment method.
export interface RawCompte {
  noCompteContrat: string
  nomTitulaire?: string
  prenomTitulaire?: string
  adresseFacturation?: string
  adresse?: string
  montant?: number
  solde?: number
  soldeEnSouffrance?: number
  dateEmission?: string
  dateEcheance?: string
  dateProchaineFacture?: string
  listeNoContrat?: string[]
  indicateurPA?: boolean
  libelle?: string
  segmentation?: string
}
interface RawInfoCompte {
  infoCockpitPourPartenaireModel?: { listeComptesContrats?: RawCompte[] }
}

// partenaires/contrats — the consumption contract behind each account (address, meter, tariff, start date).
export interface RawContrat {
  noContrat: string
  adresseConsommation?: string
  noCompteContrat?: string
  noInstallation?: string
  noCompteur?: string
  tarifActuel?: string
  dateDebutContrat?: string
  indicateurMVE?: boolean
}
interface RawContratsResponse {
  listeContrats?: RawContrat[]
}

// conso/eeweb/profilEnergetique/{noContrat} — the full billed-period history for one contract (~2 years of
// bi-monthly bills): amount, consumption, and the money breakdown per period.
export interface RawPeriodeFacturation {
  dateDebut?: string
  dateFin?: string
  totalConso?: number
  montantFacture?: number
  montantVenteFraisAccesReseau?: number
  montantCreditCPC?: number
  montantTaxes?: number
  montantConsommation?: number
}
export interface RawProfilEnergetique {
  noContrat: string
  periodesAnalyseFacturation?: RawPeriodeFacturation[]
}

// One downloadable invoice, read straight off the history page: its number + the `idFacturePDF` hash the PDF
// endpoint needs, its amount + date, plus the relationship it belongs to so the download re-issues the
// partner-scoped portal navigation.
export interface InvoiceDoc {
  noFacture: string
  idFacturePDF: string
  date: string | null
  amount: number
  demandeur: string
  titulaire: string
}

// conso/portraitComplet — consumption for one contract: billing periods (kWh + $) and monthly kWh.
export interface RawPeriode {
  dateDebutPeriode?: string
  dateFinPeriode?: string
  consoTotalPeriode?: number
  consoTotalProjetePeriode?: number
  montantFacturePeriode?: number
  moyenneKwhJourPeriode?: number
  nbJourLecturePeriode?: number
}
export interface RawMois {
  dateDebutMois?: string
  consoTotalMoisDecimal?: number
}
export interface RawPortrait {
  noContrat: string
  adresseLieuConsoPartie1?: string
  adresseLieuConsoPartie2?: string
  tarifActuel?: string
  modeChauffage?: string
  listeDonneesConsommationPeriode?: RawPeriode[]
  listeDonneesConsommationMensuelles?: RawMois[]
}

// The full portfolio the shared fetch assembles across every relationship. Each entry carries its owning
// relationship (`titulaire`) so the pure builders can flatten and tag rows without re-resolving anything.
export interface RawPortfolio {
  demandeur: string
  relations: RawRelation[]
  accounts: { titulaire: string; relationName: string; compte: RawCompte }[]
  contracts: { titulaire: string; contrat: RawContrat }[]
  billingPeriods: { noContrat: string; periods: RawPeriodeFacturation[] }[]
  // The issued invoices per account — populated only by the Billing fetch (the other tabs don't read them).
  invoiceDocs: { noCompteContrat: string; docs: InvoiceDoc[] }[]
  portraits: { titulaire: string; portrait: RawPortrait }[]
}

// ── shared helpers ─────────────────────────────────────────────────────────────────────
const relationName = (r: RawRelation): string =>
  [r.nom1Titulaire, r.nom2Titulaire]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' / ')

const HEATING: Record<string, string> = { E: 'Electric', G: 'Gas', B: 'Dual energy', M: 'Mixed' }
const heatingLabel = (code?: string): string => HEATING[code ?? ''] ?? (code ? startCase(code) : '—')

// ── shared fetch: walk every relationship's accounts, contracts, invoices, consumption ──
const partnerHeaders = (demandeur: string, titulaire: string, guid: string): Record<string, string> => ({
  no_partenaire_demandeur: demandeur,
  no_partenaire_titulaire: titulaire,
  guid_session: guid
})

const MAJ_SESSION = `${API}/lsw/portail/prive/maj-session?mode=web&afficherOngletAutorisation=true`

// The partner's user id — the `sub` claim of the minted SPA bearer (`Bearer <header>.<payload>.<sig>`), used to
// key the portal's session-priming analytics call. Undefined off a malformed/absent token.
const bearerSub = (token?: string): string | undefined => {
  const payload = token?.replace(/^Bearer\s+/i, '').split('.')[1]

  if (!payload) {
    return undefined
  }

  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).sub
  } catch {
    return undefined
  }
}

// The whole invoice flow runs on the Spring portal origin, opened directly on a static portal asset (no auth, no
// framebust, no SPA). Booting the SPA instead triggers a B2C OAuth re-auth that aborts the load; rendering a Spring
// page top-level framebusts to the SPA shell. Anchored here, every call — analytics, maj-session, account-select,
// history read, PDF download — runs SAME-ORIGIN: cookies ride along, no CORS, and the Spring pages' framebust
// <script> (`if (top === self) …`) stays inert because a fetch body is just text.
const PORTAL_ANCHOR = `${API}/lsw/portail/hq/libs/jquery-2.2.4.min.js`

// Activate the acting relationship (same-origin from the portal-anchored page). Mint JSESSIONID (analytics, keyed by
// the bearer `sub`), then SESSION + the partner (maj-session, which needs the partner headers +
// `date_derniere_visite`). Magic Login captures at the relationship picker before any relationship is chosen, so
// this select is what makes the account's history reachable.
const primeRelationship = async (
  page: BrowserPage,
  ctx: CollectContext,
  headers: Record<string, string>
): Promise<void> => {
  const token = ctx.authToken?.()
  const auth: Record<string, string> = token ? { Authorization: token } : {}
  const userId = bearerSub(token)

  // Analytics mints JSESSIONID, keyed by the bearer `sub` — its call carries only Authorization + guid_session.
  if (userId) {
    await page
      .fetchText(`${API}/xud/web/api/v1/analytique/${userId}`, {
        headers: { Accept: 'application/json, text/plain, */*', guid_session: headers.guid_session, ...auth }
      })
      .catch(() => null)
  }

  const majHeaders = {
    ...headers,
    'Content-Type': 'text/plain',
    date_derniere_visite: new Date().toISOString().replace('Z', '+00:00'),
    ...auth
  }

  let maj = await page.fetchText(MAJ_SESSION, { headers: majHeaders })

  for (let i = 0; i < 4 && maj.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 600))
    maj = await page.fetchText(MAJ_SESSION, { headers: majHeaders })
  }
}

// Enter one account's history in the portal session (same-origin from the portal-anchored page): load the
// account-list page to establish the session's account context, then actionAfficheHistoriqueDesOperations sets the
// server-side state the history page reads.
const enterAccount = async (page: BrowserContext, ncc: string): Promise<void> => {
  await page.fetchText(HISTORY_COMPTES).catch(() => null)
  await page
    .fetchText(`${HISTORY_COMPTES}/actionAfficheHistoriqueDesOperations?idCompteContrat=${ncc}&typeListe=courants`)
    .catch(() => null)
}

// Parse one account's history page: each invoice row carries its date, its total (the `sort-value` amount), and a
// download anchor whose href holds the invoice number + `idFacturePDF` hash. Payment/adjustment rows carry no such
// anchor, so keying off it yields invoices only.
export const parseInvoiceHistory = (html: string, demandeur: string, titulaire: string): InvoiceDoc[] => {
  const $ = cheerio.load(html)
  const docs: InvoiceDoc[] = []

  $('a[name="resourceVisionnerFacture"]').each((_, el) => {
    const m = INVOICE_HREF.exec($(el).attr('href') ?? '')

    if (!m) {
      return
    }

    const row = $(el).closest('tr')

    docs.push({
      noFacture: m[1],
      idFacturePDF: m[2],
      date: isoDay(row.find('td.bill-date').first().text().trim()) ?? null,
      amount: parseFrAmount(row.find('span.sort-value').first().attr('valeur')),
      demandeur,
      titulaire
    })
  })

  return docs
}

// Every issued invoice for one account, read from the stateful portal: anchor the window on the portal origin, prime
// the relationship, then select the account + fetch its history same-origin (the fetch body is the real invoice
// HTML, the framebust <script> inert). Best-effort — a scrape that yields nothing simply leaves the account's
// invoice section empty.
const scrapeAccountInvoices = async (
  ctx: CollectContext,
  ncc: string,
  demandeur: string,
  titulaire: string,
  headers: Record<string, string>
): Promise<InvoiceDoc[]> => {
  if (!ctx.browser) {
    return []
  }

  try {
    return await ctx.browser.open(PORTAL_ANCHOR, async (page) => {
      await primeRelationship(page, ctx, headers)
      await enterAccount(page, ncc)
      const hist = await page.fetchText(HISTORY_OPS)

      return parseInvoiceHistory(hist.text, demandeur, titulaire)
    })
  } catch (e) {
    ctx.log('hydroquebec: history scrape failed', { ncc, error: String(e) })

    return []
  }
}

// One invoice PDF: the portal's `actionRetournerFichierAjax` streams the bytes to a same-origin XHR under the portal
// session cookies. Anchor + prime + select the invoice's account, then fetch by noFacture + idFacturePDF (the pair
// the history anchor carried). Called per selected row by the files table.
const fetchInvoicePdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  if (!ctx.browser) {
    throw new Error('hydroquebec: invoice download needs an authenticated browser session')
  }

  const demandeur = String(row.demandeur)
  const titulaire = String(row.titulaire)
  const ncc = String(row.account)
  const query = `noFacture=${String(row.noFacture)}&idFacturePDF=${String(row.idFacturePDF)}`
  const headers = partnerHeaders(demandeur, titulaire, randomUUID())

  return ctx.browser.open(PORTAL_ANCHOR, async (page) => {
    await primeRelationship(page, ctx, headers)
    await enterAccount(page, ncc)
    const { status, bytes } = await page.fetchBytes(
      `${HISTORY_OPS}/actionRetournerFichierAjax?${query}&timeoutExec=init`,
      { headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    )

    if (status !== 200 || !bytes.length) {
      throw new Error(`hydroquebec: invoice download failed (status ${status})`)
    }

    return bytes
  })
}

const fetchPortfolio = async (ctx: CollectContext): Promise<RawPortfolio> => {
  const guid = randomUUID()
  const relations = (await ctx.client.get<RawRelation[]>(`${WSAPI}/v1_0/relations`, { guid_session: guid })) ?? []
  const demandeur = relations[0]?.noPartenaireDemandeur ?? ''

  const portfolio: RawPortfolio = {
    demandeur,
    relations,
    accounts: [],
    contracts: [],
    billingPeriods: [],
    invoiceDocs: [],
    portraits: []
  }

  // Distinct relationships (a partner appears once); walk each as the acting titulaire.
  const seen = new Set<string>()

  for (const rel of relations) {
    const titulaire = rel.noPartenaireTitulaire

    if (!titulaire || seen.has(titulaire)) {
      continue
    }

    seen.add(titulaire)
    const headers = partnerHeaders(demandeur, titulaire, guid)
    const name = relationName(rel)

    const sommaire = await ctx.client
      .get<RawSommaireContractuel>(`${WSAPI}/v3_0/partenaires/calculerSommaireContractuel?indMAJNombres=true`, headers)
      .catch(() => null)
    const comptesContrats = sommaire?.comptesContrats ?? []

    const info = await ctx.client
      .get<RawInfoCompte>(`${WSAPI}/v3_0/partenaires/infoCompte?canal=WEB`, headers)
      .catch(() => null)

    for (const compte of info?.infoCockpitPourPartenaireModel?.listeComptesContrats ?? []) {
      portfolio.accounts.push({ titulaire, relationName: name, compte })
    }

    if (comptesContrats.length) {
      const contrats = await ctx.client
        .post<RawContratsResponse>(
          `${WSAPI}/v3_0/partenaires/contrats`,
          { listeServices: ['PC'], comptesContrats },
          headers
        )
        .catch(() => null)

      for (const contrat of contrats?.listeContrats ?? []) {
        portfolio.contracts.push({ titulaire, contrat })
      }
    }

    // Consumption + billed-period history are per contract number, gathered from the sommaire's flattened list.
    for (const noContrat of comptesContrats.flatMap((c) => c.listeNoContrat ?? [])) {
      const portrait = await ctx.client
        .get<RawPortrait>(`${CONSO}/conso/portraitComplet?noContrat=${noContrat}`, headers)
        .catch(() => null)

      if (portrait) {
        portfolio.portraits.push({ titulaire, portrait })
      }

      const profil = await ctx.client
        .get<RawProfilEnergetique>(`${EEWEB}/profilEnergetique/${noContrat}`, headers)
        .catch(() => null)

      if (profil?.periodesAnalyseFacturation?.length) {
        portfolio.billingPeriods.push({ noContrat, periods: profil.periodesAnalyseFacturation })
      }
    }
  }

  return portfolio
}

// The Billing tab additionally enumerates every account's issued invoices (a per-account browser scrape), so it
// stays off the fetch that backs the other tabs. Shared API calls are served from the query cache, so this only
// adds the invoice work.
const fetchBillingPortfolio = async (ctx: CollectContext): Promise<RawPortfolio> => {
  const portfolio = await fetchPortfolio(ctx)
  const guid = randomUUID()

  for (const { titulaire, compte } of portfolio.accounts) {
    const headers = partnerHeaders(portfolio.demandeur, titulaire, guid)
    const docs = await scrapeAccountInvoices(ctx, compte.noCompteContrat, portfolio.demandeur, titulaire, headers)

    if (docs.length) {
      portfolio.invoiceDocs.push({ noCompteContrat: compte.noCompteContrat, docs })
    }
  }

  return portfolio
}

// ── summary: cross-account headline + monthly spend chart ───────────────────────────────
// The monthly-spend chart is the union of every property's billed periods bucketed by month — the full
// ~2-year history the single current bill can't give.
const periodInvoices = (p: RawPortfolio) =>
  p.billingPeriods.flatMap(({ noContrat, periods }) =>
    periods
      .filter((per) => per.dateFin && per.montantFacture != null)
      .map((per) => ({
        id: `${noContrat}:${per.dateFin}`,
        date: isoDay(per.dateFin),
        amount: round2(per.montantFacture!),
        status: 'billed'
      }))
  )

export const buildHydroSummary = (p: RawPortfolio): CapabilityResult => {
  const currentBills = round2(p.accounts.reduce((sum, a) => sum + (a.compte.montant ?? 0), 0))
  const balance = round2(p.accounts.reduce((sum, a) => sum + (a.compte.solde ?? 0), 0))
  const overdue = round2(p.accounts.reduce((sum, a) => sum + (a.compte.soldeEnSouffrance ?? 0), 0))

  const stats: BillingStat[] = [
    { key: 'accounts', label: 'Accounts', role: 'count', value: p.accounts.length },
    { key: 'properties', label: 'Properties', role: 'count', value: p.contracts.length },
    { key: 'balance', label: 'Balance', role: 'money', value: balance, tone: balance > 0 ? 'negative' : 'positive' },
    { key: 'overdue', label: 'Overdue', role: 'money', value: overdue, tone: overdue > 0 ? 'negative' : 'muted' }
  ]

  return billing.summary({
    currentMtd: currentBills,
    currentMtdLabel: 'Current bills',
    invoices: periodInvoices(p),
    stats,
    // Current bills and the period-billed chart measure different things, so a month-over-month delta would
    // compare incomparable bases.
    showDelta: false,
    monthlyTitle: 'Monthly spend'
  })
}

// ── billing: downloadable invoice ledger + the per-property energy breakdown ─────────────
interface InvoiceRow {
  noFacture: string
  address: string
  account: string
  date: string | null
  amount: number
  // Hidden fields the files table replays through fetchInvoicePdf, and the download filename.
  idFacturePDF: string
  demandeur: string
  titulaire: string
  name: string
}

interface PeriodRow {
  contract: string
  address: string
  account: string
  periodStart: string | null
  periodEnd: string | null
  amount: number
  kwh: number
  energy: number
  taxes: number
  credit: number
}

// The Billing tab is two ledgers keyed to each property's REAL consumption address (the billing address lives on
// the Accounts tab): the issued invoices (each a downloadable PDF) and the per-period energy breakdown (~2 years
// of bi-monthly bills with the money split). Both newest first.
export const buildHydroBilling = (p: RawPortfolio): CapabilityResult => {
  const contractByAccount = new Map(p.contracts.map(({ contrat }) => [contrat.noCompteContrat, contrat]))
  const contractByNo = new Map(p.contracts.map(({ contrat }) => [contrat.noContrat, contrat]))

  const invoiceRows: InvoiceRow[] = p.invoiceDocs.flatMap(({ noCompteContrat, docs }) => {
    const address = squish(contractByAccount.get(noCompteContrat)?.adresseConsommation) || noCompteContrat

    return docs.map((doc) => ({
      noFacture: doc.noFacture,
      address,
      account: noCompteContrat,
      date: doc.date,
      amount: doc.amount,
      idFacturePDF: doc.idFacturePDF,
      demandeur: doc.demandeur,
      titulaire: doc.titulaire,
      // The account is in the filename so two properties billed on the same date don't collide to one file.
      name: `Hydro-Québec ${noCompteContrat} ${doc.date ?? doc.noFacture}`
    }))
  })

  invoiceRows.sort(byDayDesc)

  const periodRows: PeriodRow[] = p.billingPeriods.flatMap(({ noContrat, periods }) => {
    const contrat = contractByNo.get(noContrat)
    const account = contrat?.noCompteContrat ?? '—'
    const address = squish(contrat?.adresseConsommation) || noContrat

    return periods.map((per) => ({
      contract: noContrat,
      address,
      account,
      periodStart: isoDay(per.dateDebut) ?? null,
      periodEnd: isoDay(per.dateFin) ?? null,
      amount: round2(per.montantFacture ?? 0),
      kwh: Math.round(per.totalConso ?? 0),
      energy: round2(per.montantConsommation ?? 0),
      taxes: round2(per.montantTaxes ?? 0),
      credit: round2(per.montantCreditCPC ?? 0)
    }))
  })

  periodRows.sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''))

  const invoices = table<InvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'address', label: 'Property', role: 'text', truncate: true },
      { key: 'account', label: 'Account', role: 'identifier' },
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'noFacture', label: 'Invoice', role: 'identifier' },
      { key: 'idFacturePDF', role: 'identifier', hidden: true },
      { key: 'demandeur', role: 'identifier', hidden: true },
      { key: 'titulaire', role: 'identifier', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: invoiceRows,
    key: 'noFacture'
  })

  const periods = table<PeriodRow>({
    id: 'periods',
    columns: [
      { key: 'address', label: 'Property', role: 'text', truncate: true },
      { key: 'periodStart', label: 'From', role: 'timestamp' },
      { key: 'periodEnd', label: 'To', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'kwh', label: 'kWh', role: 'count' },
      { key: 'energy', label: 'Energy', role: 'money' },
      { key: 'taxes', label: 'Taxes', role: 'money' },
      { key: 'credit', label: 'Credit', role: 'money' },
      { key: 'account', role: 'identifier', hidden: true },
      { key: 'contract', role: 'identifier', hidden: true }
    ],
    rows: periodRows,
    key: ['contract', 'periodEnd']
  })

  // The invoice ledger is downloadable (checkboxes + Export) whenever any invoice was enumerated; fetchInvoicePdf
  // pulls the bytes per selected row. With none (no browser and no current invoice) the section is dropped.
  const periodsSection = periods.table({ title: 'Billing periods' })
  const invoiceSection = invoices.fileTable({
    title: 'Invoices',
    name: 'name',
    source: { fetch: true },
    ext: 'pdf',
    category: 'Invoices'
  })

  return capabilityResult({ sections: invoiceRows.length ? [invoiceSection, periodsSection] : [periodsSection] })
}

// ── accounts: per-account billing detail ────────────────────────────────────────────────
interface AccountRow {
  account: string
  holder: string
  address: string
  amount: number
  balance: number
  overdue: number
  dueDate: string | null
  nextBill: string | null
  payment: string
}

export const buildHydroAccounts = (p: RawPortfolio): CapabilityResult => {
  const rows: AccountRow[] = p.accounts.map(({ relationName: holder, compte: c }) => ({
    account: c.noCompteContrat,
    holder,
    address: squish(c.adresseFacturation ?? c.adresse),
    amount: round2(c.montant ?? 0),
    balance: round2(c.solde ?? 0),
    overdue: round2(c.soldeEnSouffrance ?? 0),
    dueDate: isoDay(c.dateEcheance) ?? null,
    nextBill: isoDay(c.dateProchaineFacture) ?? null,
    payment: c.indicateurPA ? c.libelle || 'Preauthorized' : 'Manual'
  }))

  return capabilityResult({
    sections: [
      table<AccountRow>({
        id: 'accounts',
        columns: [
          { key: 'account', label: 'Account', role: 'identifier' },
          { key: 'holder', label: 'Holder', role: 'label' },
          { key: 'address', label: 'Billing address', role: 'text', truncate: true },
          { key: 'amount', label: 'Current bill', role: 'money' },
          { key: 'balance', label: 'Balance', role: 'money' },
          { key: 'overdue', label: 'Overdue', role: 'money' },
          { key: 'dueDate', label: 'Due', role: 'timestamp' },
          { key: 'nextBill', label: 'Next bill', role: 'timestamp' },
          { key: 'payment', label: 'Payment', role: 'category' }
        ],
        rows,
        key: 'account'
      }).table({ title: 'Accounts' })
    ]
  })
}

// ── properties: per-contract metered address ────────────────────────────────────────────
interface PropertyRow {
  contract: string
  address: string
  account: string
  meter: string
  tariff: string
  heating: string
  equalPayments: string
  since: string | null
}

export const buildHydroProperties = (p: RawPortfolio): CapabilityResult => {
  const heatingByContract = new Map(p.portraits.map(({ portrait }) => [portrait.noContrat, portrait.modeChauffage]))

  const rows: PropertyRow[] = p.contracts.map(({ contrat: c }) => ({
    contract: c.noContrat,
    address: squish(c.adresseConsommation),
    account: c.noCompteContrat ?? '—',
    meter: c.noCompteur ?? '—',
    tariff: c.tarifActuel ?? '—',
    heating: heatingLabel(heatingByContract.get(c.noContrat)),
    equalPayments: c.indicateurMVE ? 'Equalized' : 'Regular',
    since: isoDay(c.dateDebutContrat) ?? null
  }))

  return capabilityResult({
    sections: [
      table<PropertyRow>({
        id: 'properties',
        columns: [
          { key: 'address', label: 'Address', role: 'text', truncate: true },
          { key: 'account', label: 'Account', role: 'identifier' },
          { key: 'contract', label: 'Contract', role: 'identifier' },
          { key: 'meter', label: 'Meter', role: 'identifier' },
          { key: 'tariff', label: 'Rate', role: 'category' },
          { key: 'heating', label: 'Heating', role: 'category' },
          { key: 'equalPayments', label: 'Billing mode', role: 'category' },
          { key: 'since', label: 'Since', role: 'timestamp' }
        ],
        rows,
        key: 'contract'
      }).table({ title: 'Properties' })
    ]
  })
}

// ── consumption: latest period per property + monthly kWh trend ─────────────────────────
interface ConsumptionRow {
  contract: string
  address: string
  periodEnd: string | null
  kwh: number
  projected: number
  amount: number
  avgPerDay: number
  days: number
}
interface MonthlyKwhRow {
  month: string
  property: string
  kwh: number
}

const shortAddr = (portrait: RawPortrait): string => squish(portrait.adresseLieuConsoPartie1) || portrait.noContrat

export const buildHydroConsumption = (p: RawPortfolio): CapabilityResult => {
  const rows: ConsumptionRow[] = p.portraits.map(({ portrait }) => {
    const last = (portrait.listeDonneesConsommationPeriode ?? []).at(-1)

    return {
      contract: portrait.noContrat,
      address: shortAddr(portrait),
      periodEnd: isoDay(last?.dateFinPeriode) ?? null,
      kwh: Math.round(last?.consoTotalPeriode ?? 0),
      projected: Math.round(last?.consoTotalProjetePeriode ?? 0),
      amount: round2(last?.montantFacturePeriode ?? 0),
      avgPerDay: round2(last?.moyenneKwhJourPeriode ?? 0),
      days: last?.nbJourLecturePeriode ?? 0
    }
  })

  const monthly: MonthlyKwhRow[] = p.portraits.flatMap(({ portrait }) =>
    (portrait.listeDonneesConsommationMensuelles ?? [])
      .filter((m) => m.dateDebutMois && m.consoTotalMoisDecimal != null)
      // The month bucket is the 'YYYY-MM' prefix of the period-start day (as the billing preset buckets spend).
      .map((m) => ({
        month: (isoDay(m.dateDebutMois) ?? '').slice(0, 7),
        property: shortAddr(portrait),
        kwh: round2(m.consoTotalMoisDecimal!)
      }))
  )

  return capabilityResult({
    sections: [
      table<ConsumptionRow>({
        id: 'consumption',
        columns: [
          { key: 'address', label: 'Property', role: 'label' },
          { key: 'periodEnd', label: 'Period end', role: 'timestamp' },
          { key: 'kwh', label: 'kWh', role: 'count' },
          { key: 'projected', label: 'Projected kWh', role: 'count' },
          { key: 'amount', label: 'Amount', role: 'money' },
          { key: 'avgPerDay', label: 'kWh/day', role: 'count' },
          { key: 'days', label: 'Days read', role: 'count' },
          { key: 'contract', role: 'identifier', hidden: true }
        ],
        rows,
        key: 'contract'
      }).table({ title: 'Latest period' }),
      table<MonthlyKwhRow>({
        id: 'monthly-kwh',
        columns: [
          { key: 'month', label: 'Month', role: 'timestamp' },
          { key: 'property', label: 'Property', role: 'category' },
          { key: 'kwh', label: 'kWh', role: 'count' }
        ],
        rows: monthly,
        key: ['month', 'property']
      }).timeseries({
        x: 'month',
        y: 'kwh',
        granularity: 'monthly',
        stackBy: 'property',
        title: 'Monthly consumption (kWh)'
      })
    ]
  })
}

// ── descriptor ──────────────────────────────────────────────────────────────────────────
export const hydroquebecPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'hydroquebec',
    name: 'Hydro-Québec',
    vendor: 'Hydro-Québec',
    category: 'utilities',
    color: '#009ee0',
    description: 'Hydro-Québec accounts, bills, properties, and electricity consumption across every relationship.',
    homepage: 'https://www.hydroquebec.com',
    dashboardUrl: 'https://session.hydroquebec.com/'
  },
  // The Angular Espace client mints its Bearer in-memory via B2C silent renew off the durable SSO cookie, so it
  // can't be replayed headless — core boots the SPA offscreen and captures the Authorization header off the wire.
  session: {
    loginUrl: SPA_ORIGIN,
    dashboardMarkers: ['/portail/fr/group/clientele/gerer-mon-compte', '/client/group/'],
    cookieDomains: ['hydroquebec.com'],
    // The B2C CSRF cookie is cleared so a promoted stale one can't poison the next sign-in's OAuth state. The
    // portal session cookies (SESSION + JSESSIONID) are KEPT — they carry the stateful lsw portal session the
    // invoice-history collector replays headless; the portal rotates them on each use, so a stale one is refreshed,
    // not wedged. The durable SSO cookie also persists.
    clearCookiesBeforeCapture: ['x-ms-cpim-csrf']
  },
  auth: {
    kind: 'spa-bearer',
    bootUrl: `${SPA_ORIGIN}/`,
    authCaptureUrlPatterns: [`${API}/wsapi/*`, `${API}/conso/*`],
    clearOnStatuses: [401]
  },
  transport: {
    engine: 'node',
    defaultHeaders: {
      Accept: 'application/json, text/plain, */*',
      Origin: SPA_ORIGIN,
      Referer: `${SPA_ORIGIN}/`,
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchPortfolio,
      build: buildHydroSummary,
      sample: sampleHydroPortfolio
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchBillingPortfolio,
      build: buildHydroBilling,
      sample: sampleHydroPortfolio,
      fetchFile: fetchInvoicePdf
    }),
    defineCapability({
      id: 'accounts',
      label: 'Accounts',
      fetch: fetchPortfolio,
      build: buildHydroAccounts,
      sample: sampleHydroPortfolio
    }),
    defineCapability({
      id: 'properties',
      label: 'Properties',
      fetch: fetchPortfolio,
      build: buildHydroProperties,
      sample: sampleHydroPortfolio
    }),
    defineCapability({
      id: 'consumption',
      label: 'Consumption',
      fetch: fetchPortfolio,
      build: buildHydroConsumption,
      sample: sampleHydroPortfolio
    })
  ],
  probe: async (ctx) => {
    // The relationship list is the cheapest authed call — a 200 proves the minted Bearer is live.
    await ctx.client.get(`${WSAPI}/v1_0/relations`)
  }
})
