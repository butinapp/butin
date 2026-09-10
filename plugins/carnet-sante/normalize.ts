import { fullName } from '@butinapp/sdk/util'
import { z } from 'zod'

// The wire→clean layer: zod schemas for the gov API's per-domain shapes + the pure normalizers that flatten
// them into the `Clean*` domain types the data-view mappers consume. Lenient by design — the gov endpoints
// scatter nulls and optional blocks, and a single strict field would throw the whole `.parse()` and drop an
// entire list to a raw-JSON fallback.

const isoDate = z.string()

// --- profile -------------------------------------------------------------------------------------

const citoyenSchema = z.object({
  IdCitoyen: z.string(),
  Nom: z.string(),
  Prenom: z.string(),
  Sexe: z.string(),
  DateNaissance: isoDate,
  IndAdmissibiliteCarnetSante: z.boolean(),
  EstAgeEntre14Et17Ans: z.boolean(),
  PersonnesACharge: z.array(z.unknown()).nullable()
})

// Adresse comes back as a {Ligne1,Ligne2,Ligne3} object, or as a flat string alongside separate
// Ville/Province/CodePostal. Accept either.
const adresseObjetSchema = z.object({
  Ligne1: z.string().optional(),
  Ligne2: z.string().optional(),
  Ligne3: z.string().optional()
})

const coordonneesSchema = z.object({
  Adresse: z.union([z.string(), adresseObjetSchema]).optional(),
  Ville: z.string().optional(),
  CodePostal: z.string().optional(),
  Province: z.string().optional()
})

// Fields optional — some citizens have no card on file. The card uses NAM + DateExpirationCarte, or
// Numero + DateExpiration. Accept either.
const carteSchema = z
  .object({
    NAM: z.string().optional(),
    DateExpirationCarte: isoDate.optional(),
    Numero: z.string().optional(),
    DateExpiration: isoDate.optional()
  })
  .passthrough()

const courrielSchema = z.object({ Adresse: z.string(), Confirme: z.boolean().optional() })
const phoneSchema = z.object({ Numero: z.string(), Confirme: z.boolean().optional() })

// Surfaces an enrolment Situation (e.g. 'InscritAuGuichet') instead of a doctor name when none is
// assigned; the A*MedecinFamille name fields carry the assigned-doctor case.
const medecinSchema = z
  .object({
    Situation: z.string().optional(),
    MedecinFamilleAVenir: z.unknown().nullable().optional(),
    ANomMedecinFamille: z.string().optional(),
    APrenomMedecinFamille: z.string().optional(),
    AClinique: z.string().optional()
  })
  .passthrough()

export type ProfileRaw = {
  citoyen: unknown
  coordonnees?: unknown
  carte?: unknown
  email?: unknown
  phone?: unknown
  medecin?: unknown
}

export type CleanProfile = {
  citizenId: string
  fullName: string
  birthDate: string
  sex: string
  cardNumber?: string
  cardExpires?: string
  email?: string
  phone?: string
  address?: string
  familyDoctor?: string
  familyDoctorStatus?: string
}

// Known enrolment situations surfaced when no family doctor is assigned. Unmapped values pass through
// verbatim so a status we haven't seen yet is never silently dropped.
const situationLabels: Record<string, string> = {
  InscritAuGuichet: "Inscrit au guichet d'accès (aucun médecin assigné)"
}

const formatAddress = (coordonnees: z.infer<typeof coordonneesSchema> | undefined): string | undefined => {
  if (!coordonnees) {
    return undefined
  }

  const adresse = coordonnees.Adresse
  const parts =
    adresse && typeof adresse === 'object'
      ? [adresse.Ligne1, adresse.Ligne2, adresse.Ligne3]
      : [adresse, coordonnees.Ville, coordonnees.Province, coordonnees.CodePostal]

  return parts.filter(Boolean).join(', ') || undefined
}

