import { requestRecordFileName } from '../main/recording/naming.js'
import type { RecordedRequest } from '../main/recording/types.js'

import type { Confidence, DetectedDownload, DownloadMechanism } from './types.js'

// base64 of "%PDF" — the marker a PDF leaves when embedded (base64) inside a JSON body, and the prefix
// a base64-encoded binary response body starts with when it's a PDF.
const PDF_BASE64_PREFIX = 'JVBERi'

const lc = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))

const respHeader = (r: RecordedRequest, name: string): string | undefined =>
  lc({ ...r.response.headers, ...(r.response.wireHeaders ?? {}) })[name]

const reqHeader = (r: RecordedRequest, name: string): string | undefined =>
  lc({ ...r.request.headers, ...(r.request.wireHeaders ?? {}) })[name]

// The download's initiator, read off the CDP resource type: a top-level Document navigation vs a scripted
// XHR/Fetch. A navigation that returns a file is the shape that needs a real browser to replay (ctx.browser).
const initiatorOf = (type: string): DetectedDownload['request']['initiator'] =>
  type === 'Document' ? 'navigation' : type === 'XHR' || type === 'Fetch' ? 'xhr' : 'other'

const filenameFromDisposition = (cd: string | undefined): string | undefined => {
  const m = cd?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)

  return m ? decodeURIComponent(m[1].trim()) : undefined
}

const filenameFromUrl = (url: string): string | undefined => {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).at(-1)

    return last && /\.[a-z0-9]{2,4}$/i.test(last) ? last : undefined
  } catch {
    return undefined
  }
}

// A URL whose query carries an expiry/signature — a one-time link (AWS presign, Stripe file_url, a signed
// statement token) that can't be captured once and replayed later; it must be minted at download time.
const looksSigned = (url: string): boolean => {
  try {
    const keys = [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase())

    return keys.some((k) => /expir|signature|x-amz-|token|sig$|jeton/.test(k))
  } catch {
    return false
  }
}

const bodyHasPdfMagic = (r: RecordedRequest): boolean => {
  const body = r.response.body ?? ''

  return r.response.base64Encoded ? body.startsWith(PDF_BASE64_PREFIX) : body.startsWith('%PDF')
}

// Classify one captured request as a downloadable document, or null if it isn't one. Keys off the response
// signature (mime, Content-Disposition, base64-in-JSON) plus a weak URL heuristic; the mechanism it maps to
// is inferred from the initiator + method so the reader knows which replay shape a plugin needs to reproduce.
export const classifyDownload = (r: RecordedRequest): DetectedDownload | null => {
  const mime = (r.response.mimeType || '').toLowerCase()
  const disposition = respHeader(r, 'content-disposition') ?? ''
  const isJson = mime.includes('application/json')
  const textBody = r.response.base64Encoded ? '' : (r.response.body ?? '')

  const isPdfMime = mime.includes('application/pdf')
  const isOctet = mime.includes('application/octet-stream')
  const isAttachment = /attachment/i.test(disposition)
  const base64InJson = isJson && textBody.includes(PDF_BASE64_PREFIX)
  const urlInJson =
    isJson && !base64InJson && (/"file_url"/i.test(textBody) || /https?:\/\/[^"']+\.pdf/i.test(textBody))
  const urlLooksPdf = /\.pdf(\?|$)/i.test(r.request.url)

  if (!isPdfMime && !isOctet && !isAttachment && !base64InJson && !urlInJson && !urlLooksPdf) {
    return null
  }

  const initiator = initiatorOf(r.type)
  const pdfConfirmed = isPdfMime || base64InJson || bodyHasPdfMagic(r)

  const [mechanism, confidence]: [DownloadMechanism, Confidence] = base64InJson
    ? ['base64-in-json', 'high']
    : isPdfMime || isAttachment
      ? initiator === 'navigation'
        ? ['native-navigation', 'high']
        : r.request.method === 'POST'
          ? ['authed-post', 'high']
          : ['direct-url-get', 'high']
      : isOctet && pdfConfirmed
        ? [r.request.method === 'POST' ? 'authed-post' : 'direct-url-get', 'medium']
        : urlInJson
          ? ['url-in-json', 'low']
          : ['unknown', 'low'] // URL-heuristic only

  return {
    mechanism,
    confidence,
    origin: 'response',
    request: {
      url: r.request.url,
      method: r.request.method,
      accept: reqHeader(r, 'accept'),
      referer: reqHeader(r, 'referer'),
      initiator
    },
    response: {
      mime: r.response.mimeType || undefined,
      filename: filenameFromDisposition(disposition) ?? filenameFromUrl(r.request.url),
      bytes: r.response.bodyBytes,
      pdfConfirmed,
      looksSigned: looksSigned(r.request.url)
    },
    sourceFile: requestRecordFileName(r),
    savedAs: null
  }
}

// Every downloadable document across a run's captured requests. `url-in-json`/`unknown` matches are the fuzzy
// tail — they carry `low` confidence, never fabricated certainty.
export const detectDownloads = (requests: RecordedRequest[]): DetectedDownload[] =>
  requests.map(classifyDownload).filter((d): d is DetectedDownload => d !== null)

// Fold native-navigation downloads (seen via will-download, which carry the saved bytes but no request headers)
// together with the passively-classified response downloads. A native download joins its captured request by URL,
// inheriting its method/accept/referer + response signature; passive matches on the same URL then drop as dupes.
export const mergeDownloads = (passive: DetectedDownload[], native: DetectedDownload[]): DetectedDownload[] => {
  const claimed = new Set<string>()

  const merged = native.map((n) => {
    const match = passive.find((p) => p.request.url === n.request.url)

    if (!match) {
      return n
    }

    claimed.add(match.request.url)

    return {
      ...n,
      request: { ...match.request, initiator: 'navigation' as const },
      response: { ...match.response, ...n.response, filename: n.response.filename ?? match.response.filename },
      sourceFile: match.sourceFile
    }
  })

  return [...merged, ...passive.filter((p) => !claimed.has(p.request.url))]
}
