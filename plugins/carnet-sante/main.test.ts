import type { CollectContext } from '@butinapp/sdk'
import { createSampleGen, resolveSampleConfig, resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, it, test } from 'vitest'

import {
  buildAccessResult,
  buildAppointmentsResult,
  buildImagingResult,
  buildLabsResult,
  buildMedicalServicesResult,
  buildMedicationsResult,
  buildProfileResult,
  carnetSantePlugin
} from './main.js'
import {
  type CleanAccess,
  type CleanMedication,
  type CleanProfile,
  normalizeAccess,
  normalizeAppointments,
  normalizeMedicalServices,
  normalizeMedications,
  normalizeProfile,
  type ProfileRaw
} from './normalize.js'
import { sampleCarnetAccess, sampleCarnetProfile } from './sample.js'

// --- samples -------------------------------------------------------------------------------------

const validateCapabilityResult = resultValidator('CAD')

test('every defined sample is contract-valid', () => {
  expect(validateSamples(carnetSantePlugin)).toEqual([])
})

test('carnet sample is fully synthetic and scales with documents', () => {
  const profile = sampleCarnetProfile(createSampleGen('carnet:t'))

  expect((profile.email as { Adresse: string }).Adresse.endsWith('@example.invalid')).toBe(true)

  const small = sampleCarnetAccess(createSampleGen('carnet:t'), resolveSampleConfig({ documents: 5 }))
  const large = sampleCarnetAccess(createSampleGen('carnet:t'), resolveSampleConfig({ documents: 30 }))

  expect(small.length).toBe(5)
  expect(large.length).toBe(30)
})

// --- descriptor ----------------------------------------------------------------------------------

describe('descriptor', () => {
  it('is a spa-bearer plugin coloured the Quebec flag blue', () => {
    expect(carnetSantePlugin.auth.kind).toBe('spa-bearer')
    expect(carnetSantePlugin.meta.color).toBe('#003DA5')
  })

  it('ships an English map for its French clinical vocabulary', () => {
    const en = carnetSantePlugin.meta.messages?.en

    expect(en?.['Médicaments']).toBe('Medications')
    expect(en?.['Rendez-vous']).toBe('Appointments')
    expect(en?.['Prélèvements']).toBe('Labs')
    expect(en?.['Médecin de famille']).toBe('Family doctor')
  })

  it('labs + imaging carry a fetchFile; there is no separate documents tab', () => {
    const byId = Object.fromEntries(carnetSantePlugin.capabilities.map((c) => [c.id, c]))

    expect(typeof (byId.labs as { fetchFile?: unknown }).fetchFile).toBe('function')
    expect(typeof (byId.imaging as { fetchFile?: unknown }).fetchFile).toBe('function')
    expect(byId.documents).toBeUndefined()
  })
})

// --- profile -------------------------------------------------------------------------------------

const citoyenFixture = {
  IndAdmissibiliteCarnetSante: true,
  PersonnesACharge: null,
  IdCitoyen: '99999',
  Nom: 'DOE',
  Prenom: 'JANE',
  Sexe: 'Femme',
  DateNaissance: '1980-01-01T00:00:00',
  CarteAssuranceMaladie: null,
  FonctionnalitesActives: null,
  EstAgeEntre14Et17Ans: false
}