export const normalizeProfile = (raw: ProfileRaw): CleanProfile => {
  const citoyen = citoyenSchema.parse(raw.citoyen)
  const carte = raw.carte ? carteSchema.parse(raw.carte) : undefined
  const email = raw.email ? courrielSchema.parse(raw.email) : undefined
  const phone = raw.phone ? phoneSchema.parse(raw.phone) : undefined
  const coordonnees = raw.coordonnees ? coordonneesSchema.parse(raw.coordonnees) : undefined
  const medecin = raw.medecin ? medecinSchema.parse(raw.medecin) : undefined

  const familyDoctor =
    medecin && (medecin.APrenomMedecinFamille || medecin.ANomMedecinFamille)
      ? `${medecin.APrenomMedecinFamille ?? ''} ${medecin.ANomMedecinFamille ?? ''}`.trim() || undefined
      : undefined
  const familyDoctorStatus =
    !familyDoctor && medecin?.Situation ? (situationLabels[medecin.Situation] ?? medecin.Situation) : undefined

  return {
    citizenId: citoyen.IdCitoyen,
    fullName: `${citoyen.Prenom} ${citoyen.Nom}`,
    birthDate: citoyen.DateNaissance.slice(0, 10),
    sex: citoyen.Sexe,
    cardNumber: carte?.NAM ?? carte?.Numero,
    cardExpires: (carte?.DateExpirationCarte ?? carte?.DateExpiration)?.slice(0, 10),
    email: email?.Adresse,
    phone: phone?.Numero,
    address: formatAddress(coordonnees),
    familyDoctor,
    familyDoctorStatus
  }
}

// --- medications ---------------------------------------------------------------------------------

const posologieSchema = z.object({
  Description: z.string().optional(),
  DIN: z.string().nullable().optional(),
  Nom: z.string().nullable().optional(),
  NomAnglais: z.string().nullable().optional()
})

const medicamentSchema = z.object({
  DIN: z.string().optional(),
  Nom: z.string().optional(),
  NomAnglais: z.string().optional(),
  LibelleClasse: z.string().optional(),
  LibelleClasseAnglais: z.string().optional(),
  Posologies: z.array(posologieSchema).optional()
})

// Compounded medications return null for the délivrance counts; DernierService/Services may be absent.
const ordonnanceSchema = z
  .object({
    Type: z.string().optional(),
    Id: z.string().optional(),
    IdOrdonnance: z.string().optional(),
    Date: isoDate.optional(),
    Duree: z.number().optional(),
    NomPrescripteur: z.string().optional(),
    PrenomPrescripteur: z.string().optional(),
    Pharmacie: z.string().optional(),
    NombreDelivrancesAutorisees: z.number().nullable().optional(),
    NombreDelivrancesRestantes: z.number().nullable().optional(),
    MedicamentPrescrit: medicamentSchema.optional(),
    DernierService: z
      .object({
        Id: z.string().optional(),
        Date: isoDate.optional(),
        Duree: z.number().optional(),
        NomPharmacie: z.string().optional(),
        Medicaments: medicamentSchema.optional()
      })
      .nullable()
      .optional(),
    Services: z.array(z.unknown()).nullable().optional()
  })
  .passthrough()

const medicationsListSchema = z.array(ordonnanceSchema)

export type CleanMedication = {
  id: string
  drugName: string
  din: string
  posology: string
  prescriber: string
  pharmacy: string
  prescribedAt: string
  durationDays: number | null
  refillsAuthorized: number | null
  refillsRemaining: number | null
  lastDispensedAt?: string
  klass: string
}

export const normalizeMedications = (raw: unknown): CleanMedication[] =>
  medicationsListSchema.parse(raw).map((o, i) => {
    const med = o.MedicamentPrescrit

    return {
      id: o.IdOrdonnance ?? o.Id ?? `med-${i + 1}`,
      drugName: med?.Nom ?? '',
      din: med?.DIN ?? '',
      posology: (med?.Posologies ?? [])
        .map((p) => p.Description)
        .filter(Boolean)
        .join(' / '),
      prescriber: fullName(o.PrenomPrescripteur, o.NomPrescripteur),
      pharmacy: o.Pharmacie ?? '',
      prescribedAt: o.Date?.slice(0, 10) ?? '',
      durationDays: o.Duree ?? null,
      refillsAuthorized: o.NombreDelivrancesAutorisees ?? null,
      refillsRemaining: o.NombreDelivrancesRestantes ?? null,
      lastDispensedAt: o.DernierService?.Date?.slice(0, 10),
      klass: med?.LibelleClasse ?? ''
    }
  })

// --- appointments --------------------------------------------------------------------------------

