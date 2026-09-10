import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult, type Summary } from '@butinapp/sdk/data'
import { asArray, byDayDesc, parseFrAmount, round2 } from '@butinapp/sdk/util'

import { collectDebitStatements, fetchDebitStatementFile } from './debit-statements.js'
import { sampleDesjardinsComptes, sampleDesjardinsStatements } from './sample.js'

// Desjardins — AccèsD, the online portal of the Québec cooperative bank (accesd.desjardins.com). The
// authenticated SPA reads JSON APIs; the richest one, `obtenirListeMesComptes`, returns the whole
// account holdings in three "tiroirs" (drawers): bank accounts, cards/loans/margins, and
// savings/investments — we replay it and normalize it into a holdings dashboard (the `accounts`
// capability). A second `statements` capability pulls credit-card statements (relevés de carte de crédit)
// as PDFs off the modern `gestionnaire-releve-carte-credit/v2` JSON API: list cards → list ALL statements
// → download each PDF. The list call (`relevesListe`) accepts EITHER `{nbreReleve}` (last N) OR
// `{dateDebut,dateFin}` (a window); the AccèsD UI pages ONE YEAR at a time (the server appears to cap the
// window), so we walk backwards year-by-year from the current year to lift the WHOLE history, logging each
// year's count and stopping after a run of empty years (see fetchAllStatements). (The bank-account / DEBIT
// monthly statements ride the legacy `coreleADReleve` Struts flow — a multi-step popup with a one-time
// `org.apache.struts.taglib.html.TOKEN` and ISO-8859-1 HTML, and one-time D1/K PDF tokens minted per
// confirm — see debit-statements.ts, exposed as the `releves-compte` downloadable table. That legacy flow
// is fragile and its final PDF GET is unconfirmed against a live account, so it's the part most in need of
// a live-account check.)
//
// AUTH is `spa-bearer` (two-host split). You sign in by hand at AccèsD (Identifiant + password + 2-step
// verification); the SSO cookies (`atk_accesd` JWT, `ADAUTHORIZATION`, `JSESSIONID`, `infra`) are
// captured on `.desjardins.com` / `.mouv.desjardins.com`. The two backends authenticate differently:
//   • accesd.mouv  (sommaire-perso, the `accounts` capability) — COOKIE only, no Authorization header.
//   • accesdc.mouv (api/distribution-libreservice/*, the `statements` capability) — a short-lived
//     `Authorization: Bearer` minted IN-MEMORY by the SPA via a silent OIDC renew (id.desjardins.com
//     /authorize?prompt=none → /webapp/securite/authentification/callback). It is NOT in any cookie or
//     storage, so a cookie-only replay 401s. `spa-bearer` makes core boot the SPA offscreen on the shared
//     partition, capture that Bearer off the wire, cache it, and attach it ALONGSIDE the cookie on every
//     request — so the cookie-only accounts call and the Bearer-gated statements call both work.
//
// EDGE: the domain only accepts a real browser (it sets `_abck`, `bm_sz`, `ak_bmsc` cookies),
// so `engine: 'electron'` replays with the real browser's TLS identity. The UA
// must match the capture window UA (those cookies bind to it). The login page lives on
// accweb.mouv, the SPA on accesdc.mouv, and the data API on accesd.mouv — all under .mouv.desjardins.com,
// so one cookie domain ('desjardins.com') spans them. The API expects same-site Origin/Referer of the
// SPA host (accesdc.mouv), set via defaultHeaders.
//
// MONEY is CAD, formatted fr-CA ("24 716,80 $" — space thousands sep, comma decimal, $ suffix). The
// bank's own drawer totals (montantComptes / montantPretsCartesMarges / montantTotal) are authoritative
// and are NOT a plain sum of their items, so we parse them verbatim rather than re-summing.
//
// The session is short-lived (the access-token cookie expires in ~1h and AccèsD times out idle sessions
// quickly), so headless replay works only for a while after capture — a 401 clears the cookie and the UI
// re-prompts Magic Login.

