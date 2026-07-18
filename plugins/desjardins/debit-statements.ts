// Desjardins bank-account (DEBIT) monthly statements — the legacy AccèsD `coreleADReleve` Struts flow, a
// multi-parser HTML scraper that lives in its own file because the single capability is large.
//
// WHY A LIVE BROWSER (ctx.browser), not headless replay: the legacy backend runs a short-lived, server-side
// "AccèsWeb" session (separate from the modern atk_accesd). A bare net.request finds it already torn down —
// the selection page redirects to `identifiantunique/autologout` — even with the cookies replayed. A real
// browser tab keeps it warm. So we drive an OFFSCREEN authenticated window through the actual flow.
//
// THE FLOW (per statement, all same-origin on accesd.mouv inside the live page):
//   0. NAVIGATE to sommaire-perso/lanceur/modale?modale_nom=releve-compte-consultation → primes the
//      server-side statement context (the real modale entry point).
//   1. NAVIGATE the same window to ObtenirSelectionReleveMensuel.do?msgId=debuter&tokenN3=2 → the selection
//      page (ISO-8859-1 HTML): the per-page Struts token (`org.apache.struts.taglib.html.TOKEN`), the
//      available years (`chListeReleveMensuelAnnee[<folio>].choixAnnee` <select>), and — per (folio, year) —
//      the available months (`listePeriodeFormatMois*` <select> of `<option value="MM.PDF">`).
//   2. IN-PAGE POST the same URL with msgId=confirmer + folio/year/month + chListeFormatPDF=PDF +
//      destination=fichier → an HTML page whose `location='…ObtenirReleveMensuelPDF.do?…&D1=…&K=…'` carries
//      ONE-TIME, opaque D1/K tokens minted for this exact statement (the same-origin fetch sets Origin/
//      Referer/cookies like the real form submit, with no Bearer).
//   3. IN-PAGE GET that ObtenirReleveMensuelPDF.do URL → the PDF bytes.
//
// We expose this as a collect capability with a downloadable `files` table: collect() lists one row per
// available month (one selection page), and the capability's fetchFile runs steps 0→3 for a row. The pure
// parsers below are fixture-tested.

import { type BrowserContext, type BrowserPage, type CollectContext, type DocumentBytes } from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import * as cheerio from 'cheerio'

const LEGACY_ORIGIN = 'https://accesd.mouv.desjardins.com'
const SELECTION_PATH = '/coreleADReleve/ObtenirSelectionReleveMensuel.do'
const MODALE_PATH = '/sommaire-perso/lanceur/modale'
const STATEMENTS_CATEGORY = 'Relevés de compte'

// The statement-context token for the monthly account statement. It is the constant '2' (it rides the
// modale launcher → the selection GET's `tokenN3` and the form's hidden `token`); an account with a
// different statement context may need this to vary.
const STATEMENT_TOKEN_N3 = '2'

// AccèsD opens the statement consultation as a MODALE whose real entry is this launcher; navigating to it
// first primes the server-side context (and keeps the AccèsWeb session warm) before the selection page.
const MODALE_NOM = 'releve-compte-consultation'

