import { type BrowserContext, type BrowserPage, type CollectContext } from '@butinapp/sdk'
import { type Dataset } from '@butinapp/sdk/data'
import { isPdfBytes } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import {
  buildConfirmBody,
  collectDebitStatements,
  type DebitStatementRef,
  describeEmptySelection,
  extractPdf,
  fetchDebitStatementFile,
  parseAvailableStatements,
  parsePdfPath,
  parseSelectionForm,
  type SelectionForm
} from './debit-statements.js'

const statementRows = (result: { datasets: Dataset[] }): Record<string, unknown>[] => {
  const ds = result.datasets.find((d) => d.id === 'debit-statements')

  return ds?.shape === 'table' ? ds.rows : []
}

// A fake ctx.browser whose page returns canned HTML and records nav/fetch calls — so we can test the
// launcher→selection→confirm→pdf orchestration without Electron.
const fakeBrowserCtx = (opts: {
  selectionHtml: string
  confirmText?: string
  pdfBytes?: Uint8Array
}): {
  ctx: CollectContext
  navs: string[]
  posts: { url: string; body?: string }[]
  downloads: { url: string; referer?: string }[]
} => {
  const navs: string[] = []
  const posts: { url: string; body?: string }[] = []
  const downloads: { url: string; referer?: string }[] = []
  // The selection page is loaded into a child frame; the confirm POST runs in that frame's context.
  const frame: BrowserContext = {
    html: async () => opts.selectionHtml,
    fetchText: async (url: string, init) => {
      posts.push({ url, body: init?.body })

      return { status: 200, text: opts.confirmText ?? '' }
    },
    fetchBytes: async () => ({ status: 200, bytes: new Uint8Array() })
  }
  const page: BrowserPage = {
    navigate: async (u: string) => void navs.push(u),
    loadFrame: async (u: string) => {
      navs.push(u)

      return frame
    },
    subframe: async () => null,
    // The PDF download is a real navigation (page.download), not a frame fetch.
    download: async (u: string, init) => {
      downloads.push({ url: u, referer: init?.referer })

      return opts.pdfBytes ?? new Uint8Array()
    },
    html: async () => '',
    fetchText: async () => ({ status: 200, text: '' }),
    fetchBytes: async () => ({ status: 200, bytes: new Uint8Array() })
  }
  const ctx = {
    browser: {
      open: async <T>(url: string, use: (p: BrowserPage) => Promise<T>): Promise<T> => {
        navs.push(url)

        return use(page)
      }
    },
    log: () => undefined
  } as unknown as CollectContext

  return { ctx, navs, posts, downloads }
}

// SYNTHETIC selection page — structurally faithful to the AccèsD coreleADReleve `ObtenirSelectionReleve
// Mensuel.do` HTML (hidden Struts token, the year <select>, the per-year month <select>s with their
// afficherChoixFormatReleve(this, <folio>, <yearIndex>) onchange), but with invented tokens/no real data.
// One folio (0), two years: 2026 (code 00, Jan–Feb only) and 2019 (code 07, Nov–Dec only).
const SELECTION_HTML = `<!DOCTYPE html><html><body>
  <form name="ObtenirSelectionReleveMensuelForm" method="post" action="/coreleADReleve/ObtenirSelectionReleveMensuel.do">
    <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="deadbeefcafe0000">
    <input type="hidden" name="token" value="2">
    <input type="hidden" name="msgId" value="validerReleveMensuel">
    <input type="hidden" id="nombreDeFolio" name="nombreDeFolio" value="1">
    <input type="radio" name="chRadioChoixFolio" value="0">
    <select name="chListeReleveMensuelAnnee[0].choixAnnee">
      <option value="">Année</option>
      <option value="-1">Choisir</option>
      <option value="00">2026</option>
      <option value="07">2019</option>
    </select>
    <select id="listePeriodeFormatMois00" onchange="afficherChoixFormatReleve(this, 0,0)">
      <option value="">Mois</option>
      <option value="01.PDF">JAN</option>
      <option value="02.PDF">FÉV</option>
    </select>
    <select id="listePeriodeFormatMois07" onchange="afficherChoixFormatReleve(this, 0,1)">
      <option value="11.PDF">NOV</option>
      <option value="12.PDF">DÉC</option>
    </select>
  </form>
</body></html>`