describe('normalizeProfile', () => {
  it('flattens the real API shape (object Adresse, NAM, Situation) into a CleanProfile', () => {
    const raw: ProfileRaw = {
      citoyen: citoyenFixture,
      coordonnees: { Adresse: { Ligne1: '1-123 rue Example', Ligne2: 'Montréal (Québec) H0H 0H0', Ligne3: '' } },
      carte: {
        NAM: 'DOEJ12345678',
        IndicateurCarteExpiree: false,
        DateExpirationCarte: '2030-12-31T00:00:00',
        StatutPeriodeRenouvellement: 'Non'
      },
      email: { IndicateurVerifie: true, CodeProvenance: 'ClicSequr', Adresse: 'jane.doe@example.invalid' },
      phone: { IndicateurVerifie: true, CodeProvenance: 'NonDefini', Numero: '555-0100' },
      medecin: { Situation: 'InscritAuGuichet', MedecinFamilleAVenir: null }
    }
    const result = normalizeProfile(raw)

    expect(result.citizenId).toBe('99999')
    expect(result.fullName).toBe('JANE DOE')
    expect(result.birthDate).toBe('1980-01-01')
    expect(result.sex).toBe('Femme')
    expect(result.cardNumber).toBe('DOEJ12345678')
    expect(result.cardExpires).toBe('2030-12-31')
    expect(result.email).toBe('jane.doe@example.invalid')
    expect(result.phone).toBe('555-0100')
    expect(result.address).toBe('1-123 rue Example, Montréal (Québec) H0H 0H0')
    // No assigned doctor — only an enrolment situation is surfaced.
    expect(result.familyDoctor).toBeUndefined()
    expect(result.familyDoctorStatus).toBe("Inscrit au guichet d'accès (aucun médecin assigné)")
  })

  it('stays tolerant of the legacy best-guess shape (string Adresse, Numero, named doctor)', () => {
    const result = normalizeProfile({
      citoyen: citoyenFixture,
      coordonnees: { Adresse: '123 Test Street', Ville: 'Montreal', Province: 'QC', CodePostal: 'H0H 0H0' },
      carte: { Numero: 'DOEJ12345678', DateExpiration: '2030-12-31T00:00:00' },
      email: { Adresse: 'jane.doe@example.invalid' },
      phone: { Numero: '555-0100' },
      medecin: { ANomMedecinFamille: 'SMITH', APrenomMedecinFamille: 'JOHN' }
    })

    expect(result.cardNumber).toBe('DOEJ12345678')
    expect(result.cardExpires).toBe('2030-12-31')
    expect(result.address).toBe('123 Test Street, Montreal, QC, H0H 0H0')
    expect(result.familyDoctor).toBe('JOHN SMITH')
    expect(result.familyDoctorStatus).toBeUndefined()
  })

  it('handles missing optional sections without throwing', () => {
    const result = normalizeProfile({ citoyen: citoyenFixture })

    expect(result.citizenId).toBe('99999')
    expect(result.cardNumber).toBeUndefined()
    expect(result.email).toBeUndefined()
    expect(result.familyDoctor).toBeUndefined()
    expect(result.familyDoctorStatus).toBeUndefined()
  })
})

describe('buildProfileResult', () => {
  it('maps a profile to a record dataset + keyvalue view', () => {
    const profile: CleanProfile = { citizenId: 'x', fullName: 'Jean Test', birthDate: '1980-01-01', sex: 'M' }
    const result = buildProfileResult(profile)

    expect(result.datasets[0].shape).toBe('record')
    expect(result.views?.[0]?.type).toBe('keyvalue')
  })

  it('emits no money summary — health records never roll up into a spend/balance band', () => {
    const profile: CleanProfile = { citizenId: 'x', fullName: 'Jean Test', birthDate: '1980-01-01', sex: 'M' }

    expect(buildProfileResult(profile).summaries).toBeUndefined()
    expect(buildMedicationsResult([]).summaries).toBeUndefined()
    expect(buildAccessResult([]).summaries).toBeUndefined()
  })
})

// --- medications ---------------------------------------------------------------------------------

const medicationFixture = (overrides: Record<string, unknown> = {}) => ({
  Type: 'OrdonnanceAvecService',
  Id: 'TEST0001',
  IdOrdonnance: 'TEST0001',
  Date: '2026-04-01T00:00:00-04:00',
  Duree: 365,
  NomPrescripteur: 'SMITH',
  PrenomPrescripteur: 'JOHN',
  Pharmacie: 'TEST PHARMACY',
  NombreDelivrancesAutorisees: 12,
  NombreDelivrancesRestantes: 8,
  MedicamentPrescrit: {
    DIN: '00000001',
    Nom: 'PLACEBO 10MG TABLET',
    NomAnglais: 'PLACEBO 10MG TABLET',
    LibelleClasse: 'Test class',
    LibelleClasseAnglais: 'Test class',
    Posologies: [{ DIN: null, Nom: null, NomAnglais: null, Description: 'Take 1 tablet once daily' }]
  },
  DernierService: {
    Id: 'SVC0001',
    Date: '2026-05-01T00:00:00-04:00',
    Duree: 30,
    NomPharmacie: 'TEST PHARMACY',
    Medicaments: {}
  },
  Services: null,
  ...overrides
})

