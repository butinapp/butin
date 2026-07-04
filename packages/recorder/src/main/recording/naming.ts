// Filesystem-safe naming for run directories and per-request/per-WebSocket
// files: run ids, request files, websocket files, and screenshots.

const MAX_SLUG_LEN = 120
const MAX_LABEL_SLUG_LEN = 60

function slugify(input: string, max: number): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
}

export function requestFileName(index: number, method: string, url: string, extra?: string): string {
  const idx = String(index).padStart(4, '0')
  let host = 'unknown'
  let pathSlug = 'root'

  try {
    const parsed = new URL(url)

    host = parsed.host || 'unknown'
    const raw = `${parsed.pathname}${parsed.search}`

    pathSlug = slugify(raw, MAX_SLUG_LEN) || 'root'
  } catch {
    // unparseable url - keep defaults
  }

  // e.g. a GraphQL operation name — disambiguates many calls to one URL.
  const suffix = extra ? `_${slugify(extra, 40)}` : ''

  return `${idx}_${method}_${host}_${pathSlug}${suffix}.json`
}

export function wsFileName(index: number, url: string): string {
  const idx = String(index).padStart(4, '0')
  let host = 'unknown'
  let pathSlug = 'ws'

  try {
    const parsed = new URL(url)

    host = parsed.host || 'unknown'
    pathSlug = slugify(`${parsed.pathname}${parsed.search}`, MAX_SLUG_LEN) || 'ws'
  } catch {
    // unparseable url - keep defaults
  }

  return `${idx}_${host}_${pathSlug}.json`
}

export function screenshotFileName(index: number, url: string): string {
  const idx = String(index).padStart(4, '0')
  let slug = 'page'

  try {
    const u = new URL(url)

    slug = slugify(`${u.host}${u.pathname}`, 60) || 'page'
  } catch {
    // ignore
  }

  return `${idx}_${slug}.png`
}

export function runIdSlug(label: string): string {
  return slugify(label, MAX_LABEL_SLUG_LEN) || 'recording'
}

/** A human label derived from a URL's host (used when no label is given). */
export function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'recording'
  } catch {
    return 'recording'
  }
}

/** The "YYYY-MM-DD_HHhMM" timestamp prefix of a runId (everything but the slug). */
export function runIdPrefix(runId: string): string {
  const parts = runId.split('_')

  return parts.length >= 2 ? `${parts[0]}_${parts[1]}` : runId
}

export function formatRunId(date: Date, label: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const timePart = `${pad(date.getHours())}h${pad(date.getMinutes())}`

  return `${datePart}_${timePart}_${runIdSlug(label)}`
}
