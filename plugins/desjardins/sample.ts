// Synthetic sample GENERATORS for the demo seed — each builds a raw AccèsD response purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. `documents` caps the statement history; everything is fabricated — invented nicknames, zeroed
// account/card numbers, made-up balances. Money is in the wire's own fr-CA form ("4 000,00 $" — space thousands
// separator, comma decimal, $ suffix), exactly as AccèsD returns it.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { DesjComptesResponse, DesjStatementsBundle } from './main.js'

// Format a dollar amount the way AccèsD does: "4 000,00 $" (space-grouped thousands, comma decimal, $ suffix).
const frAmount = (n: number): string =>
  `${n
    .toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} $`

export const sampleDesjardinsComptes = (g: SampleGen, _config: SampleConfig): DesjComptesResponse => {
  const chequing = g.money(400, 2_000)
  const savings = g.money(200, 1_200)
  const card = g.money(50, 600)
  const mortgage = g.money(80_000, 160_000)
  const investment = g.money(500, 6_000)

  return {
    dataTiroirComptesBancaires: {
      montantComptes: frAmount(chequing + savings),
      listeCompte: [
        {
          descriptions: ['000000-EOP Compte d’opérations courantes', '', 'Démo'],
          type: 'EOP',
          montantAvecDevise: frAmount(chequing),
          codeISODevise: 'CAD'
        },
        {
          descriptions: ['000000-ET1 Compte d’épargne - CELI', '', 'Démo'],
          type: 'ET',
          montantAvecDevise: frAmount(savings),
          codeISODevise: 'CAD'
        }
      ]
    },
    dataTiroirCartesPretsMarges: {
      montantPretsCartesMarges: frAmount(card + mortgage),
      listeProduitFinancement: [
        {
          descriptions: ['CARTE DEMO', '', '**** **** **** 0000'],
          montantAvecDevise: frAmount(card),
          codeISODevise: 'CAD',
          produitFinancementRessourceType: 'COMPTE_VISA'
        },
        {
          descriptions: ['000000-PR6 Prêt hypothécaire résidentiel', '', 'Démo'],
          montantAvecDevise: frAmount(mortgage),
          codeISODevise: 'CAD',
          produitFinancementRessourceType: 'COMPTE_PRET'
        }
      ]
    },
    dataTiroirEpargnePlacements: {
      montantTotal: frAmount(investment),
      epargnePlacementRessources: [
        {
          descriptions: ['000000-ET2 Portefeuille garanti - 5 ans - REER', '', 'Démo'],
          montant: frAmount(investment),
          type: 'PLACEMENT_GARANTIS',
          dateEcheance: '2029-04-18',
          numeroCompte: '000000'
        }
      ]
    }
  }
}

export const sampleDesjardinsStatements = (g: SampleGen, config: SampleConfig): DesjStatementsBundle => {
  const primary = '000000A000000000'
  const secondary = '111111B111111000'
  const count = Math.min(config.documents, 36)

  return {
    cards: [
      {
        numeroCompteJeton: primary,
        numeroCompteJetonSigne: 'AbC+dE/fG=',
        descriptionLongue: 'Carte de démo World Elite',
        descriptionCourte: 'Démo World Elite',
        codeRolePartieEntente: 'P'
      },
      {
        numeroCompteJeton: secondary,
        numeroCompteJetonSigne: 'XyZ123=',
        descriptionLongue: 'Carte prépayée de démo',
        descriptionCourte: 'Prépayée démo',
        codeRolePartieEntente: 'P'
      }
    ],
    statements: g.repeat(count, (i) => ({
      numeroCompteJeton: i % 3 === 0 ? secondary : primary,
      dateReleve: `${g.monthsAgo(i).yearMonth}-01`,
      typeReleve: 'Individuel',
      uuidReleve: g.id('rel')
    }))
  }
}