const API_ORIGIN = 'https://accesd.mouv.desjardins.com'
const SPA_ORIGIN = 'https://accesdc.mouv.desjardins.com'
const LOGIN_URL = 'https://accesd.desjardins.com'
const COMPTES_PATH = '/sommaire-perso/api/v1/mescomptes/obtenirListeMesComptes'
const CURRENCY = 'CAD'

// Credit-card statements (relevés de carte de crédit) live on a separate modern JSON API on the SPA host
// (accesdc.mouv, note the trailing 'c'), so these are absolute URLs not subject to `transport.baseUrl`.
const CC_BASE = `${SPA_ORIGIN}/api/distribution-libreservice/releveetdocument/gestionnaire-releve-carte-credit/v2`
const CC_DETENTION = `${CC_BASE}/detention-carte-credit`
const CC_RELEVES_LISTE = `${CC_BASE}/relevesListe`
const CC_DOCUMENTS = `${CC_BASE}/documents`
const CC_REFERER = `${SPA_ORIGIN}/credit/gestionnaire-releve/particulier/`

// Per-host headers. The accesdc.mouv API calls are cross-origin XHRs the SPA fires from accesdc.mouv, so
// they carry that Origin/Referer AND the SPA-minted Bearer (sendAuth default). The accesd.mouv account API
// is COOKIE-only (its sommaire-perso backend 403s the accesdc-audience Bearer) — same Origin/Referer, but
// the Bearer is suppressed (sendAuth:false). The legacy debit navigations (debit-statements.ts) send no
// Origin and no Bearer at all.
const CC_HEADERS: Record<string, string> = { Origin: SPA_ORIGIN, Referer: CC_REFERER }
const ACCOUNTS_HEADERS: Record<string, string> = { Origin: SPA_ORIGIN, Referer: `${SPA_ORIGIN}/` }

// --- parsers ---

// descriptions is a ragged array (label, nickname, caisse/masked-number) with empty slots — join the
// non-empty parts into one human label, e.g. ["500465-EOP …","","Terrebonne"] → "500465-EOP … — Terrebonne".
const joinDescriptions = (descriptions?: string[]): string =>
  (descriptions ?? [])
    .map((d) => d?.trim())
    .filter(Boolean)
    .join(' — ')

// Humanize the financing product enum; fall back to the raw type for unknown kinds.
const FINANCING_LABELS: Record<string, string> = {
  COMPTE_VISA: 'Carte de crédit',
  COMPTE_VISA_PREPAYE: 'Carte prépayée',
  COMPTE_MARGE_CREDIT: 'Marge de crédit',
  COMPTE_PRET: 'Prêt'
}

const financingType = (raw?: string): string => (raw ? (FINANCING_LABELS[raw] ?? raw) : '')

// --- the obtenirListeMesComptes shape (only the fields we read) ---

type DesjBankAccount = {
  descriptions?: string[]
  type?: string
  montantAvecDevise?: string
  codeISODevise?: string
}

type DesjFinancingProduct = {
  descriptions?: string[]
  montantAvecDevise?: string
  codeISODevise?: string
  produitFinancementRessourceType?: string
}

type DesjInvestmentResource = {
  descriptions?: string[]
  montant?: string
  type?: string
  dateEcheance?: string | null
  numeroCompte?: string
}

export type DesjComptesResponse = {
  dataTiroirComptesBancaires?: { montantComptes?: string; listeCompte?: DesjBankAccount[] }
  dataTiroirCartesPretsMarges?: { montantPretsCartesMarges?: string; listeProduitFinancement?: DesjFinancingProduct[] }
  dataTiroirEpargnePlacements?: { montantTotal?: string; epargnePlacementRessources?: DesjInvestmentResource[] }
}

// --- normalized holdings ---

export type DesjAccount = {
  name: string
  amount: number
}

export type DesjCredit = {
  name: string
  type: string
  amount: number
}

export type DesjInvestment = {
  name: string
  /** 'YYYY-MM-DD' maturity, or '' when none. */
  maturity: string
  amount: number
}

export type DesjHoldings = {
  accounts: DesjAccount[]
  credit: DesjCredit[]
  investments: DesjInvestment[]
  /** The bank's own authoritative drawer totals (CAD), parsed verbatim — not a sum of the items. */
  totals: { bank: number; credit: number; investments: number }
}

