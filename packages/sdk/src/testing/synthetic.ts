// Seeded, zero-dependency synthetic data for the demo seed + sample contract tests. A plugin's `sample`
// generator builds its raw payload ONLY from this toolkit, so the demo can never carry a real name, email,
// address, or account number — there is no literal to paste one into. Deterministic (no Math.random/Date.now):
// a constant reference instant + a per-call seeded PRNG → byte-identical re-runs.

import { MS_PER_DAY } from '../util/date.js'

export interface SamplePerson {
  id: string
  firstName: string
  lastName: string
  name: string
  email: string
}

export interface SampleConfig {
  users: number
  documents: number
  days: number
  window: number
}

export type SampleSize = 'small' | 'medium' | 'large' | 'xlarge'

// A single random day (within a look-back) read every way a wire payload asks for it — so a sample that needs
// both the date string and its epoch reads ONE day, never two diverging draws.
export interface SampleDay {
  date: string // 'YYYY-MM-DD'
  iso: string // midnight UTC, 'YYYY-MM-DDT00:00:00.000Z'
  epochMs: number // midnight UTC, ms
  epochSec: number // midnight UTC, seconds
  yearMonth: string // 'YYYY-MM'
}

// A calendar month a fixed count back from the reference month — deterministic (no random), for monthly ledgers.
export interface SampleMonth {
  yearMonth: string // 'YYYY-MM'
  ym: string // 'YYYYMM'
  startEpochMs: number // first of the month, midnight UTC, ms
  startEpochSec: number // first of the month, midnight UTC, seconds
  label: string // 'June 2026'
}

export interface SampleGen {
  // person(i) is the i-th member of a fixed shared cast (stable across every plugin → a coherent Overview);
  // person() with no index fabricates a one-off person from the local seed.
  person: (i?: number) => SamplePerson
  people: (n: number) => SamplePerson[]
  company: () => string
  orgSlug: () => string
  id: (prefix?: string) => string
  int: (min: number, max: number) => number
  float: (min: number, max: number, decimals?: number) => number
  bool: (p?: number) => boolean
  pick: <T>(items: readonly T[]) => T
  maybe: <T>(value: T, p?: number) => T | undefined
  money: (min: number, max: number) => number
  amountCents: (min: number, max: number) => number
  pastDate: (maxDaysAgo: number) => string
  dayString: (maxDaysAgo: number) => string
  words: (n: number) => string
  sentence: () => string
  maskedKey: () => string
  last4: () => string
  phone: () => string
  postal: () => string
  address: () => string
  // dates — UTC-anchored, no Date.now: a random day within a look-back (read as string/iso/epoch), or a fixed
  // month back from the reference. Prefer `day()` when one record needs the date AND its epoch.
  day: (maxDaysAgo: number) => SampleDay
  midnightIso: (maxDaysAgo: number) => string
  pastEpochMs: (maxDaysAgo: number) => number
  pastEpochSec: (maxDaysAgo: number) => number
  monthsAgo: (n: number) => SampleMonth
  // a synthetic URL on the reserved demo host — `url('invoices', id)` → https://example.invalid/invoices/<id>
  url: (segment: string, id?: string | number) => string
  // money as a fixed-decimal STRING (the form many wires send), e.g. '57.49'
  moneyStr: (min: number, max: number, decimals?: number) => string
  // a zero-padded sequential id, e.g. seqId('INV', i + 1) → 'INV0007'
  seqId: (prefix: string, n: number, width?: number) => string
  repeat: <T>(n: number, fn: (i: number, g: SampleGen) => T) => T[]
}

export type SampleGenerator<TRaw> = (g: SampleGen, config: SampleConfig) => TRaw

