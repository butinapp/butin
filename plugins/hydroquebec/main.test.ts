import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { createSampleGen, resolveSampleConfig } from '@butinapp/sdk/testing'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import {
  buildHydroAccounts,
  buildHydroBilling,
  buildHydroConsumption,
  buildHydroProperties,
  buildHydroSummary,
  hydroquebecPlugin,
  parseInvoiceHistory,
  type RawPortfolio
} from './main.js'
import { sampleHydroPortfolio } from './sample.js'

const CCY = 'CAD'
const validate = (r: Parameters<typeof resolveCurrencies>[0]): string[] => rawValidateCR(resolveCurrencies(r, CCY))

const fixture = (): RawPortfolio =>
  JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/portfolio-bundle.json', import.meta.url)), 'utf-8'))

const findDataset = (r: { datasets: { id: string }[] }, id: string): unknown => r.datasets.find((d) => d.id === id)

describe('buildHydroSummary', () => {
  test('sums current bills across every account and emits a spend summary', () => {
    const r = buildHydroSummary(fixture())

    expect(validate(r)).toEqual([])
    const summary = r.summaries?.[0]

    expect(summary?.section).toBe('spend')
    // 50.41 + 160.94 + 89.12
    expect(summary?.value).toBeCloseTo(300.47, 2)
  })

  test('counts accounts + properties and totals balance + overdue in the headline cards', () => {
    const account = findDataset(buildHydroSummary(fixture()), 'account') as { value: Record<string, unknown> }

    expect(account.value.accounts).toBe(3)
    expect(account.value.properties).toBe(3)
    // 0 + 160.94 + 89.12 balance; 0 + 0 + 12 overdue
    expect(account.value.balance).toBeCloseTo(250.06, 2)
    expect(account.value.overdue).toBeCloseTo(12, 2)
  })
})

describe('buildHydroBilling', () => {
  test('lists every issued invoice, newest first, keyed to the real consumption address', () => {
    const r = buildHydroBilling(fixture())

    expect(validate(r)).toEqual([])

    const invoices = findDataset(r, 'invoices') as { rows: Record<string, unknown>[] }

    // 4 + 3 + 3 invoices across the three accounts.
    expect(invoices.rows).toHaveLength(10)
    expect(invoices.rows.every((row) => row.account && row.address && row.noFacture)).toBe(true)
    // Sorted newest first by invoice date.
    expect(String(invoices.rows[0].date) >= String(invoices.rows[1].date)).toBe(true)

    // The Laval invoices carry the real consumption address, not the billing address.
    const laval = invoices.rows.filter((row) => String(row.address).includes('Laval'))

    expect(laval).toHaveLength(3)
    expect(laval.find((row) => row.noFacture === '740000000003')?.amount).toBeCloseTo(89.12, 2)
  })

  test('the full energy breakdown stays on a separate billing-periods table', () => {
    const periods = findDataset(buildHydroBilling(fixture()), 'periods') as { rows: Record<string, unknown>[] }

    // 4 + 3 + 3 billed periods; the credit + kWh detail rides here.
    expect(periods.rows).toHaveLength(10)
    const july = periods.rows.find((row) => row.periodEnd === '2026-07-31')

    expect(july?.credit).toBeCloseTo(5, 2)
    expect(july?.amount).toBeCloseTo(77.5, 2)
  })

  test('marks the invoice table a fetch-sourced files view carrying each invoice its relationship', () => {
    const r = buildHydroBilling(fixture())
    const invoices = findDataset(r, 'invoices') as { rows: Record<string, unknown>[] }

    // Each row carries the number + PDF hash + relationship the portal PDF download re-issues.
    expect(invoices.rows.every((row) => row.noFacture && row.idFacturePDF && row.demandeur && row.titulaire)).toBe(true)
    // The invoice view is the fetch-sourced files table (checkboxes + Export in the UI).
    const view = r.views?.find((v) => v.type === 'table' && (v as { dataset?: string }).dataset === 'invoices') as {
      files?: { source?: { fetch?: boolean } }
    }

    expect(view?.files?.source?.fetch).toBe(true)
  })

  test('drops the invoice table when none were enumerated, keeping the energy periods', () => {
    const p = fixture()

    p.invoiceDocs = []
    const r = buildHydroBilling(p)

    expect(findDataset(r, 'invoices')).toBeUndefined()
    expect(findDataset(r, 'periods')).toBeDefined()
  })
})

