import { createSampleGen, resolveSampleConfig, resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildBilling,
  buildSummary,
  cgtsimPlugin,
  metaRefreshUrl,
  parseInvoices,
  parseProperties,
  parseStatements,
  pdfViewerUrl,
  type RawTaxData
} from './main.js'
import { sampleTaxData } from './sample.js'

const validate = resultValidator('CAD')

const firstRows = <T>(r: { datasets: unknown[] }): T[] => (r.datasets[0] as { rows: T[] }).rows
const firstView = (r: { views?: unknown[] }): Record<string, unknown> => r.views![0] as Record<string, unknown>
const datasetById = (r: { datasets: unknown[] }, id: string): Record<string, unknown> =>
  (r.datasets as Record<string, unknown>[]).find((d) => d.id === id)!

// A property row on the roster: the same property is linked twice (invoices + statements), each anchor carrying the
// property identifiers in its own query string — which is what the collectors read instead of the table markup.
const A = '1000+RUE+FICTIVE+100+MONTREAL+QC'
const M = '12345678901234567890123'
const PROPERTIES_HTML = `
<table class="MesProprietes"><tbody>
  <tr>
    <td class="colAdr">1000 RUE FICTIVE 100</td>
    <td><a href="TFP.aspx?jlsid=1&jlrun=tfpint.factenligne.ListeFactEnLigne&Adr=${A}&Doss=50-00000001&Matr=${M}">Factures</a></td>
    <td><a href="TFP.aspx?jlsid=1&jlrun=tfpint.etatcompte.ListeEtatCompte&Adr=${A}&Doss=50-00000001&Matr=${M}">État de compte</a></td>
  </tr>
</tbody></table>`

const INVOICES_HTML = `
<table class="ListeFactEnLigne"><tbody>
  <tr><td><a href="TFP.aspx?jlsid=1&jlrun=tfpint.factenligne.Produire&ID_FACT=10000001&CODE_INTERV_INT=CSIM&NO_FACT_COMPL=202601000000001">2026</a></td></tr>
  <tr><td><a href="TFP.aspx?jlsid=1&jlrun=tfpint.factenligne.Produire&ID_FACT=10000002&CODE_INTERV_INT=CSIM&NO_FACT_COMPL=202501000000002">2025</a></td></tr>
</tbody></table>`

const STATEMENTS_HTML = `
<table class="ListeEtatCompte"><tbody>
  <tr><td><a href="TFP.aspx?jlsid=1&jlrun=tfpint.etatcompte.Produire&ID_CR=0000000001&Code_Acces=EXEMP&Code_II=CSIM&No_Interv_Ext=1000001&NO_DOSS=5000000001">Voir</a></td></tr>
</tbody></table>`

const fixtureData = (): RawTaxData => {
  const properties = parseProperties(PROPERTIES_HTML)
  const [property] = properties

  return {
    properties,
    invoices: parseInvoices(INVOICES_HTML).map((invoice) => ({ property: property!, invoice })),
    statements: parseStatements(STATEMENTS_HTML).map((statement) => ({ property: property!, statement }))
  }
}

test('parseProperties merges the invoice + statement links into one property, decoding its address', () => {
  const props = parseProperties(PROPERTIES_HTML)

  expect(props).toHaveLength(1)
  expect(props[0]).toMatchObject({
    matricule: M,
    dossier: '50-00000001',
    address: '1000 RUE FICTIVE 100 MONTREAL QC'
  })
  expect(props[0]!.invoiceListUrl).toContain('tfpint.factenligne.ListeFactEnLigne')
  expect(props[0]!.statementListUrl).toContain('tfpint.etatcompte.ListeEtatCompte')
})

test("parseInvoices reads each Produire link (newest first is the builder's job, ids come off the href)", () => {
  const invoices = parseInvoices(INVOICES_HTML)

  expect(invoices).toHaveLength(2)
  expect(invoices[0]).toMatchObject({ idFact: '10000001', noFactComplet: '202601000000001' })
  expect(invoices[0]!.produireUrl).toContain('tfpint.factenligne.Produire')
})

