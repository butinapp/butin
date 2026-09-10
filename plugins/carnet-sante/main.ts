import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { fullName, isoDay } from '@butinapp/sdk/util'

import {
  type CleanAccess,
  type CleanAppointment,
  type CleanMedication,
  type CleanProfile,
  type CleanService,
  normalizeAccess,
  normalizeAppointments,
  normalizeMedicalServices,
  normalizeMedications,
  normalizeProfile,
  type ProfileRaw
} from './normalize.js'
import {
  sampleCarnetAccess,
  sampleCarnetAppointments,
  sampleCarnetImaging,
  sampleCarnetLabs,
  sampleCarnetMedicalServices,
  sampleCarnetMedications,
  sampleCarnetProfile
} from './sample.js'

// --- constants -----------------------------------------------------------------------------------

// Portal SPA the user logs into by hand (ClicSEQUR + MFA), loaded into the embedded site view. Bare host
// (no `www.`); it redirects to the `www.` host once authenticated.
const CARNET_PORTAL_URL = 'https://carnetsante.gouv.qc.ca'

// Authenticated app shell on the `www.` host — where the SPA and its `/api/1` calls live, and the origin the
// offscreen bearer mint boots from. The bare login host 301s to `www.`; a mint started on the bare host reads
// that cross-origin canonicalization hop as a dead-session bounce, so it must start already on `www.`.
const CARNET_APP_URL = 'https://www.carnetsante.gouv.qc.ca/accueil'

// Origin of the authenticated app + its REST API: profile, medications, imaging, appointments, medical
// services — everything except labs. Every /api/1 call lives under the `www.` host.
const CARNET_API_BASE = 'https://www.carnetsante.gouv.qc.ca/api/1'

// RAMQ "passerelle d'autorisation" gateway: labs (Prélèvements) — sample list, per-sample reports (PDF
// inlined as base64). Hosted off the Carnet origin.
const RAMQ_GATEWAY_API_BASE = 'https://ais-passerelle-autorisation-api.ramq.gouv.qc.ca/api/1'

// RAMQ "accès aux renseignements de santé" gateway: the fused-record ACCESS JOURNAL — who consulted the
// citizen's record, when, and which domains they touched.
const RAMQ_FUSED_RECORDS_API_BASE = 'https://ais-acces-renseignements-sante-api.ramq.gouv.qc.ca/api/1'

// webRequest filter for the Bearer-capture interceptor — every host that carries the SPA's JWT.
const AUTH_CAPTURE_URL_PATTERNS = ['https://*.carnetsante.gouv.qc.ca/*', 'https://*.ramq.gouv.qc.ca/*']

// Per-endpoint look-back windows. Each Carnet endpoint 500s past its own date ceiling, so the widest
// single query each accepts is hard-coded here rather than queried in one shot.
const LABS_HISTORY_YEARS = 7
const IMAGING_HISTORY_YEARS = 6
const MEDICATIONS_HISTORY_YEARS = 2
const MEDICAL_SERVICES_HISTORY_YEARS = 7
const ACCESS_HISTORY_YEARS = 7

// base64-encoded `%PDF-` magic bytes — how an inline lab-report PDF announces itself inside the JSON.
const PDF_BASE64_PREFIX = 'JVBERi'

// --- shared helpers ------------------------------------------------------------------------------

// Carnet's date params must be LOCAL, not UTC: toISOString() rolls to the next calendar day after ~20:00
// Eastern, pushing DateFin into the future on RAMQ's clock — the gateway then answers 500. `localDay`
// zero-pads (the access journal rejects an unpadded day); `looseDay` is the unpadded form the other
// endpoints' SPA calls send.
const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const looseDay = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

const yearsAgo = (from: Date, years: number): Date => {
  const d = new Date(from)

  d.setFullYear(d.getFullYear() - years)

  return d
}

// The gov API mixes PascalCase + camelCase across endpoints — read whichever form is present.
const pick = (obj: unknown, ...keys: string[]): string | undefined => {
  if (!obj || typeof obj !== 'object') {
    return undefined
  }

  const o = obj as Record<string, unknown>

  for (const k of keys) {
    if (typeof o[k] === 'string' && o[k]) {
      return o[k] as string
    }
  }

  return undefined
}

