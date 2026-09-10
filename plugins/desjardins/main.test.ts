import type { CollectContext } from '@butinapp/sdk'
import { validateCapabilityResult } from '@butinapp/sdk/data'
import { validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildDesjardinsAccounts,
  buildStatementsTable,
  type DesjComptesResponse,
  desjardinsPlugin,
  encodeSignedForBody,
  fetchAllStatements,
  parseCards,
  parseHoldings,
  parseStatements,
  relevesBodyForYear
} from './main.js'

// `releves-compte` is the browser-backed legacy debit flow — an imperative collector that can't be split into
// fetch/build, so it declares no sample and draws the seed's generic fallback.
test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(desjardinsPlugin, { optional: ['releves-compte'] })).toEqual([])
})

test('ships an English map for its French banking vocabulary', () => {
  const en = desjardinsPlugin.meta.messages?.en

  expect(en?.['Cartes, prêts et marges']).toBe('Cards, loans & lines of credit')
  expect(en?.['Épargne et placements']).toBe('Savings & investments')
  expect(en?.['Avoir net']).toBe('Net worth')
})

// All fixtures below are SYNTHETIC — structurally faithful to the obtenirListeMesComptes response but
// with invented data (no real names, account numbers, balances, or cookies). The repo is public.

const RESPONSE: DesjComptesResponse = {
  dataTiroirComptesBancaires: {
    montantComptes: '5 000,00 $',
    listeCompte: [
      {
        descriptions: ['000000-EOP Compte d’opérations courantes', '', 'Démo'],
        type: 'EOP',
        montantAvecDevise: '4 000,00 $',
        codeISODevise: 'CAD'
      },
      {
        descriptions: ['000000-ET1 Compte d’épargne - CELI', '', 'Démo'],
        type: 'ET',
        montantAvecDevise: '1 000,00 $',
        codeISODevise: 'CAD'
      }
    ]
  },
  dataTiroirCartesPretsMarges: {
    montantPretsCartesMarges: '200 000,00 $',
    listeProduitFinancement: [
      {
        descriptions: ['CARTE DEMO', '', '**** **** **** 0000'],
        montantAvecDevise: '500,00 $',
        codeISODevise: 'CAD',
        produitFinancementRessourceType: 'COMPTE_VISA'
      },
      {
        descriptions: ['000000-PR6 Prêt hypothécaire résidentiel', '', 'Démo'],
        montantAvecDevise: '199 500,00 $',
        codeISODevise: 'CAD',
        produitFinancementRessourceType: 'COMPTE_PRET'
      }
    ]
  },
  dataTiroirEpargnePlacements: {
    montantTotal: '1 500,00 $',
    epargnePlacementRessources: [
      {
        descriptions: ['000000-ET2 Portefeuille garanti - 5 ans - REER', '', 'Démo'],
        montant: '1 500,00 $',
        type: 'PLACEMENT_GARANTIS',
        dateEcheance: '2029-04-18',
        numeroCompte: '000000'
      },
      {
        descriptions: ['Disnat', 'Cpt - 0000000'],
        montant: '0,00 $',
        type: 'PLACEMENT_VALEURS_MOBILIERES',
        dateEcheance: null,
        numeroCompte: '0000000'
      }
    ]
  }
}

// --- descriptor ---

test('desjardins is an electron spa-bearer session (Bearer captured off the accesdc.mouv SPA) keyed on atk_accesd', () => {
  const { auth } = desjardinsPlugin

  expect(auth.kind).toBe('spa-bearer')

  if (auth.kind === 'spa-bearer') {
    expect(auth.bootUrl).toBe('https://accesdc.mouv.desjardins.com/accueil')
    expect(auth.authCaptureUrlPatterns).toEqual(['https://accesdc.mouv.desjardins.com/api/*'])
  }

  expect(desjardinsPlugin.transport?.engine).toBe('electron')
  // The credit-card /documents GET needs the gestionnaire-releve referer; the legacy debit flow drives one
  // stateful AccèsWeb session, so downloads serialize (concurrency:1) — both live on transport.download.
  expect(desjardinsPlugin.transport?.download).toEqual({
    referer: 'https://accesdc.mouv.desjardins.com/credit/gestionnaire-releve/particulier/',
    concurrency: 1
  })
  expect(desjardinsPlugin.session?.requiredCookie).toBe('atk_accesd')
  expect(desjardinsPlugin.session?.cookieDomains).toContain('desjardins.com')
  expect(desjardinsPlugin.meta.category).toBe('finance')
  expect(desjardinsPlugin.capabilities.map((c) => c.id)).toEqual(['accounts', 'statements', 'releves-compte'])
})

// --- parseHoldings ---