const appointmentSchema = z.object({
  Id: z.string(),
  DateRendezVous: isoDate,
  NomMedecin: z.string(),
  PrenomMedecin: z.string(),
  Clinique: z.string().optional(),
  Specialite: z.string().optional(),
  Statut: z.string().optional()
})

const appointmentsListSchema = z.array(appointmentSchema)

export type CleanAppointment = {
  id: string
  date: string
  time: string
  doctor: string
  clinic?: string
  specialty?: string
  status?: string
}

export const normalizeAppointments = (raw: unknown): CleanAppointment[] =>
  appointmentsListSchema.parse(raw).map((a) => ({
    id: a.Id,
    date: a.DateRendezVous.slice(0, 10),
    time: a.DateRendezVous.slice(11, 16),
    doctor: `${a.PrenomMedecin} ${a.NomMedecin}`,
    clinic: a.Clinique,
    specialty: a.Specialite,
    status: a.Statut
  }))

// --- medical services ----------------------------------------------------------------------------

// The shape has no Id field — id is synthesized from date+index in the normalizer.
const serviceSchema = z.object({
  DateService: isoDate,
  DescriptionService: z.string().optional(),
  DescriptionServiceAnglais: z.string().optional(),
  PrecisionService: z.string().optional(),
  PrecisionServiceAnglais: z.string().optional(),
  NomProfessionnel: z.string().optional(),
  PrenomProfessionnel: z.string().optional(),
  MontantPayeRAMQ: z.number().optional(),
  LieuPhysique: z
    .object({ Nom: z.string().optional(), Adresse: z.string().optional(), CodePostal: z.string().optional() })
    .nullable()
    .optional(),
  LieuGeographique: z.unknown().optional()
})

const servicesListSchema = z.array(serviceSchema)

export type CleanService = {
  id: string
  date: string
  description?: string
  descriptionEn?: string
  precision?: string
  practitioner?: string
  amountPaid?: number
  facility?: string
  address?: string
}

export const normalizeMedicalServices = (raw: unknown): CleanService[] =>
  servicesListSchema.parse(raw).map((s, i) => ({
    id: `${s.DateService.slice(0, 10)}-${i}`,
    date: s.DateService.slice(0, 10),
    description: s.DescriptionService,
    descriptionEn: s.DescriptionServiceAnglais,
    precision: s.PrecisionService,
    practitioner:
      s.PrenomProfessionnel || s.NomProfessionnel
        ? `${s.PrenomProfessionnel ?? ''} ${s.NomProfessionnel ?? ''}`.trim() || undefined
        : undefined,
    amountPaid: s.MontantPayeRAMQ,
    facility: s.LieuPhysique?.Nom,
    address: s.LieuPhysique?.Adresse
  }))

// --- access journal ------------------------------------------------------------------------------

// One entry per time a health-care worker (intervenant) consulted the citizen's fused record. camelCase,
// every field nullable: entries carry e.g. `roleAnglais: null`, so a strict string would reject the whole
// list. Lenient + passthrough keeps partial entries.
const accessIntervenantSchema = z
  .object({
    nom: z.string().nullable().optional(),
    prenom: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    roleAnglais: z.string().nullable().optional(),
    id: z.string().nullable().optional()
  })
  .passthrough()

const accessEntrySchema = z
  .object({
    idCitoyen: z.string().nullable().optional(),
    periodeAcces: z
      .object({ dateDebut: isoDate.nullable().optional(), dateFin: isoDate.nullable().optional() })
      .nullable()
      .optional(),
    domaines: z.array(z.string()).nullable().optional(),
    intervenant: accessIntervenantSchema.nullable().optional()
  })
  .passthrough()

const accessListSchema = z.array(accessEntrySchema)

export type CleanAccess = {
  date: string
  time: string
  person: string
  role: string
  roleEn?: string
  providerId: string
  domains: string[]
}

export const normalizeAccess = (raw: unknown): CleanAccess[] =>
  accessListSchema.parse(raw).map((e) => {
    const debut = e.periodeAcces?.dateDebut ?? ''

    return {
      date: debut.slice(0, 10),
      time: debut.slice(11, 19),
      person: `${e.intervenant?.prenom ?? ''} ${e.intervenant?.nom ?? ''}`.trim(),
      role: e.intervenant?.role ?? '',
      roleEn: e.intervenant?.roleAnglais ?? undefined,
      providerId: e.intervenant?.id ?? '',
      domains: e.domaines ?? []
    }
  })