// Walks a JSON payload and collects every string that decodes to a PDF — used where the API inlines a
// report as a base64 field rather than exposing it at a URL.
const extractBase64Pdfs = (root: unknown): string[] => {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.length > 100 && node.startsWith(PDF_BASE64_PREFIX)) {
        try {
          if (Buffer.from(node.slice(0, 12), 'base64').toString('ascii').startsWith('%PDF')) {
            found.push(node)
          }
        } catch {
          // Not base64 — skip silently.
        }
      }
    } else if (Array.isArray(node)) {
      for (const v of node) {
        walk(v)
      }
    } else if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node)) {
        walk(v)
      }
    }
  }

  walk(root)

  return found
}

// Discover the connected citizen's id (path param on every per-user endpoint) from the bootstrap call.
// `/api/1/Citoyens` (no suffix) returns the connected-user object; `/api/1/Citoyens/{id}` is NOT fetchable
// on its own — only its sub-resources are.
type RawCitoyen = { IdCitoyen?: string } & Record<string, unknown>

const fetchCitizen = async (ctx: CollectContext): Promise<RawCitoyen> => {
  const me = await ctx.client.get<RawCitoyen>(`${CARNET_API_BASE}/Citoyens`)

  if (!me?.IdCitoyen) {
    throw new Error('could not resolve citizenId from /api/1/Citoyens')
  }

  return me
}

const fetchCitizenId = async (ctx: CollectContext): Promise<string> => (await fetchCitizen(ctx)).IdCitoyen as string

// --- profile -------------------------------------------------------------------------------------

export const buildProfileResult = (p: CleanProfile): CapabilityResult =>
  capabilityResult({
    sections: [
      record<CleanProfile>({
        id: 'profile',
        fields: [
          { key: 'fullName', label: 'Nom', role: 'label' },
          { key: 'birthDate', label: 'Naissance', role: 'timestamp' },
          { key: 'sex', label: 'Sexe', role: 'text' },
          { key: 'cardNumber', label: "No d'assurance maladie", role: 'identifier' },
          { key: 'cardExpires', label: 'Expiration', role: 'timestamp' },
          { key: 'email', label: 'Courriel', role: 'text' },
          { key: 'phone', label: 'Téléphone', role: 'text' },
          { key: 'address', label: 'Adresse', role: 'text' },
          { key: 'familyDoctor', label: 'Médecin de famille', role: 'text' },
          { key: 'familyDoctorStatus', label: 'Situation', role: 'text' }
        ],
        value: p
      }).keyvalue()
    ]
  })

// Typed shape of the /Citoyens bundle a profile fetch returns — a loose superset of what normalizeProfile's
// zod schemas accept, so a sample can be authored against it. The connected-user object is the bare /Citoyens
// call; the rest are best-effort sub-resources.
export type ProfileRawBundle = ProfileRaw & {
  citoyen: RawCitoyen
}

// The connected-user object is the bare /Citoyens call; the rest are best-effort sub-resources (a missing
// one — no card, no email on file — must not blank the whole tab), so each is caught to undefined and the
// normalizer fills the gap.
const fetchProfile = async (ctx: CollectContext): Promise<ProfileRawBundle> => {
  const citoyen = await fetchCitizen(ctx)
  const id = citoyen.IdCitoyen as string
  const sub = (path: string): Promise<unknown> =>
    ctx.client.get<unknown>(`${CARNET_API_BASE}/Citoyens/${id}/${path}`).catch(() => undefined)

  const [coordonnees, carte, email, phone, medecin] = await Promise.all([
    sub('Coordonnees'),
    sub('CarteAssuranceMaladie'),
    sub('DonneesContact/Courriel'),
    sub('DonneesContact/TelephoneMobile'),
    sub('SituationMedecinFamille')
  ])

  return { citoyen, coordonnees, carte, email, phone, medecin }
}

// --- medications ---------------------------------------------------------------------------------

type MedicationRow = {
  prescribedAt: string
  drugName: string
  din: string
  prescriber: string
  pharmacy: string
  refillsRemaining: number | null
  status: string
  klass: string
  id: string
}

