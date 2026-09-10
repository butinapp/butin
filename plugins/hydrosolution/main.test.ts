import { validateCapabilityResult } from '@butinapp/sdk/data'
import { validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildHydroBilling,
  buildHydroEquipment,
  buildHydroSummaryResult,
  extractDetailUrl,
  frDateToIso,
  hydrosolutionPlugin,
  parseAccountNumber,
  parseHydroBills,
  parseHydroDetail,
  parseHydroSummary
} from './main.js'

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(hydrosolutionPlugin)).toEqual([])
})

test('ships an English map for its French rental vocabulary (incl. Location = rental)', () => {
  const en = hydrosolutionPlugin.meta.messages?.en

  expect(en?.['Location']).toBe('Rental')
  expect(en?.['Équipement loué']).toBe('Rented equipment')
  expect(en?.['Relevé de compte']).toBe('Account statement')
})

// All fixtures below are SYNTHETIC — structurally faithful to the portal HTML but with invented data
// (no real names, addresses, account numbers, or cookies). The repo is public.

const BILLS_HTML = `
<div class="box-detail">
  <p class="esLabel"><span>Numéro de compte : </span>00000000000</p>
  <div class="grid_historique" id="billsTable">
    <div class="gh_titre">Date</div><div class="gh_titre">Montant</div><div class="gh_titre">Numéro de facture</div><div class="gh_titre"> </div>
    <div class="gh_date">11-06-2026</div><div class="gh_montant"><b>18.79$</b></div><div class="gh_facture">90000002</div><div class="gh_btn"> <a target="_blank" class="bouton" href="?getBillPDF&billID=OTAwMDAwMDI=">Afficher</a></div>
    <div class="gh_date">11-05-2026</div><div class="gh_montant"><b>17.93$</b></div><div class="gh_facture">90000001</div><div class="gh_btn"> <a target="_blank" class="bouton" href="?getBillPDF&billID=OTAwMDAwMDE=">Afficher</a></div>
  </div>
</div>`

const LANDING_HTML = `
<div id="ec_content"><div class="ec_dashboard">
  <div class="dash_box" id="dash_compte">
    <p>Solde précédent <span class="floatRight">18,79 $</span></p>
    <p>Paiements et/ou crédits<br />depuis le dernier relevé <span class="floatRight">18,79 $</span></p>
    <p>Frais actuels <span class="floatRight">18,79 $</span></p>
    <p>Dernier montant dû <span class="floatRight">18,79 $</span></p>
    <p>Date d'échéance <span class="floatRight">02-07-2026</span></p>
    <p><a href="https://www.hydrosolution.com/espace-client/factures-en-ligne/">Voir l'historique</a></p>
  </div>
  <div class="dash_box" id="dash_equipements">
    <div class="text-center">
      <a class="esButton seeEquipmentDetailButton" href="https://www.hydrosolution.com/espace-client/detail-espace-client/?account=OTk5OTk=">Voir le détail</a>
    </div>
  </div>
</div></div>`

const DETAIL_HTML = `
<div id="details_equipement">
  <div id="installationAddress" class="dash_box">
    <h3 class="esBlockTitle maison">Adresse de l'installation</h3>
    <p><span class="esLabel">Adresse complète</span><br /> 100-1 rue de la Démo<br /> Montreal , QUÉBEC &nbsp;H0H 0H0 </p>
    <div class="separateur"></div>
    <p><span class="esLabel">Type de logement</span><br /> Condominium </p>
  </div>
  <div id="esEquipementsServicesDetails" class="dash_box">
    <h3 class="esBlockTitle equipement">Équipements et services</h3>
    <p><span class='esLabel'>CH-EAU 40 GAL </span><br /> Numéro de série : 9000000 <br />
      <span class="esLabel small">Installation</span><br /><span class="smallText">07-12-2018</span></p>
    <div class="separateur"></div>
    <p><span class="esLabel">Garantie restante sur la main d'oeuvre : ILLIMITÉ</span></p>
    <p><span class="esLabel">Garantie restante sur le réservoir : ILLIMITÉ</span></p>
    <p><span class="esLabel">Garantie restante sur les pièces : ILLIMITÉ</span></p>
    <div class="separateur"></div><p>Cet équipement est en <span class='esLabel'>Location à 16.34$/mois</span></p>
  </div>
</div>`

// --- descriptor ---

test('hydrosolution needs the browser engine, cookie session keyed on the durable remember cookie', () => {
  expect(hydrosolutionPlugin.auth.kind).toBe('cookie')
  expect(hydrosolutionPlugin.transport?.requiresBrowserEngine).toBe(true)
  expect(hydrosolutionPlugin.session?.requiredCookie).toBe('remember')
  expect(hydrosolutionPlugin.session?.cookieDomains).toContain('hydrosolution.com')
  expect(hydrosolutionPlugin.meta.category).toBe('rental')
})

// --- primitives ---