// Pure transform — fixture-tested. The raw API response → normalized holdings.
export const parseHoldings = (res: DesjComptesResponse): DesjHoldings => {
  const bank = res.dataTiroirComptesBancaires
  const financing = res.dataTiroirCartesPretsMarges
  const savings = res.dataTiroirEpargnePlacements

  return {
    accounts: (bank?.listeCompte ?? []).map((c) => ({
      name: joinDescriptions(c.descriptions),
      amount: parseFrAmount(c.montantAvecDevise)
    })),
    credit: (financing?.listeProduitFinancement ?? []).map((p) => ({
      name: joinDescriptions(p.descriptions),
      type: financingType(p.produitFinancementRessourceType),
      amount: parseFrAmount(p.montantAvecDevise)
    })),
    investments: (savings?.epargnePlacementRessources ?? []).map((r) => ({
      name: joinDescriptions(r.descriptions),
      maturity: r.dateEcheance ?? '',
      amount: parseFrAmount(r.montant)
    })),
    totals: {
      bank: parseFrAmount(bank?.montantComptes),
      credit: parseFrAmount(financing?.montantPretsCartesMarges),
      investments: parseFrAmount(savings?.montantTotal)
    }
  }
}

type DesjTotalsRow = {
  bank: number
  investments: number
  credit: number
  net: number
}

type DesjAccountRow = {
  name: string
  amount: number
}

type DesjCreditRow = {
  name: string
  type: string
  amount: number
}

type DesjInvestmentRow = {
  name: string
  maturity: string
  amount: number
}

// Pure transform — fixture-tested. Holdings → a holdings dashboard: a net-worth `balance` summary (so it
// rolls up on the cross-service Overview), a totals stat band, and a table per non-empty drawer. Renders
// via the generic <DashboardRenderer> (any result with datasets does) — no bespoke UI.
export const buildDesjardinsAccounts = (h: DesjHoldings): CapabilityResult => {
  // Net worth: assets (bank + investments) minus the financing drawer (cards/loans/margins owed).
  const net = round2(h.totals.bank + h.totals.investments - h.totals.credit)

  const summary: Summary = { section: 'balance', label: 'Avoir net', value: net, role: 'money', currency: CURRENCY }

  const totals = record<DesjTotalsRow>({
    id: 'totals',
    fields: [
      { key: 'bank', label: 'Comptes', role: 'money', currency: CURRENCY },
      { key: 'investments', label: 'Épargne et placements', role: 'money', currency: CURRENCY },
      { key: 'credit', label: 'Cartes, prêts et marges', role: 'money', currency: CURRENCY },
      { key: 'net', label: 'Avoir net', role: 'money', currency: CURRENCY }
    ],
    value: { bank: h.totals.bank, investments: h.totals.investments, credit: h.totals.credit, net }
  })

  const accounts =
    h.accounts.length > 0
      ? table<DesjAccountRow>({
          id: 'accounts',
          columns: [
            { key: 'name', label: 'Compte', role: 'label' },
            { key: 'amount', label: 'Solde', role: 'money', currency: CURRENCY }
          ],
          rows: h.accounts.map((a) => ({ name: a.name, amount: a.amount })),
          // The account label (built from its number/description) is the stable identity, so each account's
          // balance accumulates its history in the ledger.
          key: 'name'
        })
      : null

  const credit =
    h.credit.length > 0
      ? table<DesjCreditRow>({
          id: 'credit',
          columns: [
            { key: 'name', label: 'Produit', role: 'label' },
            { key: 'type', label: 'Type', role: 'text' },
            { key: 'amount', label: 'Solde', role: 'money', currency: CURRENCY }
          ],
          rows: h.credit.map((c) => ({ name: c.name, type: c.type, amount: c.amount })),
          key: 'name'
        })
      : null

  const investments =
    h.investments.length > 0
      ? table<DesjInvestmentRow>({
          id: 'investments',
          columns: [
            { key: 'name', label: 'Placement', role: 'label' },
            { key: 'maturity', label: 'Échéance', role: 'timestamp' },
            { key: 'amount', label: 'Montant', role: 'money', currency: CURRENCY }
          ],
          rows: h.investments.map((i) => ({ name: i.name, maturity: i.maturity, amount: i.amount })),
          key: 'name'
        })
      : null

  return capabilityResult({
    sections: [
      totals.stat({ title: 'Sommaire' }),
      accounts?.table({ title: 'Comptes' }),
      credit?.table({ title: 'Cartes, prêts et marges' }),
      investments?.table({ title: 'Épargne et placements' })
    ],
    summaries: [summary]
  })
}