test('parseStatements reads the account-statement Produire links', () => {
  const statements = parseStatements(STATEMENTS_HTML)

  expect(statements).toHaveLength(1)
  expect(statements[0]).toMatchObject({ idCr: '0000000001', codeAcces: 'EXEMP' })
})

test('buildSummary bundles the count overview, the property roster, and the downloadable statements', () => {
  const result = buildSummary(fixtureData())

  expect(validate(result)).toEqual([])

  const overview = datasetById(result, 'overview') as { value: Record<string, number> }

  expect(overview.value).toMatchObject({ properties: 1, invoices: 2, statements: 1 })

  const props = datasetById(result, 'properties') as { rows: { matricule: string }[] }

  expect(props.rows).toHaveLength(1)
  expect(props.rows[0]!.matricule).toBe(M)

  // Statements stay downloadable on the Summary tab.
  const statementsView = (result.views as Record<string, unknown>[]).find((v) => v.dataset === 'statements')

  expect(statementsView).toMatchObject({ type: 'table', files: { source: { fetch: true } } })
})

test('buildBilling derives the tax year, sorts newest first, and stays downloadable + contract-valid', () => {
  const result = buildBilling(fixtureData())

  expect(validate(result)).toEqual([])
  const rows = firstRows<{ year: string; produireUrl: string }>(result)

  expect(rows.map((r) => r.year)).toEqual(['2026', '2025'])
  expect(rows[0]!.produireUrl).toContain('Produire')
  expect(firstView(result)).toMatchObject({ type: 'table', files: { source: { fetch: true } } })
})

// The account-statement download follows the portal's async meta-refresh chain: Produire → a self-refreshing
// Visionneuse → a PDFViewer binary link. These parsers drive that walk.
test('metaRefreshUrl follows the Visionneuse redirect, decoding &amp; entities', () => {
  const html =
    '<meta http-equiv="REFRESH" content="5; URL=TFP.aspx?jlsid=1&amp;jlrun=tfpint.lot.Visionneuse&amp;UIDProd=1000000&amp;Retry=1">'

  expect(metaRefreshUrl(html)).toBe(
    'https://tfp.cgtsim.qc.ca/asp/TFP.aspx?jlsid=1&jlrun=tfpint.lot.Visionneuse&UIDProd=1000000&Retry=1'
  )
})

test('pdfViewerUrl finds the binary viewer link whether in a meta-refresh or an anchor', () => {
  const viaRefresh =
    '<meta http-equiv="refresh" content="0; URL=TFP.aspx?jlrun=tfpint.lot.PDFViewer&amp;jloutputtype=binary&amp;File=ABC123">'
  const viaAnchor = '<a href="TFP.aspx?jlsid=1&jlrun=tfpint.lot.PDFViewer&jloutputtype=binary&File=ABC123">Ouvrir</a>'

  expect(pdfViewerUrl(viaRefresh)).toContain('tfpint.lot.PDFViewer')
  expect(pdfViewerUrl(viaAnchor)).toContain('File=ABC123')
  expect(pdfViewerUrl('<p>En exécution</p>')).toBeNull()
})

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(cgtsimPlugin)).toEqual([])
})

test('sampleTaxData is synthetic and scales with the users/documents knobs', () => {
  const small = sampleTaxData(createSampleGen('cgtsim:t'), resolveSampleConfig({ users: 1, documents: 2 }))
  const large = sampleTaxData(createSampleGen('cgtsim:t'), resolveSampleConfig({ users: 3, documents: 6 }))

  expect(large.properties.length).toBeGreaterThanOrEqual(small.properties.length)
  expect(large.invoices.length).toBeGreaterThan(small.invoices.length)
  expect(small.invoices.every((i) => i.invoice.produireUrl.includes('example.invalid'))).toBe(true)
})

test('cgtsim is a plain cookie session over node transport', () => {
  expect(cgtsimPlugin.meta.id).toBe('cgtsim')
  expect(cgtsimPlugin.auth.kind).toBe('cookie')
  expect(cgtsimPlugin.transport?.engine).toBe('node')
  expect(cgtsimPlugin.session?.cookieDomains).toContain('cgtsim.qc.ca')
})
