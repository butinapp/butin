// Synthetic sample generator for the demo seed — builds a Hydro-Québec portfolio purely from the seeded
// toolkit (no real names, addresses, or account numbers), drawn through the SAME build* the live collector
// uses. Models the real shape: one login spanning two relationships (self + a business relationship), each
// holding accounts with a metered property and a consumption history.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawPortfolio } from './main.js'

const HEAT = ['E', 'G', 'B'] as const
const TARIFFS = ['D', 'D', 'DPC'] as const

export const sampleHydroPortfolio = (g: SampleGen, config: SampleConfig): RawPortfolio => {
  const properties = Math.max(2, Math.min(config.users, 4))
  const periods = Math.max(2, Math.min(config.documents, 6))
  const months = Math.max(3, Math.min(config.documents, 12))
  // The billed-period history is deeper than the on-screen consumption periods (~2 years of bi-monthly bills).
  const billedPeriods = Math.max(4, Math.min(config.documents * 2, 13))

  const self = g.person(0)
  const partner = g.person(1)
  const demandeur = g.seqId('01', 1, 10)
  const titSelf = demandeur
  const titBiz = g.seqId('01', 2, 10)

  const relations = [
    {
      noPartenaireDemandeur: demandeur,
      noPartenaireTitulaire: titSelf,
      nom1Titulaire: self.firstName,
      nom2Titulaire: self.lastName,
      typeRelation: '',
      indEcActif: true
    },
    {
      noPartenaireDemandeur: demandeur,
      noPartenaireTitulaire: titBiz,
      nom1Titulaire: self.name,
      nom2Titulaire: partner.name,
      typeRelation: 'BUR003',
      indEcActif: true
    }
  ]

  const portfolio: RawPortfolio = {
    demandeur,
    relations,
    accounts: [],
    contracts: [],
    billingPeriods: [],
    invoiceDocs: [],
    portraits: []
  }

  for (let i = 0; i < properties; i++) {
    // The last property belongs to the business relationship; the rest to the partner's own accounts.
    const isBiz = i === properties - 1
    const titulaire = isBiz ? titBiz : titSelf
    const relName = isBiz ? `${self.name} / ${partner.name}` : self.name
    const ncc = g.seqId('29', i + 1, 12)
    const noContrat = g.seqId('03', i + 1, 10)
    const address = g.address()
    const montant = g.money(40, 180)
    const balance = g.bool(0.5) ? montant : 0
    const overdue = isBiz ? g.money(0, 20) : 0

    portfolio.accounts.push({
      titulaire,
      relationName: relName,
      compte: {
        noCompteContrat: ncc,
        nomTitulaire: self.lastName,
        prenomTitulaire: self.firstName,
        adresseFacturation: address,
        adresse: address,
        montant,
        solde: balance,
        soldeEnSouffrance: overdue,
        dateEmission: g.dayString(25),
        dateEcheance: g.dayString(-2),
        dateProchaineFacture: g.dayString(-20),
        listeNoContrat: [noContrat],
        indicateurPA: !isBiz,
        libelle: isBiz ? '' : g.company(),
        segmentation: isBiz ? 'AFF' : 'RES'
      }
    })

    portfolio.contracts.push({
      titulaire,
      contrat: {
        noContrat,
        adresseConsommation: address,
        noCompteContrat: ncc,
        noInstallation: g.seqId('04', i + 1, 10),
        noCompteur: g.seqId('G9SJ', i + 1, 7),
        tarifActuel: g.pick(TARIFFS),
        dateDebutContrat: `${g.monthsAgo(g.int(12, 60)).yearMonth}-15T04:00:00.000Z`,
        indicateurMVE: g.bool(0.4)
      }
    })

    const billed = g.repeat(billedPeriods, (k) => {
      const vente = g.money(15, 32)
      const energy = g.money(40, 180)
      const taxes = g.money(5, 30)

      return {
        dateDebut: `${g.monthsAgo(2 * k + 2).yearMonth}-02`,
        dateFin: `${g.monthsAgo(2 * k).yearMonth}-01`,
        totalConso: g.int(400, 2600),
        montantFacture: Number((vente + energy + taxes).toFixed(2)),
        montantVenteFraisAccesReseau: vente,
        montantCreditCPC: g.bool(0.15) ? g.money(1, 8) : 0,
        montantTaxes: taxes,
        montantConsommation: energy
      }
    })

    portfolio.billingPeriods.push({ noContrat, periods: billed })
    // The issued invoices for this account — one per billed period, each a downloadable PDF in the billing table.
    portfolio.invoiceDocs.push({
      noCompteContrat: ncc,
      docs: billed.map((per, k) => ({
        noFacture: g.seqId(`7${i}`, k + 1, 12),
        idFacturePDF: g.seqId(`FDC${i}`, k + 1, 32),
        date: per.dateFin,
        amount: per.montantFacture!,
        demandeur,
        titulaire
      }))
    })

    portfolio.portraits.push({
      titulaire,
      portrait: {
        noContrat,
        adresseLieuConsoPartie1: address,
        adresseLieuConsoPartie2: `${g.pick(['Montréal', 'Québec', 'Laval'])} QC ${g.postal()}`,
        tarifActuel: 'D',
        modeChauffage: g.pick(HEAT),
        listeDonneesConsommationPeriode: g.repeat(periods, (k) => {
          const kwh = g.int(400, 1600)
          const vente = g.money(40, 160)
          const taxes = g.money(5, 24)

          return {
            dateDebutPeriode: `${g.dayString(90 + 60 * k)}T04:00:00.000Z`,
            dateFinPeriode: `${g.dayString(30 + 60 * k)}T04:00:00.000Z`,
            consoTotalPeriode: kwh,
            consoTotalProjetePeriode: kwh + g.int(20, 120),
            montantFacturePeriode: Number((vente + taxes).toFixed(2)),
            moyenneKwhJourPeriode: g.float(6, 30, 1),
            nbJourLecturePeriode: g.int(46, 60)
          }
        }),
        listeDonneesConsommationMensuelles: g.repeat(months, (m) => ({
          dateDebutMois: `${g.monthsAgo(m).yearMonth}-01T00:00:00.000Z`,
          consoTotalMoisDecimal: g.float(200, 900, 2)
        }))
      }
    })
  }

  return portfolio
}