const fetchHoldings = async (ctx: CollectContext): Promise<DesjComptesResponse> => {
  // accesd.mouv account API: cookie-only (the SPA Bearer is for the accesdc.mouv audience and 403s here).
  const res = (
    await ctx.client.request<DesjComptesResponse>({ url: COMPTES_PATH, sendAuth: false, headers: ACCOUNTS_HEADERS })
  ).data

  // A 200 with none of the three drawers means the session didn't resolve to a real account view.
  if (!res?.dataTiroirComptesBancaires && !res?.dataTiroirCartesPretsMarges && !res?.dataTiroirEpargnePlacements) {
    throw new Error('Desjardins: no account data returned — open the connection and sign in to AccèsD again.')
  }

  return res
}

const buildAccountsResult = (raw: DesjComptesResponse): CapabilityResult => buildDesjardinsAccounts(parseHoldings(raw))

// --- documents: credit-card statements (relevés de carte de crédit) ---

// One card from /detention-carte-credit (only the fields we read). The signed token authorizes the
// statement reads; it is opaque and account-scoped.
export type DesjCard = {
  numeroCompteJeton?: string
  numeroCompteJetonSigne?: string
  descriptionLongue?: string
  descriptionCourte?: string
  codeRolePartieEntente?: string
}

// One statement from /relevesListe → sommaireRelevesListe[].
export type DesjStatement = {
  numeroCompteJeton?: string
  dateReleve?: string
  typeReleve?: string
  uuidReleve?: string
  // Stable dedup/union identity synthesized by fetchAllStatements (jeton|dateReleve|typeReleve) — uuidReleve is
  // regenerated per call, so it can't serve as the incremental capability's row id.
  statementId?: string
}

export const parseCards = (res: unknown): DesjCard[] => asArray<DesjCard>(res)

export const parseStatements = (res: unknown): DesjStatement[] =>
  asArray<DesjStatement>((res as { sommaireRelevesListe?: DesjStatement[] } | null)?.sommaireRelevesListe)

// The signed account token is percent-escaped INSIDE the /relevesListe JSON body, but the browser only
// escapes `+` and `=` there (it leaves `/` raw) — whereas the /documents query string uses full
// encodeURIComponent. The server matches the token verbatim, so replicate the body form exactly.
export const encodeSignedForBody = (s: string): string => s.replace(/\+/g, '%2B').replace(/=/g, '%3D')

// The per-statement PDF download URL (the /documents query the original popup fired). The signed token is
// percent-escaped with full encodeURIComponent here (the query string form, unlike encodeSignedForBody's
// body form). The server matches it verbatim, so the host GETs this URL as-is (with the CC_REFERER below).
const statementDownloadUrl = (jeton: string, signed: string, typeReleve: string, dateReleve: string): string =>
  `${CC_DOCUMENTS}?numeroCompteJeton=${encodeURIComponent(jeton)}` +
  `&numeroCompteSigne=${encodeURIComponent(signed)}` +
  `&typeReleve=${encodeURIComponent(typeReleve)}&format=pdf&dateReleve=${encodeURIComponent(dateReleve)}`

type DesjStatementRow = {
  date: string
  card: string
  type: string
  downloadUrl: string
  // Not a rendered column — carried for the download filename (the files `name` key).
  name: string
}