test('parseHoldings normalizes the three drawers and keeps the server totals verbatim', () => {
  const h = parseHoldings(RESPONSE)

  expect(h.accounts).toHaveLength(2)
  expect(h.accounts[0]).toMatchObject({ name: '000000-EOP Compte d’opérations courantes — Démo', amount: 4000 })
  expect(h.credit).toHaveLength(2)
  expect(h.credit[0]).toMatchObject({ name: 'CARTE DEMO — **** **** **** 0000', type: 'Carte de crédit', amount: 500 })
  expect(h.credit[1].type).toBe('Prêt')
  expect(h.investments).toHaveLength(2)
  expect(h.investments[0]).toMatchObject({
    name: '000000-ET2 Portefeuille garanti - 5 ans - REER — Démo',
    maturity: '2029-04-18',
    amount: 1500
  })
  expect(h.investments[1].maturity).toBe('')
  // server totals, NOT a sum of items
  expect(h.totals).toEqual({ bank: 5000, credit: 200000, investments: 1500 })
})

test('parseHoldings tolerates missing drawers', () => {
  const h = parseHoldings({ dataTiroirComptesBancaires: { montantComptes: '10,00 $', listeCompte: [] } })

  expect(h.accounts).toEqual([])
  expect(h.credit).toEqual([])
  expect(h.investments).toEqual([])
  expect(h.totals).toEqual({ bank: 10, credit: 0, investments: 0 })
})

// --- buildDesjardinsAccounts ---

test('buildDesjardinsAccounts produces a valid balance result with a net-worth summary and per-drawer tables', () => {
  const result = buildDesjardinsAccounts(parseHoldings(RESPONSE))

  expect(validateCapabilityResult(result)).toEqual([])
  // net = bank(5000) + investments(1500) - credit(200000) = -193500
  expect(result.summaries?.[0]).toMatchObject({ section: 'balance', value: -193500, role: 'money', currency: 'CAD' })
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['accounts', 'credit', 'investments', 'totals'])

  // Each drawer accumulates its balance history keyed by the account label (its stable identity).
  for (const id of ['accounts', 'credit', 'investments']) {
    const ds = result.datasets.find((d) => d.id === id)

    expect(ds?.shape === 'table' && ds.key, id).toBe('name')
  }

  const totals = result.datasets.find((d) => d.id === 'totals')

  expect(totals?.shape).toBe('record')

  if (totals?.shape !== 'record') {
    throw new Error('expected totals record')
  }

  expect(totals.value.net).toBe(-193500)
})

test('buildDesjardinsAccounts omits empty drawers but always keeps the totals stat', () => {
  const result = buildDesjardinsAccounts({
    accounts: [],
    credit: [],
    investments: [],
    totals: { bank: 0, credit: 0, investments: 0 }
  })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.map((d) => d.id)).toEqual(['totals'])
  expect(result.summaries?.[0]?.value).toBe(0)
})

// --- credit-card statements (downloadable table) ---

const CARDS = [
  {
    numeroCompteJeton: '000000A000000000',
    numeroCompteJetonSigne: 'AbC+dE/fG=',
    descriptionLongue: 'Desjardins Remises World Elite Mastercard',
    descriptionCourte: 'Remises World Elite Mastercard',
    codeRolePartieEntente: 'P'
  },
  {
    numeroCompteJeton: '111111B111111000',
    numeroCompteJetonSigne: 'XyZ123=',
    descriptionLongue: 'Carte prépayée Visa Desjardins',
    descriptionCourte: 'Carte prépayée Visa',
    codeRolePartieEntente: 'P'
  }
]

const RELEVES_LISTE = {
  sommaireRelevesListe: [
    { numeroCompteJeton: '000000A000000000', dateReleve: '2026-05-28', typeReleve: 'Individuel', uuidReleve: 'u1' },
    { numeroCompteJeton: '000000A000000000', dateReleve: '2026-04-29', typeReleve: 'Individuel', uuidReleve: 'u2' },
    { numeroCompteJeton: '111111B111111000', dateReleve: '2026-05-07', typeReleve: 'Individuel', uuidReleve: 'u3' }
  ]
}

test('parseCards / parseStatements read the detention array and the relevesListe envelope', () => {
  expect(parseCards(CARDS)).toHaveLength(2)
  expect(parseCards({})).toEqual([])
  expect(parseStatements(RELEVES_LISTE)).toHaveLength(3)
  expect(parseStatements(null)).toEqual([])
})

test('encodeSignedForBody escapes only + and = (leaves / raw, matching the captured body)', () => {
  expect(encodeSignedForBody('AbC+dE/fG=')).toBe('AbC%2BdE/fG%3D')
})