// Client-generated modale instance id (the UI uses a short base36-ish token, e.g. 'mqd9gpq02ij9xds4l49').
const modaleId = (): string =>
  `m${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 19)

const launcherUrl = (id: string): string =>
  `${LEGACY_ORIGIN}${MODALE_PATH}?modale_nom=${MODALE_NOM}&modale_id=${id}&fromOrigin=${encodeURIComponent(LEGACY_ORIGIN)}`

const selectionUrl = (): string =>
  `${LEGACY_ORIGIN}${SELECTION_PATH}?msgId=debuter&tokenN3=${STATEMENT_TOKEN_N3}` +
  `&randomNoN3=${Math.random()}&fromOrigin=${encodeURIComponent(LEGACY_ORIGIN)}`

// Drive the live authenticated browser through the real modale flow — open the launcher (primes the
// server-side context + keeps the AccèsWeb session warm), then load the selection page in a CHILD IFRAME
// (Sec-Fetch-Dest: iframe). Loaded top-level it framebusts to logoff.do, so it MUST be framed. The caller
// gets the frame context (its confirm/PDF fetches inherit the selection page's Origin/Referer) + the HTML.
const withSelectionFrame = async <T>(
  ctx: CollectContext,
  use: (page: BrowserPage, frame: BrowserContext, selUrl: string, html: string) => Promise<T>
): Promise<T> => {
  if (!ctx.browser) {
    throw new Error('Desjardins: account (debit) statements need the live app browser session — not available here.')
  }

  return ctx.browser.open(launcherUrl(modaleId()), async (page) => {
    const selUrl = selectionUrl()
    const frame = await page.loadFrame(selUrl)

    return use(page, frame, selUrl, await frame.html())
  })
}

// --- types ---

// One downloadable monthly bank-account statement: folio (account) + year + month, plus the year's
// dropdown CODE (e.g. '07' for 2019) that the confirm POST echoes alongside the literal year.
export interface DebitStatementRef {
  folio: string
  year: number
  month: number
  yearCode: string
}

// The per-page hidden fields the confirm POST must echo back verbatim.
export interface SelectionForm {
  strutsToken: string
  token: string
  nombreDeFolio: string
}

// --- pure parsers (fixture-tested) ---

export const parseSelectionForm = (html: string): SelectionForm => {
  const $ = cheerio.load(html)
  const val = (name: string): string => $(`input[name="${name}"]`).attr('value') ?? ''

  return {
    strutsToken: val('org.apache.struts.taglib.html.TOKEN'),
    token: val('token') || STATEMENT_TOKEN_N3,
    nombreDeFolio: val('nombreDeFolio') || '1'
  }
}

// Available statements come from the per-(folio, year) month <select id="listePeriodeFormatMois*"
// onchange="afficherChoixFormatReleve(this, <folio>, <yearIndex>)">, whose <option value="MM.PDF"> list
// the months that exist for that folio+year. The year (+ its dropdown code) comes from the matching
// chListeReleveMensuelAnnee[<folio>].choixAnnee <select> (option value = code, text = the 4-digit year),
// indexed by the onchange's yearIndex. Newest first.
export const parseAvailableStatements = (html: string): DebitStatementRef[] => {
  const $ = cheerio.load(html)

  const yearsByFolio = new Map<string, { code: string; year: number }[]>()

  $('select[name^="chListeReleveMensuelAnnee["]').each((_, el) => {
    const folio = ($(el).attr('name') ?? '').match(/\[(\d+)\]/)?.[1] ?? '0'
    const years: { code: string; year: number }[] = []

    $(el)
      .find('option')
      .each((__, opt) => {
        const code = $(opt).attr('value') ?? ''
        const year = parseInt($(opt).text().trim(), 10)

        // Real years are 2-digit codes with a 4-digit label; skip the '' / '-1' placeholder options.
        if (/^\d{2}$/.test(code) && Number.isFinite(year)) {
          years.push({ code, year })
        }
      })

    yearsByFolio.set(folio, years)
  })

  const refs: DebitStatementRef[] = []

  $('select[id^="listePeriodeFormatMois"]').each((_, el) => {
    const m = ($(el).attr('onchange') ?? '').match(/afficherChoixFormatReleve\(\s*this\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)

    if (!m) {
      return
    }

    const folio = m[1]
    const yr = (yearsByFolio.get(folio) ?? yearsByFolio.get('0') ?? [])[parseInt(m[2], 10)]

    if (!yr) {
      return
    }

    $(el)
      .find('option')
      .each((__, opt) => {
        const mm = ($(opt).attr('value') ?? '').match(/^(\d{2})\.PDF$/i)

        if (mm) {
          refs.push({ folio, year: yr.year, month: parseInt(mm[1], 10), yearCode: yr.code })
        }
      })
  })

  refs.sort((a, b) => b.year - a.year || b.month - a.month)

  return refs
}

// The confirm POST body (urlencoded). choixAnnee is the literal year; the chListeReleveMensuelAnnee[<folio>]
// field carries the dropdown CODE. The button label is appended verbatim with its latin-1 nbsp (%A0) bytes,
// which the server matches literally.
export const buildConfirmBody = (form: SelectionForm, ref: DebitStatementRef): string => {
  const mm = String(ref.month).padStart(2, '0')
  const params: [string, string][] = [
    ['org.apache.struts.taglib.html.TOKEN', form.strutsToken],
    ['token', form.token],
    ['msgId', 'confirmer'],
    ['moveToken', 'false'],
    ['choixMois', `${mm}.PDF`],
    ['choixAnnee', String(ref.year)],
    ['nombreDeFolio', form.nombreDeFolio],
    ['chRadioChoixFolio', ref.folio],
    [`chListeReleveMensuelAnnee[${ref.folio}].choixAnnee`, ref.yearCode],
    ['destination', 'fichier'],
    ['chListeFormatNonPDF', ''],
    ['chListeFormatPDF', 'PDF'],
    ['chListeFormatPDFFUS', '']
  ]

  return `${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}&Valider=%A0Confirmer%A0`
}

// The confirm response triggers the download via location='…/ObtenirReleveMensuelPDF.do?…&D1=…&K=…'.
// Return that path (already percent-encoded in the HTML) verbatim, or null when the confirm yielded no
// document (e.g. a validation message instead of a download).
export const parsePdfPath = (html: string): string | null =>
  html.match(/\/coreleADReleve\/secondaire\/ObtenirReleveMensuelPDF\.do\?[^'"\s\\]+/)?.[0] ?? null

// True if the bytes are a PDF (the `%PDF` magic). The confirm POST may hand back the statement PDF
// directly rather than an HTML redirect, so we sniff before trying to parse the body as HTML.
export const isPdfBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

// ObtenirReleveMensuelPDF.do hands the statement back wrapped in a Java-serialized byte[] (stream header
// `AC ED 00 05 … [B`), not a raw application/pdf. The real document sits inside, from its `%PDF` magic to
// the final `%%EOF`. Slice it out; if the bytes are already a raw PDF (`%PDF` at offset 0) this is a no-op.
export const extractPdf = (bytes: Uint8Array): Uint8Array => {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = buf.indexOf('%PDF')

  if (start < 0) {
    return bytes
  }

  const eof = buf.lastIndexOf('%%EOF')

  return bytes.subarray(start, eof >= 0 ? eof + '%%EOF'.length : bytes.length)
}

// A short fingerprint of a selection page that yielded no statements, so a live run that still finds none
// reveals WHAT the server returned instead of a blank "0 available". Beyond the <title>/markers, it pulls
// any redirect target the stub carries (a JS location=, a <meta refresh>, or a <form action>) — the
// legacy coreleADReleve backend bounces an unauthenticated session to an SSO/login URL, and that URL is
// the clue for the next step — plus a stripped text snippet of the visible content.
export const describeEmptySelection = (html: string): Record<string, unknown> => ({
  bytes: html.length,
  title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null,
  hasYearSelect: /chListeReleveMensuelAnnee\[/.test(html),
  hasMonthSelect: /listePeriodeFormatMois/.test(html),
  looksLikeLogin: /identifiantunique|authentification|connexion/i.test(html),
  redirect:
    html.match(/(?:location\.(?:href|replace)\s*=?\s*\(?|window\.location\s*=)\s*['"]([^'"]+)['"]/i)?.[1] ??
    html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*url=([^"'>]+)/i)?.[1] ??
    html.match(/<form[^>]*action=["']([^"']+)["']/i)?.[1] ??
    null,
  snippet: html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
})

// --- the documents port (live replay) ---

const fetchDebitStatementPdf = async (ctx: CollectContext, ref: DebitStatementRef): Promise<DocumentBytes> =>
  withSelectionFrame(ctx, async (page, frame, selUrl, html) => {
    const label = `${ref.year}-${String(ref.month).padStart(2, '0')} folio ${ref.folio}`
    const form = parseSelectionForm(html)

    if (!form.strutsToken) {
      ctx.log(`debit fetch ${label}: no Struts token on the selection page`, describeEmptySelection(html))
      throw new Error(
        `Desjardins: ${label} — the statement selection page didn't load (session issue); reconnect and retry.`
      )
    }

    // Confirm runs IN the selection FRAME (same-origin form submit, no Bearer) → an HTML page whose JS
    // `location=` carries the one-time D1/K download URL.
    const confirm = await frame.fetchText(SELECTION_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildConfirmBody(form, ref)
    })

    const pdfPath = parsePdfPath(confirm.text)

    if (!pdfPath) {
      ctx.log(`debit fetch ${label}: confirm gave no PDF link`, {
        status: confirm.status,
        ...describeEmptySelection(confirm.text)
      })
      throw new Error(`Desjardins: no statement PDF returned for ${label} (confirm status ${confirm.status}).`)
    }

    // The server only streams the PDF to a real NAVIGATION (Sec-Fetch-Dest: document) — an XHR gets a 17KB
    // HTML page. So download it as a navigation (referer = the selection page that minted the D1/K token),
    // then unwrap the Java-serialized byte[] AccèsD wraps the PDF in.
    const pdf = extractPdf(await page.download(`${LEGACY_ORIGIN}${pdfPath}`, { referer: selUrl }))

    if (!isPdfBytes(pdf)) {
      ctx.log(`debit fetch ${label}: download not a PDF`, {
        bytes: pdf.length,
        pdfPath,
        ...describeEmptySelection(new TextDecoder('latin1').decode(pdf))
      })
      throw new Error(`Desjardins: statement ${label} did not download as a PDF (${pdf.length} bytes).`)
    }

    return pdf
  })

