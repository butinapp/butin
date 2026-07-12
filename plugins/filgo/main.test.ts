import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { createSampleGen, resolveSampleConfig } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildFilgoDeliveries,
  buildFilgoStatements,
  buildFilgoTanks,
  filgoPlugin,
  normalizeStatement,
  parseCloudflowResult,
  parseCsrfToken,
  parseFilgoActifs,
  type RawStatementDoc
} from './main.js'
import { sampleFilgoDeliveries, sampleFilgoStatements } from './sample.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'CAD'))

// A redacted, synthetic slice of the /actifs/ page — the account <select> option + one reservoir card, in the
// real nesting (the Capacité/Produit/État subtitles are siblings of their value <p>). No real PII.
const ACTIFS_HTML = `
<select name="comptes" id="account-select">
  <option value="acct-guid-1" data-accountguid="acct-guid-1" data-accountnumber="12345678">12345678 SAMPLE CLIENT</option>
</select>
<div id="asset-guid-1" class="reservoir-card">
  <input type="hidden" name="location-data" data-location="0001" data-account="300000001">
  <div class="card-body">
    <div class="col-12 mb-auto">
      <h4 class="card-title">RÉSERVOIR PROPANE - SAMPLE</h4>
      <p class="card-text">ID : 300000001-0001</p>
      <p class="card-text card-address">1 rue Exemple, Ville QC A1A 1A1</p>
      <h5 class="d-none">asset-guid-1</h5>
    </div>
    <div class="d-md-flex">
      <div class="col-md-6"><div class="reservoir-container"></div></div>
      <div class="col-md-6">
        <h5 class="card-subtitle">Capacité</h5>
        <p class="card-text">454 L</p>
        <h5 class="card-subtitle">Produit</h5>
        <p class="card-text card-product">PROPANE</p>
        <h5 class="card-subtitle">État de service</h5>
        <p class="card-text alert alert-success">Fonctionnel</p>
      </div>
    </div>
  </div>
</div>`

const STATEMENT_DOC: RawStatementDoc = {
  name: 'ECOI_12345678_6548728',
  templateName: 'ÉTAT DE COMPTE - OI',
  creationTime: '2026-04-08T14:58:06-04:00',
  url: 'https://example.invalid/statements/abc',
  metadataV2: [
    { key: "Date de l'état de compte", value: '2026-03-31T00:00:00' },
    { key: "Total de l'état de compte", value: 320.78 },
    { key: 'No relevé', value: '6548728' }
  ]
}

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of filgoPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

test('filgo is a cookie-csrf session on the Power Pages portal', () => {
  expect(filgoPlugin.auth.kind).toBe('cookie-csrf')
  expect(filgoPlugin.session?.cookieDomains).toContain('portail.monfilgo.ca')
  expect(filgoPlugin.session?.requiredCookie).toBe('.AspNet.ApplicationCookie')
})

test('sample generators are synthetic and scale with the documents knob', () => {
  const small = sampleFilgoStatements(createSampleGen('filgo:t'), resolveSampleConfig({ size: 'small' }))
  const large = sampleFilgoStatements(createSampleGen('filgo:t'), resolveSampleConfig({ size: 'large' }))

  expect(large.statements.length).toBeGreaterThanOrEqual(small.statements.length)
  expect(small.statements.every((s) => (s.url ?? '').includes('example.invalid'))).toBe(true)
  expect(
    sampleFilgoDeliveries(createSampleGen('filgo:t'), resolveSampleConfig({ documents: 5 })).deliveries.length
  ).toBe(5)
})

// --- CSRF token + Cloudflow envelope ---

test('parseCsrfToken reads the hidden anti-forgery input value', () => {
  expect(parseCsrfToken('<input name="__RequestVerificationToken" type="hidden" value="tok-123" />')).toBe('tok-123')
  expect(parseCsrfToken('<div>no token here</div>')).toBeUndefined()
})

test('parseCloudflowResult unwraps the doubly-stringified envelope; empty on error/garbage', () => {
  const ok = { json: JSON.stringify({ resultat: JSON.stringify([{ a: 1 }, { a: 2 }]) }) }

  expect(parseCloudflowResult<{ a: number }>(ok)).toEqual([{ a: 1 }, { a: 2 }])
  expect(parseCloudflowResult({ ErrorCode: 'FlowDisabled' })).toEqual([])
  expect(parseCloudflowResult(null)).toEqual([])
  expect(parseCloudflowResult({ json: 'not json' })).toEqual([])
})