test('buildStatementsTable yields a downloadable statements table (newest first), filename per card', () => {
  const result = buildStatementsTable(CARDS, parseStatements(RELEVES_LISTE))

  expect(validateCapabilityResult(result)).toEqual([])
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'statements') as {
    files?: Record<string, unknown>
  }

  // The download referer (CC_REFERER) is on transport.download, not on the files descriptor.
  expect(view.files).toMatchObject({
    name: 'name',
    source: { url: 'downloadUrl' },
    ext: 'pdf',
    category: 'Relevés de carte'
  })

  const rows = (result.datasets.find((d) => d.id === 'statements') as unknown as { rows: Record<string, unknown>[] })
    .rows

  // Each statement accumulates in the ledger keyed by card + date + type.
  const statements = result.datasets.find((d) => d.id === 'statements')

  expect(statements?.shape === 'table' && statements.key).toEqual(['card', 'date', 'type'])

  expect(rows).toHaveLength(3)
  // newest first
  expect(rows[0]).toMatchObject({
    date: '2026-05-28',
    card: 'Desjardins Remises World Elite Mastercard',
    name: 'Relevé Desjardins Remises World Elite Mastercard 2026-05-28'
  })
  // the download URL carries the encodeURIComponent'd signed token + date
  expect(String(rows[0].downloadUrl)).toContain('numeroCompteSigne=AbC%2BdE%2FfG%3D')
  expect(String(rows[0].downloadUrl)).toContain('dateReleve=2026-05-28')
})

test('relevesBodyForYear builds a one-year window with the body-escaped signed token and the card role', () => {
  const body = relevesBodyForYear(2021, CARDS) as {
    dateDebut: string
    dateFin: string
    codeRolePartieEntente: string
    compteListes: { numeroCompteJeton?: string; numeroCompteJetonSigne?: string }[]
  }

  expect(body.dateDebut).toBe('2021-01-01')
  // dateFin is the NEXT Jan 1 — the shared boundary statement is deduped by buildStatementsTable
  expect(body.dateFin).toBe('2022-01-01')
  expect(body.codeRolePartieEntente).toBe('P')
  // signed token is escaped for the BODY form (only + and =, / left raw)
  expect(body.compteListes[0].numeroCompteJetonSigne).toBe('AbC%2BdE/fG%3D')
})

test('buildStatementsTable dedupes the same statement returned by two adjacent year windows', () => {
  // The 2026-05-28 statement comes back twice (e.g. from the 2026 and 2025 boundary scans); uuidReleve
  // is regenerated per call so it differs, but it's the SAME statement and must appear once.
  const dupes = [
    ...parseStatements(RELEVES_LISTE),
    { numeroCompteJeton: '000000A000000000', dateReleve: '2026-05-28', typeReleve: 'Individuel', uuidReleve: 'other' }
  ]
  const result = buildStatementsTable(CARDS, dupes)

  const rows = (result.datasets.find((d) => d.id === 'statements') as unknown as { rows: Record<string, unknown>[] })
    .rows

  expect(rows).toHaveLength(3)
  expect(rows.filter((r) => r.date === '2026-05-28')).toHaveLength(1)
})

test('fetchAllStatements honours ctx.since — stops the back-scan below the watermark year and stamps statementId', async () => {
  const requestedYears: number[] = []
  const client = {
    post: async (_url: string, body: { dateDebut: string }) => {
      const year = Number(body.dateDebut.slice(0, 4))

      requestedYears.push(year)

      // A non-empty result every year keeps the scan going purely off the since-watermark, not the
      // consecutive-empty-years heuristic.
      return {
        sommaireRelevesListe: [
          { numeroCompteJeton: '000000A000000000', dateReleve: `${year}-06-01`, typeReleve: 'Individuel' }
        ]
      }
    }
  }
  const ctx = { client, since: '2024-01-01', log: () => undefined } as unknown as CollectContext

  const statements = await fetchAllStatements(ctx, CARDS)

  expect(Math.min(...requestedYears)).toBe(2024)
  expect(requestedYears).not.toContain(2023)
  expect(statements.every((s) => s.statementId === `${s.numeroCompteJeton}|${s.dateReleve}|${s.typeReleve}`)).toBe(true)
})

test('fetchAllStatements walks every year back to CC_MIN_YEAR when ctx.since is undefined', async () => {
  let calls = 0
  const client = {
    // Empty every year — the scan runs purely off CC_MIN_YEAR / the empty-years heuristic (disabled here by
    // returning empty every time up to a bounded call count, since a real run would stop after 3 empties).
    post: async () => {
      calls++

      return { sommaireRelevesListe: [] }
    }
  }
  const ctx = { client, since: undefined, log: () => undefined } as unknown as CollectContext

  await fetchAllStatements(ctx, CARDS)

  // Stops after CC_MAX_EMPTY_YEARS (3) consecutive empty years, not immediately — proves no since-watermark
  // short-circuited the walk.
  expect(calls).toBe(3)
})

test('buildStatementsTable skips statements whose card (signed token) is unknown', () => {
  const result = buildStatementsTable(
    [],
    [{ numeroCompteJeton: '000000A000000000', dateReleve: '2026-05-28', typeReleve: 'Individuel' }]
  )

  expect((result.datasets.find((d) => d.id === 'statements') as unknown as { rows: unknown[] }).rows).toEqual([])
})