// One downloadable monthly bank-account statement row: the rendered label + date, plus the ref fields
// (folio / year / month / yearCode) carried for the capability's fetchFile to replay the live flow.
interface DebitStatementRow {
  name: string
  date: string
  // Not rendered — carried for fetchFile to replay the modale→selection→confirm→download flow.
  folio: string
  year: number
  month: number
  yearCode: string
}

// Pure: the available statement refs → a downloadable table. Each row carries the ref fields (folio / year
// / month / yearCode) the capability's fetchFile replays through the live flow. The download serializes
// (transport.download.concurrency:1) because every download drives the ONE stateful AccèsWeb session
// (Struts token + modale state) — serial, no clobbering.
export const buildDebitStatementsResult = (refs: DebitStatementRef[]): CapabilityResult => {
  const rows: DebitStatementRow[] = refs.map((ref) => {
    const mm = String(ref.month).padStart(2, '0')

    return {
      name: `Relevé ${ref.year}-${mm}`,
      date: `${ref.year}-${mm}-01`,
      folio: ref.folio,
      year: ref.year,
      month: ref.month,
      yearCode: ref.yearCode
    }
  })

  return capabilityResult({
    sections: [
      table<DebitStatementRow>({
        id: 'debit-statements',
        columns: [
          { key: 'name', label: 'Relevé', role: 'label' },
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'folio', role: 'label', hidden: true },
          { key: 'year', role: 'count', hidden: true },
          { key: 'month', role: 'count', hidden: true },
          { key: 'yearCode', role: 'label', hidden: true }
        ],
        rows,
        // One statement per folio + year + month — that triple is its stable identity in the ledger.
        key: ['folio', 'year', 'month']
      }).fileTable({
        name: 'name',
        source: { fetch: true },
        ext: 'pdf',
        category: STATEMENTS_CATEGORY
      })
    ]
  })
}