// `status` (actif/terminé) is derived from the refill count: a med with refills remaining is active.
export const buildMedicationsResult = (rows: CleanMedication[]): CapabilityResult =>
  capabilityResult({
    sections: [
      table<MedicationRow>({
        id: 'medications',
        columns: [
          { key: 'prescribedAt', label: 'Date', role: 'timestamp' },
          { key: 'drugName', label: 'Médicament', role: 'label' },
          { key: 'din', label: 'DIN', role: 'identifier' },
          { key: 'prescriber', label: 'Prescripteur', role: 'text' },
          { key: 'pharmacy', label: 'Pharmacie', role: 'text' },
          { key: 'refillsRemaining', label: 'Renouvellements', role: 'count' },
          { key: 'status', label: 'Statut', role: 'status', badges: { actif: 'success', terminé: 'neutral' } },
          { key: 'klass', label: 'Classe', role: 'text' },
          { key: 'id', role: 'identifier', hidden: true }
        ],
        rows: rows.map((r) => ({
          prescribedAt: r.prescribedAt,
          drugName: r.drugName,
          din: r.din,
          prescriber: r.prescriber,
          pharmacy: r.pharmacy,
          refillsRemaining: r.refillsRemaining,
          status: (r.refillsRemaining ?? 0) > 0 ? 'actif' : 'terminé',
          klass: r.klass,
          id: r.id
        })),
        // The ordonnance id is the prescription's stable identity, so each accumulates one ledger row.
        key: 'id'
      }).table()
    ]
  })

// The Medications wire payload — an array of ordonnance objects (PascalCase). normalizeMedications parses it
// leniently, so this is a loose record; the sample is authored against it.
export type RawMedicationList = Record<string, unknown>[]

const fetchMedications = async (ctx: CollectContext): Promise<RawMedicationList> => {
  const now = new Date()
  const url = `${CARNET_API_BASE}/Citoyens/${await fetchCitizenId(ctx)}/Medications?DateDebut=${looseDay(yearsAgo(now, MEDICATIONS_HISTORY_YEARS))}&DateFin=${looseDay(now)}`
  const list = await ctx.client.get<unknown>(url)

  return Array.isArray(list) ? (list as RawMedicationList) : []
}

// --- appointments --------------------------------------------------------------------------------

export const buildAppointmentsResult = (rows: CleanAppointment[]): CapabilityResult =>
  capabilityResult({
    sections: [
      table<CleanAppointment>({
        id: 'appointments',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'time', label: 'Heure', role: 'text' },
          { key: 'doctor', label: 'Médecin', role: 'label' },
          { key: 'clinic', label: 'Clinique', role: 'text' },
          { key: 'specialty', label: 'Spécialité', role: 'text' },
          { key: 'status', label: 'Statut', role: 'status' },
          { key: 'id', role: 'identifier', hidden: true }
        ],
        rows,
        // The RendezVous id is the appointment's stable identity, so it accumulates one ledger row.
        key: 'id'
      }).table()
    ]
  })

// The flattened RendezVous wire payload (PascalCase). normalizeAppointments parses it leniently.
export type RawAppointmentList = Record<string, unknown>[]

// RendezVous answers per-year queries; fan out previous/current/next year and flatten.
const fetchAppointments = async (ctx: CollectContext): Promise<RawAppointmentList> => {
  const citizenId = await fetchCitizenId(ctx)
  const currentYear = new Date().getFullYear()
  const responses = await Promise.all(
    [currentYear - 1, currentYear, currentYear + 1].map((year) =>
      ctx.client.get<unknown>(
        `${CARNET_API_BASE}/Citoyens/${citizenId}/RendezVous?DateDebut=${year}-1-1&DateFin=${year}-12-31`
      )
    )
  )

  return responses.flatMap((r) => (Array.isArray(r) ? (r as RawAppointmentList) : []))
}

// --- medical services ----------------------------------------------------------------------------