// Pure transform — fixture-tested. Cards + statements → a DOWNLOADABLE statements table (each row's PDF URL
// is the file URL; the host downloads it via the shared engine with the CC_REFERER from transport.download —
// no separate documents tab). The signed token is matched from the card list by account-token (statement rows
// don't carry it); the card's long description rides on the row as the label + the download filename.
export const buildStatementsTable = (cards: DesjCard[], statements: DesjStatement[]): CapabilityResult => {
  const cardByJeton = new Map(cards.map((c) => [c.numeroCompteJeton ?? '', c]))
  const rows: DesjStatementRow[] = []
  const seen = new Set<string>()

  for (const s of statements) {
    const jeton = s.numeroCompteJeton ?? ''
    const card = cardByJeton.get(jeton)
    const signed = card?.numeroCompteJetonSigne

    if (!jeton || !signed || !s.dateReleve) {
      continue
    }

    const typeReleve = s.typeReleve ?? 'Individuel'
    // Adjacent year-windows share their Jan-1 boundary, so the same statement can come back from two
    // year scans — dedupe by account + date + type (uuidReleve is regenerated per call, not a stable key).
    const key = `${jeton}|${s.dateReleve}|${typeReleve}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)

    const cardName = card?.descriptionLongue || card?.descriptionCourte || jeton

    rows.push({
      date: s.dateReleve,
      card: cardName,
      type: typeReleve,
      downloadUrl: statementDownloadUrl(jeton, signed, typeReleve, s.dateReleve),
      name: `Relevé ${cardName} ${s.dateReleve}`
    })
  }

  rows.sort(byDayDesc)

  return capabilityResult({
    sections: [
      table<DesjStatementRow>({
        id: 'statements',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'card', label: 'Carte', role: 'label' },
          { key: 'type', label: 'Type', role: 'text' },
          { key: 'downloadUrl', label: 'PDF', role: 'url' },
          { key: 'name', role: 'label', hidden: true }
        ],
        rows,
        // A statement is identified by its card + date + type (the same triple the dedup above keys on), so
        // each statement accumulates once in the ledger.
        key: ['card', 'date', 'type']
      }).fileTable({
        title: 'Relevés de carte de crédit',
        name: 'name',
        source: { url: 'downloadUrl' },
        ext: 'pdf',
        category: 'Relevés de carte'
      })
    ]
  })
}

// The relevesListe POST windows by year — `{dateDebut,dateFin}` over one calendar year. Pure (no IO) so
// it's fixture-tested: the signed token is escaped for the BODY form (encodeSignedForBody), and the role
// comes off the first card. dateFin is the NEXT Jan 1 (the boundary statement is deduped downstream).
export const relevesBodyForYear = (year: number, cards: DesjCard[]): Record<string, unknown> => ({
  dateDebut: `${year}-01-01`,
  dateFin: `${year + 1}-01-01`,
  codeRolePartieEntente: cards[0]?.codeRolePartieEntente ?? 'P',
  compteListes: cards.map((c) => ({
    numeroCompteJeton: c.numeroCompteJeton,
    numeroCompteJetonSigne: encodeSignedForBody(c.numeroCompteJetonSigne ?? '')
  }))
})

// AccèsD only serves card statements a few years back (for the recorded cards: to 2021) and windows by
// year, so we scan backwards from the current year. We stop after CC_MAX_EMPTY_YEARS consecutive empty
// years past the newest data (the account-opening / retention floor), at CC_MIN_YEAR, or — for an
// incremental refresh — once the year drops below `ctx.since`'s year (that history is already in the kept
// union). LOG every year's count (and any fetch error + the year it died on) so a future run can see
// exactly how far back data went instead of re-probing blindly. CC_MIN_YEAR is a generous absolute floor
// (AccèsD predates it).
const CC_MIN_YEAR = 2000
const CC_MAX_EMPTY_YEARS = 3

// jeton|dateReleve|typeReleve is the statement's stable identity — uuidReleve is regenerated per call. The
// `typeReleve` segment defaults the same way `buildStatementsTable`'s own dedup key does, so a statement missing
// `typeReleve` gets the SAME identity here as it does there.
const withStatementId = (s: DesjStatement): DesjStatement => ({
  ...s,
  statementId: `${s.numeroCompteJeton ?? ''}|${s.dateReleve ?? ''}|${s.typeReleve ?? 'Individuel'}`
})

export const fetchAllStatements = async (ctx: CollectContext, cards: DesjCard[]): Promise<DesjStatement[]> => {
  const all: DesjStatement[] = []
  const currentYear = new Date().getUTCFullYear()
  let consecutiveEmpty = 0

  for (let year = currentYear; year >= CC_MIN_YEAR; year--) {
    // ctx.since is undefined on a first run / forced full refetch, so every year is walked then.
    if (ctx.since && year < Number(ctx.since.slice(0, 4))) {
      break
    }

    let list: DesjStatement[]

    try {
      list = parseStatements(await ctx.client.post(CC_RELEVES_LISTE, relevesBodyForYear(year, cards), CC_HEADERS))
    } catch (err) {
      // A 401 mid-scan means the session died — surface it; anything else, log the year and stop the scan
      // (we keep what we already gathered) so a retry has the exact failure point rather than guessing.
      ctx.log(`statements ${year}: fetch failed, stopping back-scan`, { error: String(err) })
      break
    }

    ctx.log(`statements ${year}: ${list.length}`)

    if (list.length > 0) {
      all.push(...list.map(withStatementId))
      consecutiveEmpty = 0
    } else if (++consecutiveEmpty >= CC_MAX_EMPTY_YEARS) {
      ctx.log(`statements: ${CC_MAX_EMPTY_YEARS} empty years in a row ending at ${year} — stopping back-scan`)
      break
    }
  }

  return all
}

export type DesjStatementsBundle = {
  cards: DesjCard[]
  statements: DesjStatement[]
}

const fetchStatements = async (ctx: CollectContext): Promise<DesjStatementsBundle> => {
  const cards = parseCards(await ctx.client.get(CC_DETENTION, CC_HEADERS))

  if (cards.length === 0) {
    throw new Error('Desjardins: no credit cards found — open the connection and sign in to AccèsD again.')
  }

  return { cards, statements: await fetchAllStatements(ctx, cards) }
}

// French-canonical plugin → ships an `en` map for its banking vocabulary (passes through under a French app).
const DESJARDINS_EN: Record<string, string> = {
  Sommaire: 'Summary',
  Comptes: 'Accounts',
  Compte: 'Account',
  'Cartes, prêts et marges': 'Cards, loans & lines of credit',
  'Épargne et placements': 'Savings & investments',
  'Relevés de carte': 'Card statements',
  'Relevés de carte de crédit': 'Credit card statements',
  'Relevés de compte': 'Account statements',
  'Avoir net': 'Net worth',
  Carte: 'Card',
  Placement: 'Investment',
  Produit: 'Product',
  Solde: 'Balance',
  Montant: 'Amount',
  Échéance: 'Due date',
  Date: 'Date',
  Type: 'Type',
  PDF: 'PDF'
}

export const desjardinsPlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'desjardins',
    name: 'Desjardins',
    vendor: 'Desjardins',
    category: 'finance',
    color: '#00874e',
    homepage: 'https://www.desjardins.com',
    dashboardUrl: 'https://accesd.desjardins.com',
    messages: { en: DESJARDINS_EN },
    description:
      'Desjardins AccèsD — bank accounts, cards/loans/margins, savings & investments, net worth, and credit-card statement PDFs.'
  },
  session: {
    loginUrl: LOGIN_URL,
    // The settled authenticated SPA lands on accesdc.mouv/accueil; the data API lives under accesd.mouv.
    dashboardMarkers: ['accesdc.mouv.desjardins.com/accueil', '/sommaire-perso'],
    // One substring spans accesd.mouv / accesdc.mouv / accweb.mouv and the apex .desjardins.com cookies.
    cookieDomains: ['desjardins.com'],
    // The access-token JWT cookie — present only once 2-step verification completes.
    requiredCookie: 'atk_accesd',
    // AccèsD's session tokens are session-scoped HttpOnly cookies; once the server expires them, a
    // PROMOTED stale copy poisons the next sign-in → "profil d'accès… (ID000008)". So never persist this
    // service's jar, and Magic Login wipes it before each sign-in — every reconnect starts clean. Cost:
    // re-login on each app launch (acceptable, and arguably preferable, for a bank).
    persistCookies: false
  },
  auth: {
    // The accesdc.mouv APIs need a Bearer the SPA mints in-memory (silent OIDC) — core boots the SPA
    // offscreen on the shared partition and captures it off the wire. The Bearer rides on every
    // accesdc.mouv `/api/*` call the SPA fires on /accueil, so that's the capture filter. There is no
    // sessionStorage copy (in-memory only), so the capture is webRequest-only — no fast-path prefix.
    kind: 'spa-bearer',
    bootUrl: `${SPA_ORIGIN}/accueil`,
    authCaptureUrlPatterns: [`${SPA_ORIGIN}/api/*`]
  },
  transport: {
    // The edge only accepts a real browser — replay with the real browser's TLS identity via Electron net.request.
    engine: 'electron',
    baseUrl: API_ORIGIN,
    // UA is injected centrally (browser/identity.ts) for both capture and replay, so they always agree —
    // no hand-pinned string here (a frozen version would drift from the real Chromium and break the edge cookie bind).
    // Origin/Referer are HOST-SPECIFIC (accesdc.mouv API vs accesd.mouv legacy navigations), so they are
    // NOT global here — each collector sets them per call (a cross-origin Origin header on the accesd.mouv
    // navigation GETs is exactly what the edge rejects). Only host-neutral content negotiation lives globally.
    defaultHeaders: {
      'Accept-Language': 'fr',
      Accept: '*/*'
    },
    // The credit-card /documents endpoint 403s without the gestionnaire-releve referer. concurrency:1
    // because the legacy debit flow drives ONE stateful AccèsWeb session (Struts token + modale state)
    // per download — serial, no clobbering (the credit-card URL GETs serialize harmlessly alongside).
    download: { referer: CC_REFERER, concurrency: 1 }
  },
  capabilities: [
    defineCapability({
      id: 'accounts',
      label: 'Comptes',
      fetch: fetchHoldings,
      build: buildAccountsResult,
      sample: sampleDesjardinsComptes
    }),
    // The credit-card statements aren't a separate documents tab — this table is downloadable (its
    // downloadUrl column carries each statement's PDF endpoint; the host downloads via the shared engine).
    defineCapability({
      id: 'statements',
      label: 'Relevés de carte',
      fetch: fetchStatements,
      build: (raw) => buildStatementsTable(raw.cards, raw.statements),
      sample: sampleDesjardinsStatements,
      // Incremental: a refresh re-walks only the recent window + any newer years (fetchAllStatements honours
      // ctx.since); the kept union retains the full history, and build runs over all of it. 45d covers a
      // statement AccèsD posts a little late for the prior period.
      incremental: { listKey: 'statements', id: 'statementId', timestamp: 'dateReleve', window: { days: 45 } }
    }),
    // Bank-account (debit) monthly statements via the legacy coreleADReleve flow — a downloadable table that
    // lists every available month and fetches each PDF on demand (see debit-statements.ts). The fetch half
    // drives a live offscreen browser (the legacy AccèsWeb session can't be replayed headless), so it stays a
    // bare imperative collector with no synthetic sample — the demo seed falls back generically.
    {
      id: 'releves-compte',
      label: 'Relevés de compte',
      collect: collectDebitStatements,
      fetchFile: fetchDebitStatementFile
    }
  ],
  // Probe session liveness via the credit-card detention endpoint — a single cheap Bearer-gated GET on the
  // SPA host that returns JSON whenever the session is alive (the same call the statements collector starts
  // with). The cookie-only accounts backend can serve an HTML app-shell even on a live session, so probing it
  // would mark a perfectly connected service "unreachable" and (via Refresh-All's probe gate) block every other
  // capability; the detention call doesn't share that failure mode. A broken accounts replay then surfaces on
  // its own tab, not as a dead service.
  probe: async (ctx) => {
    await ctx.client.get(CC_DETENTION, CC_HEADERS)
  }
})