// xfnv1a → mulberry32: the same tiny PRNG core's seed uses, kept private here (the SDK can't import core).
const hashSeed = (s: string): number => {
  let h = 2166136261 >>> 0

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }

  return h >>> 0
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST_NAMES = [
  'Liam',
  'Emma',
  'Owen',
  'Chloe',
  'Connor',
  'Hannah',
  'Ethan',
  'Olivia',
  'Nathan',
  'Sophie',
  'Lucas',
  'Grace',
  'Ryan',
  'Megan',
  'Aiden',
  'Ella'
] as const
const LAST_NAMES = [
  'MacDonald',
  'Brennan',
  'Murphy',
  'Walsh',
  'Kelly',
  'Campbell',
  'Thompson',
  'Clarke',
  'Sullivan',
  'Fitzgerald',
  'Cohen',
  'Goldberg',
  'Russo',
  'Bianchi',
  'Pappas',
  'Ryan'
] as const
const COMPANY_A = ['Northwind', 'Globex', 'Initech', 'Umbrella', 'Acme', 'Hooli', 'Vandelay', 'Soylent'] as const
const COMPANY_B = ['Systems', 'Labs', 'Industries', 'Group', 'Cloud', 'Works'] as const
const SLUGS = ['acme', 'northwind', 'globex', 'initech', 'umbrella', 'hooli', 'vandelay'] as const
const LOREM = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'veniam',
  'nostrud',
  'aliquip',
  'commodo',
  'dataset',
  'metric',
  'report',
  'usage',
  'invoice',
  'service'
] as const
const STREETS = ['Maple', 'Cedar', 'Oak', 'Exemple', 'River', 'Hill', 'Birch', 'Pine'] as const
const CITIES = ['Montréal', 'Québec', 'Laval', 'Gatineau', 'Sherbrooke'] as const
// Canada Post's valid letter set (excludes D F I O Q U / W Z). Postals are RANDOMIZED per call, never a fixed
// pool — a constant code would be a real FSA tied to a real neighbourhood.
const POSTAL_LETTERS = [
  'A',
  'B',
  'C',
  'E',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
  'R',
  'S',
  'T',
  'V',
  'X',
  'Y'
] as const
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const

// A fixed-size cast built once from a CONSTANT root seed — identical across every plugin + every run, so the
// same fabricated person recurs across services. Index emails to guarantee uniqueness; all `@example.invalid`.
const CAST_SIZE = 64
let castMemo: SamplePerson[] | undefined

const buildCast = (): SamplePerson[] => {
  if (castMemo) {
    return castMemo
  }

  const r = mulberry32(hashSeed('butin-sample-cast'))

  castMemo = Array.from({ length: CAST_SIZE }, (_, i) => {
    const firstName = FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]!
    const lastName = LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]!

    return {
      id: `usr_${String(i + 1).padStart(4, '0')}`,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email: `${firstName}.${lastName}.${i}@example.invalid`.toLowerCase()
    }
  })

  return castMemo
}

// A deterministic unique person for an index beyond the shared cast — lets a large roster (xlarge) hold more
// than CAST_SIZE distinct members without repeating. Indices < CAST_SIZE stay the stable shared cast.
const personBeyondCast = (i: number): SamplePerson => {
  const firstName = FIRST_NAMES[i % FIRST_NAMES.length]!
  const lastName = LAST_NAMES[(Math.floor(i / FIRST_NAMES.length) + i) % LAST_NAMES.length]!

  return {
    id: `usr_${String(i + 1).padStart(4, '0')}`,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email: `${firstName}.${lastName}.${i}@example.invalid`.toLowerCase()
  }
}

// A fixed instant the relative dates are measured from — never Date.now (which would break reproducibility).
const REFERENCE_MS = Date.UTC(2026, 5, 17, 12, 0, 0)
const MIDNIGHT_REF_MS = Date.UTC(2026, 5, 17, 0, 0, 0) // midnight of the reference day, for epoch/day helpers
const REF_YEAR = 2026
const REF_MONTH0 = 5 // June (0-based), the reference month for monthsAgo