export const buildMedicalServicesResult = (rows: CleanService[]): CapabilityResult =>
  capabilityResult({
    sections: [
      table<CleanService>({
        id: 'medical-services',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'description', label: 'Service', role: 'label' },
          { key: 'practitioner', label: 'Professionnel', role: 'text' },
          { key: 'amountPaid', label: 'Payé RAMQ', role: 'money' },
          { key: 'facility', label: 'Lieu', role: 'text' },
          { key: 'id', role: 'identifier', hidden: true }
        ],
        rows,
        // The date+index id is always populated and unique, so each service accumulates its own ledger row.
        key: 'id'
      }).table()
    ]
  })

// The ServicesMedicauxAssures wire payload (PascalCase). normalizeMedicalServices parses it leniently.
export type RawMedicalServiceList = Record<string, unknown>[]

const fetchMedicalServices = async (ctx: CollectContext): Promise<RawMedicalServiceList> => {
  const now = new Date()
  const url = `${CARNET_API_BASE}/Citoyens/${await fetchCitizenId(ctx)}/ServicesMedicauxAssures?DateDebut=${looseDay(yearsAgo(now, MEDICAL_SERVICES_HISTORY_YEARS))}&DateFin=${looseDay(now)}`
  const list = await ctx.client.get<unknown>(url)

  return Array.isArray(list) ? (list as RawMedicalServiceList) : []
}

// --- labs (downloadable) -------------------------------------------------------------------------

// The Prelevements LIST (camelCase) → a DOWNLOADABLE table: each row's lab-report PDF is fetched on demand
// (base64-inline via /Rapports) through the capability's fetchFile, named/located by the hidden
// name/itemId/citizenId fields. The analysis values live only in the PDF — the API exposes no structured
// lab data — so the table is the index + the PDFs are the content.
type LabRow = {
  date: string
  prescriber: string
  status: string
  reportAvailable: string
  // Carried for machinery: filename (date-first) + the keys fetchFile needs to pull this row's PDF.
  name: string
  itemId: string
  citizenId: string
}

export const buildLabsResult = (list: Record<string, unknown>[], citizenId: string): CapabilityResult =>
  capabilityResult({
    sections: [
      table<LabRow>({
        id: 'labs',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'prescriber', label: 'Prescripteur', role: 'text' },
          { key: 'status', label: 'Statut', role: 'status' },
          { key: 'reportAvailable', label: 'Rapport', role: 'text' },
          { key: 'name', role: 'label', hidden: true },
          { key: 'itemId', role: 'identifier', hidden: true },
          { key: 'citizenId', role: 'identifier', hidden: true }
        ],
        rows: list.map((it) => {
          const date = isoDay(pick(it, 'datePrelevement')) ?? ''

          return {
            date,
            prescriber: fullName(pick(it, 'prenomPrescripteur'), pick(it, 'nomPrescripteur')),
            status: pick(it, 'statutRapport') ?? '',
            reportAvailable: pick(it, 'dateDisponibiliteResultatAnalyse') ? 'oui' : '—',
            name: `${date}_PRELEVEMENT`.trim(),
            itemId: pick(it, 'id') ?? '',
            citizenId
          }
        }),
        // Keyed by the per-sample id (the same id the incremental fetch unions on) so labs accumulate history.
        key: 'itemId'
        // Bytes come from the capability's fetchFile (base64-inline /Rapports, no direct URL).
      }).fileTable({ name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Prélèvements' })
    ]
  })

// The labs build takes the flattened Prelevements list + the citizenId (carried onto each row for fetchFile),
// so a fetch returns both. normalizeLabs is the table builder itself (buildLabsResult); the list is loose.
export type RawLabList = {
  citizenId: string
  list: Record<string, unknown>[]
}