// --- assets ---

test('parseFilgoActifs scrapes the account select + reservoir card fields', () => {
  const { accounts, tanks } = parseFilgoActifs(ACTIFS_HTML)

  expect(accounts).toEqual([{ guid: 'acct-guid-1', number: '12345678', name: '12345678 SAMPLE CLIENT' }])
  expect(tanks).toHaveLength(1)
  expect(tanks[0]).toEqual({
    assetId: 'asset-guid-1',
    name: 'RÉSERVOIR PROPANE - SAMPLE',
    product: 'PROPANE',
    capacity: '454 L',
    serviceState: 'Fonctionnel',
    address: '1 rue Exemple, Ville QC A1A 1A1'
  })
})

test('buildFilgoTanks maps the roster to one valid table with a service-state badge', () => {
  const result = buildFilgoTanks(parseFilgoActifs(ACTIFS_HTML))

  expect(validateCapabilityResult(result)).toEqual([])
  const tanks = result.datasets.find((d) => d.id === 'tanks') as unknown as {
    columns: { key: string; badges?: unknown }[]
  }
  const state = tanks.columns.find((c) => c.key === 'serviceState')

  expect(state?.badges).toMatchObject({ Fonctionnel: 'success' })
})

// --- statements ---

test('normalizeStatement reads accented metadata keys; number falls back to the doc name', () => {
  expect(normalizeStatement(STATEMENT_DOC)).toEqual({
    date: '2026-03-31',
    number: '6548728',
    total: 320.78,
    url: 'https://example.invalid/statements/abc',
    docName: 'ECOI_12345678_6548728'
  })

  const noNumber: RawStatementDoc = { ...STATEMENT_DOC, metadataV2: STATEMENT_DOC.metadataV2!.slice(0, 2) }

  expect(normalizeStatement(noNumber).number).toBe('6548728')
})

test('buildFilgoStatements: spend summary from the newest statement + a downloadable statements table', () => {
  const older: RawStatementDoc = {
    ...STATEMENT_DOC,
    name: 'ECOI_12345678_6428963',
    metadataV2: [
      { key: "Date de l'état de compte", value: '2026-02-28T00:00:00' },
      { key: "Total de l'état de compte", value: 280.46 },
      { key: 'No relevé', value: '6428963' }
    ]
  }
  const result = buildFilgoStatements({ account: '12345678', statements: [older, STATEMENT_DOC] })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 320.78, basis: 'lastInvoice' })

  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'statements') as { files?: unknown }

  expect(view.files).toMatchObject({ source: { url: 'url' }, name: 'name', ext: 'pdf', category: 'Relevés' })
})

test('buildFilgoStatements: no statements → valid result with no spend summary', () => {
  const result = buildFilgoStatements({ account: null, statements: [] })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
  expect(result.datasets.some((d) => d.id === 'statements')).toBe(false)
})

// --- deliveries ---

test('buildFilgoDeliveries maps tickets newest-first with a price-trend chart', () => {
  const result = buildFilgoDeliveries({
    deliveries: [
      {
        tickref: '00104537970 ',
        createdt: '2026-01-05T13:23:06.947',
        net_vol: 197.2,
        net_price: 1.086,
        grand_total: 280.45
      },
      { tickref: '00105848165', createdt: '2026-03-09T12:25:29', net_vol: 216.6, net_price: 1.146, grand_total: 320.77 }
    ]
  })

  expect(validateCapabilityResult(result)).toEqual([])
  const rows = (result.datasets.find((d) => d.id === 'deliveries') as unknown as { rows: Record<string, unknown>[] })
    .rows

  expect(rows[0]).toMatchObject({
    date: '2026-03-09',
    volume: 216.6,
    unitPrice: 1.146,
    total: 320.77,
    ticket: '00105848165'
  })
  expect(rows[1].date).toBe('2026-01-05')
  expect(result.views?.some((v) => v.type === 'timeseries' && v.dataset === 'deliveries' && v.y === 'unitPrice')).toBe(
    true
  )
})