describe('normalizeMedications', () => {
  it('flattens an OrdonnanceAvecService list into CleanMedication[]', () => {
    const result = normalizeMedications([medicationFixture()])

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('TEST0001')
    expect(result[0]?.drugName).toBe('PLACEBO 10MG TABLET')
    expect(result[0]?.din).toBe('00000001')
    expect(result[0]?.posology).toBe('Take 1 tablet once daily')
    expect(result[0]?.prescriber).toBe('JOHN SMITH')
    expect(result[0]?.refillsRemaining).toBe(8)
    expect(result[0]?.lastDispensedAt).toBe('2026-05-01')
  })

  it('returns [] for an empty array', () => {
    expect(normalizeMedications([])).toEqual([])
  })

  it('keeps a medication that omits DernierService and Services entirely', () => {
    const { DernierService, Services, ...noService } = medicationFixture({ Id: 'NOSVC', IdOrdonnance: 'NOSVC' })

    void DernierService
    void Services
    const result = normalizeMedications([noService])

    expect(result).toHaveLength(1)
    expect(result[0]?.drugName).toBe('PLACEBO 10MG TABLET')
    expect(result[0]?.lastDispensedAt).toBeUndefined()
  })

  it('keeps the whole list when one entry is missing nearly every field', () => {
    const result = normalizeMedications([
      medicationFixture({ Id: 'GOOD', IdOrdonnance: 'GOOD', DernierService: null, Services: null }),
      // Degraded entry: only Type + Id present.
      { Type: 'OrdonnanceSansService', Id: 'BARE' }
    ])

    expect(result).toHaveLength(2)
    expect(result[1]?.id).toBe('BARE')
    expect(result[1]?.drugName).toBe('')
    expect(result[1]?.prescriber).toBe('')
    expect(result[1]?.durationDays).toBeNull()
    expect(result[1]?.refillsRemaining).toBeNull()
  })

  it('throws only when the payload is not a medications array', () => {
    expect(() => normalizeMedications({ not: 'an array' })).toThrow()
  })
})

describe('buildMedicationsResult', () => {
  const med: CleanMedication = {
    id: '1',
    drugName: 'Atorvastatine 20mg',
    din: '00012345',
    posology: '1 co die',
    prescriber: 'Dr A',
    pharmacy: 'PharmaX',
    prescribedAt: '2026-01-02',
    durationDays: 30,
    refillsAuthorized: 3,
    refillsRemaining: 2,
    klass: 'Statines'
  }

  it('maps normalized medications to a table dataset + table view', () => {
    const result = buildMedicationsResult([med])
    const ds = result.datasets[0]

    expect(ds.shape).toBe('table')
    expect(result.views?.[0]?.type).toBe('table')
    expect(ds.shape === 'table' && ds.rows.length).toBe(1)
  })

  it('keys the ledger by the ordonnance id, carried hidden on each row', () => {
    const ds = buildMedicationsResult([med]).datasets[0]

    expect(ds.shape === 'table' && ds.key).toBe('id')
    expect(ds.shape === 'table' && ds.rows[0].id).toBe('1')
  })

  it('derives an actif status from a positive refill count, terminé otherwise', () => {
    const ds = buildMedicationsResult([med, { ...med, refillsRemaining: 0 }]).datasets[0]

    expect(ds.shape === 'table' && ds.rows[0].status).toBe('actif')
    expect(ds.shape === 'table' && ds.rows[1].status).toBe('terminé')
  })

  it('tolerates an empty list', () => {
    const result = buildMedicationsResult([])

    expect(result.datasets[0].shape === 'table' && result.datasets[0].rows).toEqual([])
  })
})

// --- appointments --------------------------------------------------------------------------------

describe('normalizeAppointments', () => {
  it('flattens to CleanAppointment[]', () => {
    const result = normalizeAppointments([
      {
        Id: 'RDV0001',
        DateRendezVous: '2026-06-15T10:00:00-04:00',
        NomMedecin: 'SMITH',
        PrenomMedecin: 'JOHN',
        Clinique: 'Clinique Example',
        Specialite: 'Médecine familiale',
        Statut: 'Confirme'
      },
      {
        Id: 'RDV0002',
        DateRendezVous: '2026-07-20T14:30:00-04:00',
        NomMedecin: 'DOE',
        PrenomMedecin: 'JANE',
        Clinique: 'Clinique Other',
        Specialite: 'Cardiologie',
        Statut: 'EnAttente'
      }
    ])

    expect(result).toHaveLength(2)
    expect(result[0]?.doctor).toBe('JOHN SMITH')
    expect(result[0]?.time).toBe('10:00')
    expect(result[1]?.specialty).toBe('Cardiologie')
  })

  it('handles empty array', () => {
    expect(normalizeAppointments([])).toEqual([])
  })
})

describe('buildAppointmentsResult', () => {
  it('keys the ledger by the RendezVous id, carried hidden on each row', () => {
    const ds = buildAppointmentsResult([{ id: 'RDV0001', date: '2026-06-15', time: '10:00', doctor: 'JOHN SMITH' }])
      .datasets[0]

    expect(ds.shape === 'table' && ds.key).toBe('id')
    expect(ds.shape === 'table' && ds.rows[0].id).toBe('RDV0001')
  })
})