// Prelevements answers per-year queries (nothing for the current rolling year if the labs are older), so
// fan out one request per calendar year and flatten. Incremental: skip years entirely older than the
// watermark — their labs are already stored (core's kept union retains them). `ctx.since` is undefined on a
// first run / forced full refetch, so every year is fetched then.
const fetchLabs = async (ctx: CollectContext): Promise<RawLabList> => {
  const citizenId = await fetchCitizenId(ctx)
  const currentYear = new Date().getFullYear()
  const minYear = ctx.since ? Number(ctx.since.slice(0, 4)) : undefined
  const years = Array.from({ length: LABS_HISTORY_YEARS }, (_, i) => currentYear - i).filter(
    (y) => minYear === undefined || y >= minYear
  )
  const perYear = await Promise.all(
    years.map((y) =>
      ctx.client.get<unknown>(
        `${RAMQ_GATEWAY_API_BASE}/Prelevement/Citoyens/${citizenId}/Prelevements?DateDebut=${y}-01-01&DateFin=${y}-12-31`
      )
    )
  )

  return { citizenId, list: perYear.flatMap((p) => (Array.isArray(p) ? (p as Record<string, unknown>[]) : [])) }
}

// Lab report PDF: /Rapports inlines the PDF as base64 inside the JSON — decode the first one out.
const fetchLabFile = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  const rapports = await ctx.client.get<unknown>(
    `${RAMQ_GATEWAY_API_BASE}/Prelevement/Citoyens/${String(row.citizenId)}/Prelevements/${String(row.itemId)}/Rapports`
  )
  const pdfs = extractBase64Pdfs(rapports)

  if (pdfs.length === 0) {
    throw new Error('no PDF in lab report')
  }

  return new Uint8Array(Buffer.from(pdfs[0]!, 'base64'))
}

// --- imaging (downloadable) ----------------------------------------------------------------------

// The ExamensImagerie LIST → a DOWNLOADABLE table: each row's imaging-report PDF is fetched on demand
// (DetailRapport → reportId → Rapport) through the capability's fetchFile.
type ImagingRow = {
  date: string
  description: string
  prescriber: string
  reportAvailable: string
  // Carried for machinery: filename + the keys fetchFile needs to pull this row's PDF.
  name: string
  itemId: string
  citizenId: string
}

export const buildImagingResult = (list: Record<string, unknown>[], citizenId: string): CapabilityResult =>
  capabilityResult({
    sections: [
      table<ImagingRow>({
        id: 'imaging',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'description', label: 'Examen', role: 'label' },
          { key: 'prescriber', label: 'Prescripteur', role: 'text' },
          { key: 'reportAvailable', label: 'Rapport', role: 'text' },
          { key: 'name', role: 'label', hidden: true },
          { key: 'itemId', role: 'identifier', hidden: true },
          { key: 'citizenId', role: 'identifier', hidden: true }
        ],
        rows: list.map((it) => {
          const date = isoDay(pick(it, 'DateExamen', 'dateExamen')) ?? ''
          const description = pick(it, 'DescriptionExamen', 'descriptionExamen') ?? 'Examen'

          return {
            date,
            description,
            prescriber: fullName(
              pick(it, 'PrenomPrescripteur', 'prenomPrescripteur'),
              pick(it, 'NomPrescripteur', 'nomPrescripteur')
            ),
            reportAvailable: pick(it, 'DateDisponibiliteRapport', 'dateDisponibiliteRapport') ? 'oui' : '—',
            name: `${date}_${description}`.trim(),
            itemId: pick(it, 'NumeroExamen', 'numeroExamen') ?? '',
            citizenId
          }
        }),
        // Keyed by the exam number so imaging exams accumulate history past the ~6-year fetch window.
        key: 'itemId'
        // Bytes come from the capability's fetchFile (DetailRapport → Rapport, no direct URL).
      }).fileTable({ name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Imagerie' })
    ]
  })

// The imaging build takes the ExamensImagerie list + the citizenId (carried onto each row for fetchFile).
export type RawImagingList = {
  citizenId: string
  list: Record<string, unknown>[]
}

// Imaging endpoint caps the date range at ~6 years (server 500s on wider): DateDebut=(currentYear-6)-1-1.
const fetchImaging = async (ctx: CollectContext): Promise<RawImagingList> => {
  const citizenId = await fetchCitizenId(ctx)
  const now = new Date()
  const url = `${CARNET_API_BASE}/Citoyens/${citizenId}/ExamensImagerie?DateDebut=${now.getFullYear() - IMAGING_HISTORY_YEARS}-1-1&DateFin=${looseDay(now)}`
  const list = await ctx.client.get<unknown>(url)

  return { citizenId, list: Array.isArray(list) ? (list as Record<string, unknown>[]) : [] }
}