// The per-row PDF fetch: replay the live modale→selection→confirm→download flow for the row's ref.
export const fetchDebitStatementFile = (ctx: CollectContext, row: Record<string, unknown>): Promise<DocumentBytes> =>
  fetchDebitStatementPdf(ctx, {
    folio: String(row.folio),
    year: Number(row.year),
    month: Number(row.month),
    yearCode: String(row.yearCode)
  })

export const collectDebitStatements = async (ctx: CollectContext): Promise<CapabilityResult> => {
  if (!ctx.browser) {
    ctx.log('debit statements: live browser session unavailable — skipping')

    return buildDebitStatementsResult([])
  }

  const html = await withSelectionFrame(ctx, async (_page, _frame, _selUrl, frameHtml) => frameHtml)
  const refs = parseAvailableStatements(html)

  // When the page yields nothing, log a fingerprint of what came back so a live re-run shows the real
  // cause (login redirect / error page / wrong structure) rather than a silent empty table.
  ctx.log(
    `debit statements: ${refs.length} available`,
    refs.length === 0
      ? describeEmptySelection(html)
      : {
          oldest: `${refs.at(-1)!.year}-${String(refs.at(-1)!.month).padStart(2, '0')}`,
          newest: `${refs[0].year}-${String(refs[0].month).padStart(2, '0')}`
        }
  )

  return buildDebitStatementsResult(refs)
}