test('parseSelectionForm reads the Struts token, the context token, and the folio count', () => {
  const form = parseSelectionForm(SELECTION_HTML)

  expect(form).toEqual({ strutsToken: 'deadbeefcafe0000', token: '2', nombreDeFolio: '1' })
})

test('parseSelectionForm falls back to sane defaults when fields are absent', () => {
  const form = parseSelectionForm('<form><input name="org.apache.struts.taglib.html.TOKEN" value="t"></form>')

  expect(form).toEqual({ strutsToken: 't', token: '2', nombreDeFolio: '1' })
})

test('parseAvailableStatements maps each year-coded month select onto folio/year/month refs (newest first)', () => {
  const refs = parseAvailableStatements(SELECTION_HTML)

  expect(refs).toHaveLength(4)
  // newest first
  expect(refs[0]).toEqual({ folio: '0', year: 2026, month: 2, yearCode: '00' })
  expect(refs[1]).toEqual({ folio: '0', year: 2026, month: 1, yearCode: '00' })
  // the year CODE rides along for the confirm POST (07 → 2019), and only the months present are emitted
  expect(refs.at(-1)).toEqual({ folio: '0', year: 2019, month: 11, yearCode: '07' })
  expect(refs.map((r) => `${r.year}-${r.month}`)).toEqual(['2026-2', '2026-1', '2019-12', '2019-11'])
})

test('buildConfirmBody replays the captured field shape (year code via the folio-indexed field, nbsp button)', () => {
  const form: SelectionForm = { strutsToken: 'deadbeefcafe0000', token: '2', nombreDeFolio: '1' }
  const ref: DebitStatementRef = { folio: '0', year: 2019, month: 6, yearCode: '07' }

  const body = buildConfirmBody(form, ref)

  expect(body).toContain('org.apache.struts.taglib.html.TOKEN=deadbeefcafe0000')
  expect(body).toContain('msgId=confirmer')
  expect(body).toContain('choixMois=06.PDF')
  expect(body).toContain('choixAnnee=2019')
  // the [0] index is percent-escaped exactly like the captured body
  expect(body).toContain('chListeReleveMensuelAnnee%5B0%5D.choixAnnee=07')
  expect(body).toContain('chListeFormatPDF=PDF')
  expect(body).toContain('destination=fichier')
  // the latin-1 nbsp button label is appended verbatim
  expect(body.endsWith('&Valider=%A0Confirmer%A0')).toBe(true)
})

test('parsePdfPath extracts the one-time D1/K download URL from the confirm response', () => {
  const html = `<html><script>location='/coreleADReleve/secondaire/ObtenirReleveMensuelPDF.do?moveToken=false&D1=AbC%2Fd%3D%3D&K=Xy%2Bz%3D';</script></html>`

  expect(parsePdfPath(html)).toBe(
    '/coreleADReleve/secondaire/ObtenirReleveMensuelPDF.do?moveToken=false&D1=AbC%2Fd%3D%3D&K=Xy%2Bz%3D'
  )
})

test('parsePdfPath returns null when the confirm yielded no document', () => {
  expect(parsePdfPath('<html><body>Aucun relevé disponible.</body></html>')).toBeNull()
})

test('extractPdf unwraps the Java-serialized byte[] AccèsD wraps the PDF in (and no-ops on a raw PDF)', () => {
  const pdfBody = new TextEncoder().encode('%PDF-1.3\nbody\n%%EOF')

  // raw PDF → returned as-is
  expect(Array.from(extractPdf(pdfBody))).toEqual(Array.from(pdfBody))

  // wrapped: Java serialization header + byte[] payload + a trailing byte, with the PDF in the middle
  const header = new Uint8Array([0xac, 0xed, 0x00, 0x05, 0x75, 0x72, 0x00, 0x02, 0x5b, 0x42]) // AC ED … [B
  const wrapped = new Uint8Array([...header, ...pdfBody, 0x78]) // trailing TC_ENDBLOCKDATA
  const out = extractPdf(wrapped)

  expect(isPdfBytes(out)).toBe(true)
  expect(new TextDecoder().decode(out)).toBe('%PDF-1.3\nbody\n%%EOF')
})