// --- medical services ----------------------------------------------------------------------------

describe('normalizeMedicalServices', () => {
  it('flattens to CleanService[]', () => {
    const result = normalizeMedicalServices([
      {
        NomProfessionnel: 'TREMBLAY',
        PrenomProfessionnel: 'MARIE',
        MontantPayeRAMQ: 46.6,
        DateService: '2099-01-15T00:00:00',
        DescriptionService: 'Visite, examen ou consultation',
        DescriptionServiceAnglais: 'Visit, examination or consultation',
        PrecisionService: 'Médecine familiale',
        LieuGeographique: null,
        LieuPhysique: { Nom: 'CLINIQUE EXEMPLE (TEST)', Adresse: '123 RUE EXEMPLE, QUEBEC, QC', CodePostal: 'H0H0H0' }
      }
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('2099-01-15-0')
    expect(result[0]?.date).toBe('2099-01-15')
    expect(result[0]?.facility).toBe('CLINIQUE EXEMPLE (TEST)')
    expect(result[0]?.practitioner).toBe('MARIE TREMBLAY')
    expect(result[0]?.amountPaid).toBe(46.6)
    expect(result[0]?.description).toBe('Visite, examen ou consultation')
  })

  it('handles empty array', () => {
    expect(normalizeMedicalServices([])).toEqual([])
  })
})

describe('buildMedicalServicesResult', () => {
  it('keys the ledger by the date+index id, carried hidden on each row', () => {
    const ds = buildMedicalServicesResult([{ id: '2026-01-02-0', date: '2026-01-02', description: 'Visite' }])
      .datasets[0]

    expect(ds.shape === 'table' && ds.key).toBe('id')
    expect(ds.shape === 'table' && ds.rows[0].id).toBe('2026-01-02-0')
  })
})

// --- labs + imaging (downloadable) ---------------------------------------------------------------

describe('downloadable labs + imaging tables', () => {
  it('imaging rows are downloadable: a files view + hidden name/itemId/citizenId per row', () => {
    const result = buildImagingResult(
      [
        {
          DateExamen: '2024-11-13',
          DescriptionExamen: 'Clavicule G',
          NumeroExamen: 'EX1',
          PrenomPrescripteur: 'A',
          NomPrescripteur: 'B'
        }
      ],
      'cit-9'
    )
    const view = result.views?.find((v) => v.type === 'table')
    const ds = result.datasets[0]

    expect(view && 'files' in view && view.files).toMatchObject({
      ext: 'pdf',
      name: 'name',
      source: { fetch: true },
      category: 'Imagerie'
    })
    expect(ds.shape === 'table' && ds.rows[0]).toMatchObject({
      name: '2024-11-13_Clavicule G',
      itemId: 'EX1',
      citizenId: 'cit-9'
    })
    expect(ds.shape === 'table' && ds.key).toBe('itemId')
  })

  it('labs rows are downloadable: a files view + hidden name/itemId/citizenId per row', () => {
    const result = buildLabsResult([{ datePrelevement: '2024-05-30', id: 'LAB1' }], 'cit-9')
    const view = result.views?.find((v) => v.type === 'table')
    const ds = result.datasets[0]

    expect(view && 'files' in view && view.files).toMatchObject({
      ext: 'pdf',
      name: 'name',
      source: { fetch: true },
      category: 'Prélèvements'
    })
    expect(ds.shape === 'table' && ds.rows[0]).toMatchObject({
      name: '2024-05-30_PRELEVEMENT',
      itemId: 'LAB1',
      citizenId: 'cit-9'
    })
    expect(ds.shape === 'table' && ds.key).toBe('itemId')
  })
})

describe('labs incremental fetch', () => {
  const citizenFixture = { IdCitoyen: '99999' }

  // Every RAMQ Prelevements URL carries `.../Prelevements?DateDebut=<year>-01-01&...` — pull the year back out
  // to assert which calendar years were actually requested.
  const yearOf = (url: string): number => Number(url.match(/DateDebut=(\d{4})-01-01/)?.[1])

  const labsCapability = () => carnetSantePlugin.capabilities.find((c) => c.id === 'labs')!

  it('declares the incremental spec keyed by the raw item id + datePrelevement', () => {
    expect(labsCapability().incremental).toMatchObject({ listKey: 'list', id: 'id', timestamp: 'datePrelevement' })
  })

  it('fans out only years at/after ctx.since, leaving earlier years already-stored', async () => {
    const requestedUrls: string[] = []
    const client = {
      get: async (url: string) => {
        requestedUrls.push(url)

        return url.includes('/Citoyens') ? citizenFixture : []
      }
    }
    const ctx = { client, since: '2024-06-01', log: () => undefined } as unknown as CollectContext

    await labsCapability().incremental!.fetch(ctx)

    const years = requestedUrls.filter((u) => u.includes('/Prelevements?')).map(yearOf)
    const currentYear = new Date().getFullYear()

    expect(Math.min(...years)).toBe(2024)
    expect(years).not.toContain(2023)
    expect(years).toHaveLength(currentYear - 2024 + 1)
  })

  it('fetches every LABS_HISTORY_YEARS year when ctx.since is undefined (first run / forced refetch)', async () => {
    const requestedUrls: string[] = []
    const client = {
      get: async (url: string) => {
        requestedUrls.push(url)

        return url.includes('/Citoyens') ? citizenFixture : []
      }
    }
    const ctx = { client, since: undefined, log: () => undefined } as unknown as CollectContext

    await labsCapability().incremental!.fetch(ctx)

    expect(requestedUrls.filter((u) => u.includes('/Prelevements?'))).toHaveLength(7)
  })
})

// --- access journal ------------------------------------------------------------------------------

describe('normalizeAccess', () => {
  it('maps each access-log entry to CleanAccess', () => {
    const result = normalizeAccess([
      {
        idCitoyen: '99999',
        periodeAcces: { dateDebut: '2099-03-10T09:15:00.000000', dateFin: '2099-03-10T09:15:03.000000' },
        domaines: ['Medicament'],
        intervenant: {
          nom: 'TEST-NOM',
          prenom: 'Alpha',
          role: 'Médecin',
          roleAnglais: 'Physician',
          id: 'alte0001@TEST.EXAMPLE'
        }
      },
      {
        idCitoyen: '99999',
        periodeAcces: { dateDebut: '2099-07-22T14:00:00.000000', dateFin: '2099-07-22T14:00:00.000000' },
        domaines: ['Medicament', 'Prelevement', 'Imagerie'],
        intervenant: { nom: 'TEST-NOM', prenom: 'Alpha', role: 'Médecin', roleAnglais: 'Physician', id: 'x@TEST' }
      }
    ])

    expect(result).toHaveLength(2)
    expect(result[0]?.date).toBe('2099-03-10')
    expect(result[0]?.time).toBe('09:15:00')
    expect(result[0]?.person).toBe('Alpha TEST-NOM')
    expect(result[0]?.role).toBe('Médecin')
    expect(result[0]?.roleEn).toBe('Physician')
    expect(result[0]?.providerId).toBe('alte0001@TEST.EXAMPLE')
    expect(result[0]?.domains).toEqual(['Medicament'])
    expect(result[1]?.domains).toEqual(['Medicament', 'Prelevement', 'Imagerie'])
  })

  it('handles empty array', () => {
    expect(normalizeAccess([])).toEqual([])
  })

  it('tolerates a missing access period and missing domaines', () => {
    const result = normalizeAccess([{ intervenant: { nom: 'X', prenom: 'Y', role: 'Médecin' } }])

    expect(result).toHaveLength(1)
    expect(result[0]?.date).toBe('')
    expect(result[0]?.time).toBe('')
    expect(result[0]?.domains).toEqual([])
  })

  it('tolerates a null roleAnglais (seen on real entries)', () => {
    const result = normalizeAccess([
      {
        periodeAcces: { dateDebut: '2099-01-01T08:00:00.000000', dateFin: '2099-01-01T08:00:00.000000' },
        domaines: ['Medicament'],
        intervenant: { nom: 'X', prenom: 'Y', role: 'Médecin', roleAnglais: null, id: 'xy@TEST' }
      }
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.roleEn).toBeUndefined()
    expect(result[0]?.role).toBe('Médecin')
  })
})

describe('buildAccessResult', () => {
  it('joins the domains array into a single text cell', () => {
    const entry: CleanAccess = {
      date: '2026-01-02',
      time: '09:00:00',
      person: 'Marie TREMBLAY',
      role: 'Médecin',
      providerId: 'abc@PROD',
      domains: ['Imagerie', 'Prelevement']
    }
    const ds = buildAccessResult([entry]).datasets[0]

    expect(ds.shape === 'table' && ds.rows[0].domains).toBe('Imagerie, Prelevement')
  })

  it('keys the ledger by the (date, time, provider) event triple — the journal has no row id', () => {
    const ds = buildAccessResult([]).datasets[0]

    expect(ds.shape === 'table' && ds.key).toEqual(['date', 'time', 'providerId'])
  })
})
