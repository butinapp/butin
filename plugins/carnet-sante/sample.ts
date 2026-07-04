// Synthetic sample GENERATORS for the demo seed — a FABRICATED health record built purely from the seeded
// synthetic toolkit: cast-backed patient + doctors, `@example.invalid` ids, placeholder drugs/exams. Nothing is
// a real person, prescription, or record. `documents` scales each list's length.

import type { SampleConfig, SampleGen, SamplePerson } from '@butinapp/sdk/testing'

import type {
  ProfileRawBundle,
  RawAccessList,
  RawAppointmentList,
  RawImagingList,
  RawLabList,
  RawMedicalServiceList,
  RawMedicationList
} from './main.js'

const CITIZEN_ID = '10000001'

// cast[0] is the patient; cast[1..] are the providers — stable synthetic names across every list.
const doctor = (g: SampleGen, i: number): SamplePerson => g.person(i + 1)

export const sampleCarnetProfile = (g: SampleGen): ProfileRawBundle => {
  const patient = g.person(0)
  const doc = doctor(g, 0)

  return {
    citoyen: {
      IdCitoyen: CITIZEN_ID,
      Nom: patient.lastName.toUpperCase(),
      Prenom: patient.firstName.toUpperCase(),
      Sexe: g.pick(['Femme', 'Homme']),
      DateNaissance: '1985-03-12T00:00:00',
      IndAdmissibiliteCarnetSante: true,
      EstAgeEntre14Et17Ans: false,
      PersonnesACharge: null
    },
    coordonnees: { Adresse: { Ligne1: g.address(), Ligne2: '', Ligne3: '' } },
    carte: { NAM: `${patient.lastName.slice(0, 4).toUpperCase()}85031200`, DateExpirationCarte: '2029-03-31T00:00:00' },
    email: { Adresse: patient.email },
    phone: { Numero: g.phone() },
    medecin: {
      ANomMedecinFamille: doc.lastName.toUpperCase(),
      APrenomMedecinFamille: doc.firstName.toUpperCase(),
      AClinique: `Clinique ${doc.lastName}`
    }
  }
}

export const sampleCarnetMedications = (g: SampleGen, config: SampleConfig): RawMedicationList =>
  g.repeat(Math.min(config.documents, 25), (i) => {
    const doc = doctor(g, i % 4)
    const authorized = g.int(1, 12)

    return {
      Type: 'OrdonnanceAvecService',
      IdOrdonnance: `ORD${String(i + 1).padStart(4, '0')}`,
      Date: g.pastDate(700),
      Duree: g.pick([30, 90, 180, 365]),
      NomPrescripteur: doc.lastName.toUpperCase(),
      PrenomPrescripteur: doc.firstName.toUpperCase(),
      Pharmacie: `Pharmacie ${g.pick(['Centre', 'Nord', 'Est', 'Ouest'])}`,
      NombreDelivrancesAutorisees: authorized,
      NombreDelivrancesRestantes: g.int(0, authorized),
      MedicamentPrescrit: {
        DIN: String(g.int(10_000_000, 99_999_999)),
        Nom: `${g.pick(['PLACEBO', 'EXEMPLE', 'TEMOIN'])} ${g.int(5, 100)}MG ${g.pick(['COMPRIMÉ', 'CAPSULE'])}`,
        LibelleClasse: `Classe exemple ${g.pick(['A', 'B', 'C'])}`,
        Posologies: [{ Description: g.pick(['Prendre 1 comprimé une fois par jour', 'Prendre 1 capsule au coucher']) }]
      },
      DernierService: { Date: g.pastDate(60) }
    }
  })

export const sampleCarnetAppointments = (g: SampleGen, config: SampleConfig): RawAppointmentList =>
  g.repeat(Math.min(config.documents, 36), (i) => {
    const doc = doctor(g, i % 4)

    return {
      Id: `RDV${String(i + 1).padStart(4, '0')}`,
      DateRendezVous: g.pastDate(365),
      NomMedecin: doc.lastName.toUpperCase(),
      PrenomMedecin: doc.firstName.toUpperCase(),
      Clinique: `Clinique ${doc.lastName}`,
      Specialite: g.pick(['Médecine familiale', 'Cardiologie', 'Dermatologie']),
      Statut: g.pick(['Confirmé', 'EnAttente'])
    }
  })

export const sampleCarnetMedicalServices = (g: SampleGen, config: SampleConfig): RawMedicalServiceList =>
  g.repeat(Math.min(config.documents, 20), (i) => {
    const doc = doctor(g, i % 4)

    return {
      DateService: g.pastDate(700),
      DescriptionService: g.pick(['Visite, examen ou consultation', 'Prélèvement sanguin', 'Examen complet']),
      PrecisionService: g.pick(['Médecine familiale', 'Cardiologie']),
      NomProfessionnel: doc.lastName.toUpperCase(),
      PrenomProfessionnel: doc.firstName.toUpperCase(),
      MontantPayeRAMQ: g.money(15, 80),
      LieuPhysique: { Nom: `CLINIQUE ${doc.lastName.toUpperCase()}`, Adresse: g.address() }
    }
  })

export const sampleCarnetLabs = (g: SampleGen, config: SampleConfig): RawLabList => ({
  citizenId: CITIZEN_ID,
  list: g.repeat(Math.min(config.documents, 15), (i) => {
    const doc = doctor(g, i % 4)

    return {
      id: `LAB${String(i + 1).padStart(4, '0')}`,
      datePrelevement: g.dayString(700),
      prenomPrescripteur: doc.firstName.toUpperCase(),
      nomPrescripteur: doc.lastName.toUpperCase(),
      statutRapport: 'Disponible',
      dateDisponibiliteResultatAnalyse: g.dayString(690)
    }
  })
})

export const sampleCarnetImaging = (g: SampleGen, config: SampleConfig): RawImagingList => ({
  citizenId: CITIZEN_ID,
  list: g.repeat(Math.min(config.documents, 36), (i) => {
    const doc = doctor(g, i % 4)

    return {
      DateExamen: g.dayString(700),
      DescriptionExamen: g.pick(['Radiographie thoracique', 'Échographie abdominale', 'IRM cérébrale']),
      NumeroExamen: `IMG${String(i + 1).padStart(4, '0')}`,
      PrenomPrescripteur: doc.firstName.toUpperCase(),
      NomPrescripteur: doc.lastName.toUpperCase(),
      DateDisponibiliteRapport: g.dayString(690)
    }
  })
})

export const sampleCarnetAccess = (g: SampleGen, config: SampleConfig): RawAccessList =>
  g.repeat(Math.min(config.documents, 30), (i) => {
    const doc = doctor(g, i % 4)
    const date = g.dayString(700)

    return {
      idCitoyen: CITIZEN_ID,
      periodeAcces: { dateDebut: `${date}T09:15:00.000000`, dateFin: `${date}T09:30:00.000000` },
      domaines: g.pick([['Medicament', 'Prelevement'], ['Imagerie'], ['Medicament']]),
      intervenant: {
        nom: doc.lastName.toUpperCase(),
        prenom: doc.firstName.toUpperCase(),
        role: 'Médecin',
        roleAnglais: 'Physician',
        id: `prov${String(i + 1).padStart(4, '0')}@example.invalid`
      }
    }
  })
