// Synthetic sample generator for the demo seed — builds a whole RawTaxData bundle purely from the seeded toolkit
// (no real data; addresses come from the toolkit, ids are fabricated), drawn through the SAME build* the live
// collectors use. The `users` knob scales the property count, `documents` the invoices/statements per property.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawInvoice, RawProperty, RawStatement, RawTaxData } from './main.js'

const DOC = 'https://example.invalid/tfp'

export const sampleTaxData = (g: SampleGen, config: SampleConfig): RawTaxData => {
  const properties: RawProperty[] = g.repeat(Math.max(1, Math.min(config.users, 3)), () => {
    const matricule = String(g.int(10_000_000, 99_999_999)) + String(g.int(1_000_000_000_000_00, 9_999_999_999_999_99))
    const dossier = `50-${String(g.int(1_000_000, 9_999_999)).padStart(8, '0')}`

    return {
      matricule,
      dossier,
      address: g.address(),
      invoiceListUrl: `${DOC}?jlrun=ListeFactEnLigne&Matr=${matricule}`,
      statementListUrl: `${DOC}?jlrun=ListeEtatCompte&Matr=${matricule}`
    }
  })

  const perProperty = Math.max(1, Math.min(config.documents, 8))

  const invoices = properties.flatMap((property) =>
    g.repeat(perProperty, (i): { property: RawProperty; invoice: RawInvoice } => {
      // A fixed base year keeps the seed deterministic; one invoice per prior year.
      const noFactComplet = `${2026 - i}01000${String(g.int(100_000, 999_999))}`

      return {
        property,
        invoice: {
          idFact: g.id('fact'),
          noFactComplet,
          produireUrl: `${DOC}?jlrun=Produire&NO_FACT_COMPL=${noFactComplet}`
        }
      }
    })
  )

  const statements = properties.flatMap((property) =>
    g.repeat(perProperty, (): { property: RawProperty; statement: RawStatement } => {
      const idCr = String(g.int(1, 9_999_999)).padStart(10, '0')

      return {
        property,
        statement: {
          idCr,
          codeAcces: g.pick(['EXEMP', 'DUPRE', 'TREMB']),
          produireUrl: `${DOC}?jlrun=Produire&ID_CR=${idCr}`
        }
      }
    })
  )

  return { properties, invoices, statements }
}