// Imaging report PDF: DetailRapport gives the reportId(s); fetch the first report's binary. Falls back to
// a derived report id (`1061642060${examId}0`) when the detail body surfaces no rapports list.
const fetchImagingFile = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  const citizenId = String(row.citizenId)
  const examId = String(row.itemId)
  const detail = await ctx.client.get<unknown>(
    `${CARNET_API_BASE}/Citoyens/${citizenId}/ExamenImagerie/${examId}/DetailRapport`
  )
  const rapports = Array.isArray(detail) ? (detail as unknown[]) : []
  const reportId = pick(rapports[0], 'IdRapport', 'idRapport') ?? `1061642060${examId}0`
  const url = `${CARNET_API_BASE}/Citoyens/${citizenId}/ExamenImagerie/${examId}/DetailRapport/${reportId}/Rapport`

  return new Uint8Array((await ctx.client.request<ArrayBuffer>({ url, responseType: 'arraybuffer' })).data)
}

// --- access journal ------------------------------------------------------------------------------

type AccessRow = {
  date: string
  time: string
  person: string
  role: string
  domains: string
  providerId: string
}

export const buildAccessResult = (rows: CleanAccess[]): CapabilityResult =>
  capabilityResult({
    sections: [
      table<AccessRow>({
        id: 'access-journal',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'time', label: 'Heure', role: 'text' },
          { key: 'person', label: 'Intervenant', role: 'label' },
          { key: 'role', label: 'Rôle', role: 'text' },
          { key: 'domains', label: 'Domaines', role: 'text' },
          { key: 'providerId', label: 'Identifiant', role: 'identifier' }
        ],
        rows: rows.map((r) => ({
          date: r.date,
          time: r.time,
          person: r.person,
          role: r.role,
          domains: r.domains.join(', '),
          providerId: r.providerId
        })),
        // One access event per (day, second, provider) — the journal has no row id, so this stable triple keys
        // the ledger; the domains touched are already folded into the single row that triple identifies.
        key: ['date', 'time', 'providerId']
      }).table()
    ]
  })

// The AccesRenseignementsSanteFusionnes wire payload (camelCase). normalizeAccess parses it leniently.
export type RawAccessList = Record<string, unknown>[]

// AccesRenseignementsSanteFusionnes accepts a wide window in one shot, so a single 7-year look-back covers
// the history. Date params are zero-padded local YYYY-MM-DD.
const fetchAccess = async (ctx: CollectContext): Promise<RawAccessList> => {
  const id = await fetchCitizenId(ctx)
  const end = new Date()
  const url = `${RAMQ_FUSED_RECORDS_API_BASE}/AccesRenseignementsSanteFusionnes/${id}?IdCitoyenConnecte=${id}&DateDebut=${localDay(yearsAgo(end, ACCESS_HISTORY_YEARS))}&DateFin=${localDay(end)}`
  const list = await ctx.client.get<unknown>(url)

  return Array.isArray(list) ? (list as RawAccessList) : []
}

// --- plugin --------------------------------------------------------------------------------------

// This plugin emits FRENCH labels (its canonical language), so it ships an `en` map for the clinical
// vocabulary the app's global dict can't carry. Under a French app the labels pass through; under English
// the renderer resolves them here.
const CARNET_EN: Record<string, string> = {
  Profil: 'Profile',
  Médicaments: 'Medications',
  Médicament: 'Medication',
  'Rendez-vous': 'Appointments',
  Imagerie: 'Imaging',
  Prélèvements: 'Labs',
  Prelevement: 'Labs',
  'Services médicaux': 'Medical services',
  'Dossier complet': 'Full record',
  Documents: 'Documents',
  Domaines: 'Domains',
  Nom: 'Name',
  Identifiant: 'Citizen ID',
  Sexe: 'Sex',
  Naissance: 'Birth date',
  Courriel: 'Email',
  Téléphone: 'Phone',
  Adresse: 'Address',
  'Médecin de famille': 'Family doctor',
  Médecin: 'Doctor',
  DIN: 'DIN',
  Prescripteur: 'Prescriber',
  Pharmacie: 'Pharmacy',
  Classe: 'Class',
  Clinique: 'Clinic',
  Examen: 'Exam',
  Intervenant: 'Provider',
  Professionnel: 'Professional',
  Spécialité: 'Specialty',
  Service: 'Service',
  'Payé RAMQ': 'RAMQ paid',
  Rapport: 'Report',
  Lieu: 'Location',
  Situation: 'Situation',
  Statut: 'Status',
  Rôle: 'Role',
  Date: 'Date',
  Heure: 'Time',
  Expiration: 'Expiration'
}