describe('parseInvoiceHistory', () => {
  // Two invoice rows (each with a download anchor carrying noFacture + idFacturePDF) plus a payment row that has
  // no such anchor — the shape the portal history page renders.
  const html = `
    <table><tbody>
      <tr class="odd">
        <td class="tblCenter bill-checkbox"><input data-nofacture="770903374144"></td>
        <td class="tblCenter bill-date date sorting_1"> 2026-07-02 </td>
        <td class="currency"><span class="sort-value" valeur="1&nbsp;160,94&nbsp;$">1&nbsp;160,94&nbsp;$</span></td>
        <td class="bill-download">
          <a name="resourceVisionnerFacture" class="button file-link"
             href="https://services-cl.solutions.hydroquebec.com/lsw/portail/fr/group/clientele/historique-des-operations/resourceVisionnerFacturePDF?noFacture=770903374144&amp;idFacturePDF=31868CD280E61FE19DD0F8D699B35E89">Fichier</a>
        </td>
      </tr>
      <tr class="even">
        <td class="tblCenter bill-checkbox"><input data-nofacture="764503486743"></td>
        <td class="tblCenter bill-date date"> 2026-05-02 </td>
        <td class="currency"><span class="sort-value" valeur="89,12&nbsp;$">89,12&nbsp;$</span></td>
        <td class="bill-download">
          <a name="resourceVisionnerFacture"
             href="/lsw/portail/fr/group/clientele/historique-des-operations/resourceVisionnerFacturePDF?noFacture=764503486743&amp;idFacturePDF=3F5AFE9B88C51FD197DD0B420917ABE2">Fichier</a>
        </td>
      </tr>
      <tr class="odd">
        <td class="tblCenter bill-date date"> 2026-05-20 </td>
        <td class="currency">Paiement</td>
      </tr>
    </tbody></table>`

  test('reads each invoice row: number, PDF hash, day, and fr-formatted total — skipping non-invoice rows', () => {
    const docs = parseInvoiceHistory(html, '0106097377', '0106097377')

    expect(docs).toHaveLength(2)
    expect(docs[0]).toMatchObject({
      noFacture: '770903374144',
      idFacturePDF: '31868CD280E61FE19DD0F8D699B35E89',
      date: '2026-07-02',
      amount: 1160.94,
      demandeur: '0106097377',
      titulaire: '0106097377'
    })
    expect(docs[1].noFacture).toBe('764503486743')
    expect(docs[1].amount).toBeCloseTo(89.12, 2)
  })
})

describe('buildHydroAccounts', () => {
  test('one row per account, addresses differ, payment method + overdue normalized', () => {
    const accounts = findDataset(buildHydroAccounts(fixture()), 'accounts') as { rows: Record<string, unknown>[] }

    expect(accounts.rows).toHaveLength(3)
    expect(new Set(accounts.rows.map((row) => row.address)).size).toBe(3)
    const manual = accounts.rows.find((row) => row.payment === 'Manual')

    expect(manual?.overdue).toBeCloseTo(12, 2)
  })
})

describe('buildHydroProperties', () => {
  test('one row per contract with meter, tariff, and heating joined from the portrait', () => {
    const r = buildHydroProperties(fixture())

    expect(validate(r)).toEqual([])

    const props = findDataset(r, 'properties') as { rows: Record<string, unknown>[] }

    expect(props.rows).toHaveLength(3)
    expect(props.rows.filter((row) => row.equalPayments === 'Equalized')).toHaveLength(1)
    expect(props.rows.every((row) => row.heating !== '—')).toBe(true)
  })
})

describe('buildHydroConsumption', () => {
  test('latest period per property + a monthly kWh series stacked by property', () => {
    const r = buildHydroConsumption(fixture())

    expect(validate(r)).toEqual([])

    const latest = findDataset(r, 'consumption') as { rows: Record<string, unknown>[] }

    expect(latest.rows).toHaveLength(3)
    // The latest Québec period reads 488 kWh billed at 67.77.
    const quebec = latest.rows.find((row) => String(row.address).includes('1-100'))

    expect(quebec?.kwh).toBe(488)
    expect(quebec?.amount).toBeCloseTo(67.77, 2)

    // 3 properties × 3 months of history.
    const monthly = findDataset(r, 'monthly-kwh') as { rows: Record<string, unknown>[] }

    expect(monthly.rows).toHaveLength(9)
  })
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of hydroquebecPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validate(cap.sample!()), cap.id).toEqual([])
  }
})

test('sample scales properties with the users knob and spans two relationships', () => {
  const p = sampleHydroPortfolio(createSampleGen('hydroquebec:t'), resolveSampleConfig({ users: 4 }))

  expect(p.accounts).toHaveLength(4)
  expect(p.contracts).toHaveLength(4)
  expect(new Set(p.accounts.map((a) => a.titulaire)).size).toBe(2)
})