export const createSampleGen = (seed: string): SampleGen => {
  const rng = mulberry32(hashSeed(seed))
  const cast = buildCast()

  const int = (min: number, max: number): number => Math.floor(min + rng() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
  const last4 = (): string => String(int(1000, 9999))
  const pastDate = (maxDaysAgo: number): string =>
    new Date(REFERENCE_MS - int(0, Math.max(0, maxDaysAgo)) * MS_PER_DAY).toISOString()
  const dayMs = (maxDaysAgo: number): number => MIDNIGHT_REF_MS - int(0, Math.max(0, maxDaysAgo)) * MS_PER_DAY
  const day = (maxDaysAgo: number): SampleDay => {
    const ms = dayMs(maxDaysAgo)
    const iso = new Date(ms).toISOString()

    return { date: iso.slice(0, 10), iso, epochMs: ms, epochSec: Math.floor(ms / 1000), yearMonth: iso.slice(0, 7) }
  }
  const onePerson = (): SamplePerson => {
    const firstName = pick(FIRST_NAMES)
    const lastName = pick(LAST_NAMES)

    return {
      id: `usr_${Math.floor(rng() * 0xffffffff).toString(36)}`,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email: `${firstName}.${lastName}.${int(100, 999)}@example.invalid`.toLowerCase()
    }
  }

  const gen: SampleGen = {
    person: (i?: number) => (i === undefined ? onePerson() : cast[((i % CAST_SIZE) + CAST_SIZE) % CAST_SIZE]!),
    people: (n: number) =>
      Array.from({ length: Math.max(0, n) }, (_, i) => (i < CAST_SIZE ? cast[i]! : personBeyondCast(i))),
    company: () => `${pick(COMPANY_A)} ${pick(COMPANY_B)}`,
    orgSlug: () => pick(SLUGS),
    id: (prefix = 'id') => `${prefix}_${Math.floor(rng() * 0xffffffff).toString(36)}`,
    int,
    float: (min: number, max: number, decimals = 2) => {
      const p = 10 ** decimals

      return Math.round((min + rng() * (max - min)) * p) / p
    },
    bool: (p = 0.5) => rng() < p,
    pick,
    maybe: <T>(value: T, p = 0.5): T | undefined => (rng() < p ? value : undefined),
    money: (min: number, max: number) => Math.round((min + rng() * (max - min)) * 100) / 100,
    amountCents: (min: number, max: number) => Math.floor(min + rng() * (max - min)),
    pastDate,
    dayString: (maxDaysAgo: number) => pastDate(maxDaysAgo).slice(0, 10),
    words: (n: number) => Array.from({ length: Math.max(0, n) }, () => pick(LOREM)).join(' '),
    sentence: () => {
      const w = Array.from({ length: int(4, 9) }, () => pick(LOREM))

      return `${w[0]!.charAt(0).toUpperCase()}${w[0]!.slice(1)} ${w.slice(1).join(' ')}.`
    },
    maskedKey: () => `…${last4()}`,
    last4,
    phone: () => `555-01${int(10, 99)}`,
    postal: () =>
      `${pick(POSTAL_LETTERS)}${int(0, 9)}${pick(POSTAL_LETTERS)} ${int(0, 9)}${pick(POSTAL_LETTERS)}${int(0, 9)}`,
    address: () => `${int(1, 9999)} rue ${pick(STREETS)}, ${pick(CITIES)} (Québec) ${gen.postal()}`,
    day,
    midnightIso: (maxDaysAgo) => day(maxDaysAgo).iso,
    pastEpochMs: (maxDaysAgo) => dayMs(maxDaysAgo),
    pastEpochSec: (maxDaysAgo) => Math.floor(dayMs(maxDaysAgo) / 1000),
    monthsAgo: (n) => {
      const total = REF_YEAR * 12 + REF_MONTH0 - n
      const y = Math.floor(total / 12)
      const m0 = ((total % 12) + 12) % 12
      const startEpochMs = Date.UTC(y, m0, 1, 0, 0, 0)
      const mm = String(m0 + 1).padStart(2, '0')

      return {
        yearMonth: `${y}-${mm}`,
        ym: `${y}${mm}`,
        startEpochMs,
        startEpochSec: Math.floor(startEpochMs / 1000),
        label: `${MONTH_NAMES[m0]} ${y}`
      }
    },
    url: (segment, id) => `https://example.invalid/${segment}${id === undefined ? '' : `/${id}`}`,
    moneyStr: (min, max, decimals = 2) => (min + rng() * (max - min)).toFixed(decimals),
    seqId: (prefix, n, width = 4) => `${prefix}${String(n).padStart(width, '0')}`,
    repeat: <T>(n: number, fn: (i: number, g: SampleGen) => T): T[] =>
      Array.from({ length: Math.max(0, n) }, (_, i) => fn(i, gen))
  }

  return gen
}

const SAMPLE_PRESETS: Record<SampleSize, SampleConfig> = {
  small: { users: 3, documents: 5, days: 14, window: 60 },
  medium: { users: 12, documents: 20, days: 30, window: 180 },
  large: { users: 40, documents: 60, days: 120, window: 365 },
  xlarge: { users: 400, documents: 130, days: 250, window: 365 }
}

// Preset (default medium) then apply only the explicitly-provided knobs. medium === today's seed defaults.
export const resolveSampleConfig = (input?: Partial<SampleConfig> & { size?: SampleSize }): SampleConfig => {
  const base = SAMPLE_PRESETS[input?.size ?? 'medium']

  return {
    users: input?.users ?? base.users,
    documents: input?.documents ?? base.documents,
    days: input?.days ?? base.days,
    window: input?.window ?? base.window
  }
}