export const carnetSantePlugin = definePlugin({
  reportingCurrency: 'CAD',
  meta: {
    id: 'carnet-sante',
    name: 'Carnet Santé',
    vendor: 'RAMQ',
    category: 'other',
    // Bleu du drapeau du Québec (le fleurdelisé) — Pantone 293.
    color: '#003DA5',
    description:
      'Your full Carnet Santé Québec health record — profile, meds, labs, imaging, appointments, services, access journal.',
    homepage: 'https://www.quebec.ca/sante/carnet-sante-quebec',
    dashboardUrl: CARNET_PORTAL_URL,
    messages: { en: CARNET_EN }
  },
  session: {
    loginUrl: CARNET_PORTAL_URL,
    dashboardMarkers: ['/accueil'],
    cookieDomains: ['gouv.qc.ca']
  },
  auth: {
    kind: 'spa-bearer',
    bootUrl: CARNET_APP_URL,
    authCaptureUrlPatterns: [...AUTH_CAPTURE_URL_PATTERNS],
    sessionStorageKeyPrefix: 'oidc.user:',
    clearOnStatuses: [401]
  },
  transport: { engine: 'electron' },
  capabilities: [
    defineCapability({
      id: 'profile',
      label: 'Profil',
      fetch: fetchProfile,
      build: (raw) => buildProfileResult(normalizeProfile(raw)),
      sample: sampleCarnetProfile
    }),
    defineCapability({
      id: 'medications',
      label: 'Médicaments',
      fetch: fetchMedications,
      build: (raw) => buildMedicationsResult(normalizeMedications(raw)),
      sample: sampleCarnetMedications
    }),
    defineCapability({
      id: 'appointments',
      label: 'Rendez-vous',
      fetch: fetchAppointments,
      build: (raw) => buildAppointmentsResult(normalizeAppointments(raw)),
      sample: sampleCarnetAppointments
    }),
    defineCapability({
      id: 'medical-services',
      label: 'Services médicaux',
      fetch: fetchMedicalServices,
      build: (raw) => buildMedicalServicesResult(normalizeMedicalServices(raw)),
      sample: sampleCarnetMedicalServices
    }),
    defineCapability({
      id: 'labs',
      label: 'Prélèvements',
      fetch: fetchLabs,
      build: (raw) => buildLabsResult(raw.list, raw.citizenId),
      sample: sampleCarnetLabs,
      fetchFile: fetchLabFile,
      // No `window` — core applies its default trailing horizon, which harmlessly re-checks the current year for
      // late-entered results; a posted lab result itself never changes, so any re-fetched row just dedupes.
      incremental: { listKey: 'list', id: 'id', timestamp: 'datePrelevement' }
    }),
    defineCapability({
      id: 'imaging',
      label: 'Imagerie',
      fetch: fetchImaging,
      build: (raw) => buildImagingResult(raw.list, raw.citizenId),
      sample: sampleCarnetImaging,
      fetchFile: fetchImagingFile
    }),
    defineCapability({
      id: 'access-journal',
      label: "Journal d'accès",
      fetch: fetchAccess,
      build: (raw) => buildAccessResult(normalizeAccess(raw)),
      sample: sampleCarnetAccess
    })
  ],
  probe: async (ctx) => {
    // The /Citoyens bootstrap is the cheapest authed call — it forces the offscreen spa-bearer mint and
    // resolves the citizen id, so a success proves the whole spa-bearer path is live.
    await fetchCitizenId(ctx)
  }
})