test('describeEmptySelection fingerprints a no-statements page (the year/month form vs a login redirect)', () => {
  expect(describeEmptySelection(SELECTION_HTML)).toMatchObject({
    hasYearSelect: true,
    hasMonthSelect: true,
    looksLikeLogin: false
  })

  const login =
    `<html><head><title>Authentification</title></head><body>Votre session est expirée. ` +
    `<script>window.location='/identifiantunique/sso/redirect?x=1';</script>identifiantunique</body></html>`

  expect(describeEmptySelection(login)).toMatchObject({
    title: 'Authentification',
    hasYearSelect: false,
    looksLikeLogin: true,
    redirect: '/identifiantunique/sso/redirect?x=1'
  })
  // the snippet strips tags/scripts to the visible text so the log shows what the page actually said
  expect(String((describeEmptySelection(login) as { snippet: string }).snippet)).toContain('session est expirée')
})

test('collect drives the live browser launcher→selection (serial), then yields a downloadable table', async () => {
  const { ctx, navs } = fakeBrowserCtx({ selectionHtml: SELECTION_HTML })

  const result = await collectDebitStatements(ctx)
  const rows = statementRows(result)

  // open() navigates to the launcher first, then loadFrame() the selection page
  expect(navs[0]).toContain('/sommaire-perso/lanceur/modale?modale_nom=releve-compte-consultation')
  expect(navs[1]).toContain('/coreleADReleve/ObtenirSelectionReleveMensuel.do')
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({ name: 'Relevé 2026-02', date: '2026-02-01' })
  // Each statement accumulates in the ledger keyed by folio + year + month.
  const ds = result.datasets.find((d) => d.id === 'debit-statements')

  expect(ds?.shape === 'table' && ds.key).toEqual(['folio', 'year', 'month'])
  // the bytes come from the capability's fetchFile hook (no url column) — a fetch-sourced files table
  const view = result.views?.find((v) => v.type === 'table')

  expect(view?.type === 'table' && view.files).toMatchObject({
    name: 'name',
    source: { fetch: true },
    ext: 'pdf',
    category: 'Relevés de compte'
  })
})

test('collect returns an empty table (not a throw) when no browser session is available', async () => {
  const result = await collectDebitStatements({ log: () => undefined } as unknown as CollectContext)

  expect(statementRows(result)).toEqual([])
})

test('a per-row file fetch confirms in-frame, then DOWNLOADS the D1/K link as a navigation → PDF bytes', async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]) // %PDF-1.4
  const { ctx, posts, downloads } = fakeBrowserCtx({
    selectionHtml: SELECTION_HTML,
    confirmText: `<script>location='/coreleADReleve/secondaire/ObtenirReleveMensuelPDF.do?D1=a&K=b';</script>`,
    pdfBytes: pdf
  })

  const rows = statementRows(await collectDebitStatements(ctx))
  const jan2026 = rows.find((r) => r.name === 'Relevé 2026-01')!
  const bytes = await fetchDebitStatementFile(ctx, jan2026)

  // the confirm POST carries the right month/format, in-frame (same-origin path, no host)
  expect(posts[0].url).toBe('/coreleADReleve/ObtenirSelectionReleveMensuel.do')
  expect(posts[0].body).toContain('choixMois=01.PDF')
  expect(posts[0].body).toContain('chListeFormatPDF=PDF')
  // the PDF is fetched via a real NAVIGATION (page.download) — absolute URL, referer = the selection page
  expect(downloads[0].url).toBe(
    'https://accesd.mouv.desjardins.com/coreleADReleve/secondaire/ObtenirReleveMensuelPDF.do?D1=a&K=b'
  )
  expect(downloads[0].referer).toContain('/coreleADReleve/ObtenirSelectionReleveMensuel.do')
  expect(isPdfBytes(bytes as Uint8Array)).toBe(true)
})