test('frDateToIso flips DD-MM-YYYY to ISO', () => {
  expect(frDateToIso('11-06-2026')).toBe('2026-06-11')
  expect(frDateToIso('garbage')).toBe('')
})

// --- billing ---

test('parseHydroBills extracts dated, priced bills with absolute PDF urls', () => {
  const bills = parseHydroBills(BILLS_HTML)

  expect(bills).toHaveLength(2)
  expect(bills[0]).toMatchObject({ date: '2026-06-11', amount: 18.79, number: '90000002' })
  expect(bills[0].pdfUrl).toBe(
    'https://www.hydrosolution.com/espace-client/factures-en-ligne/?getBillPDF&billID=OTAwMDAwMDI='
  )
  expect(bills[1].amount).toBe(17.93)
})

test('parseAccountNumber reads the number that sits outside the label span', () => {
  expect(parseAccountNumber(BILLS_HTML)).toBe('00000000000')
})

test('parseHydroSummary reads the landing account-statement box', () => {
  const s = parseHydroSummary(LANDING_HTML)

  expect(s.previousBalance).toBe(18.79)
  expect(s.payments).toBe(18.79)
  expect(s.currentCharges).toBe(18.79)
  expect(s.amountDue).toBe(18.79)
  expect(s.dueDate).toBe('2026-07-02')
})

test('buildHydroSummaryResult: CAD headline (amount due + account + bill count) + monthly spark', () => {
  const result = buildHydroSummaryResult(parseHydroBills(BILLS_HTML), '00000000000', parseHydroSummary(LANDING_HTML))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 18.79,
    currency: 'CAD',
    label: 'Montant dû',
    basis: 'lastInvoice'
  })
  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ currentMtd: 18.79, account: '00000000000', billCount: 2 })
  // no invoices table on Summary — that's the Factures detail tab
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

test('buildHydroSummaryResult falls back to the newest bill when there is no statement', () => {
  const result = buildHydroSummaryResult(parseHydroBills(BILLS_HTML))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]?.value).toBe(18.79)
})

test('buildHydroBilling: downloadable Factures table (pdfUrl) + statement keyvalue, no Summary headline', () => {
  const result = buildHydroBilling(parseHydroBills(BILLS_HTML), parseHydroSummary(LANDING_HTML))

  expect(validateCapabilityResult(result)).toEqual([])
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

  expect(view.files).toMatchObject({ name: 'name', source: { url: 'pdfUrl' }, ext: 'pdf', category: 'Factures' })

  const invoices = result.datasets.find((d) => d.id === 'invoices')

  if (invoices?.shape !== 'table') {
    throw new Error('expected invoices table')
  }

  expect(invoices.rows[0]).toMatchObject({ date: '2026-06-11', number: '90000002', name: 'Facture 2026-06-11' })
  // keyed by the unique bill number so invoices accumulate in the ledger.
  expect(invoices.key).toBe('number')
  expect(result.datasets.some((d) => d.id === 'statement')).toBe(true)
  // headline + chart live on Summary
  expect(result.datasets.some((d) => d.id === 'account' || d.id === 'monthly')).toBe(false)
})

test('buildHydroBilling drops the statement when there is no account summary', () => {
  const result = buildHydroBilling(parseHydroBills(BILLS_HTML))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'statement')).toBe(false)
})

test('hydrosolution leads with a Summary tab and has no separate documents capability', () => {
  expect(hydrosolutionPlugin.capabilities[0]).toMatchObject({ id: 'summary' })
  expect(hydrosolutionPlugin.capabilities.some((c) => 'enumerate' in c)).toBe(false)
})

// --- equipment ---

test('extractDetailUrl follows the landing seeEquipmentDetailButton link', () => {
  expect(extractDetailUrl(LANDING_HTML)).toBe(
    'https://www.hydrosolution.com/espace-client/detail-espace-client/?account=OTk5OTk='
  )
})

test('parseHydroDetail extracts installation, equipment, and warranties', () => {
  const d = parseHydroDetail(DETAIL_HTML)

  expect(d.installation.address).toContain('100-1 rue de la Démo')
  expect(d.installation.housingType).toBe('Condominium')
  expect(d.equipment.name).toBe('CH-EAU 40 GAL')
  expect(d.equipment.serial).toBe('9000000')
  expect(d.equipment.installDate).toBe('2018-12-07')
  expect(d.equipment.rental).toBe('16.34$/mois')
  expect(d.equipment.warranties).toHaveLength(3)
  expect(d.equipment.warranties[0]).toMatchObject({ part: "la main d'oeuvre", remaining: 'ILLIMITÉ' })
})

test('buildHydroEquipment produces a valid custom-kind dashboard result', () => {
  const result = buildHydroEquipment(parseHydroDetail(DETAIL_HTML))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['equipment', 'installation', 'warranties'])
  // The warranties table keys on the covered part — always present and unique per row.
  const warranties = result.datasets.find((d) => d.id === 'warranties') as unknown as { key: string }

  expect(warranties.key).toBe('part')
})
