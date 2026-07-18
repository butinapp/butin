import { describe, expect, it } from 'vitest'

import type { RecordedRequest } from '../main/recording/types.js'

import { classifyDownload, detectDownloads, mergeDownloads } from './downloads.js'
import type { DetectedDownload } from './types.js'

interface Over {
  type?: string
  method?: string
  url?: string
  reqHeaders?: Record<string, string>
  mimeType?: string
  respHeaders?: Record<string, string>
  body?: string
  base64Encoded?: boolean
  bodyBytes?: number
}

const mk = (o: Over = {}): RecordedRequest => ({
  index: 42,
  timestamp: '',
  type: o.type ?? 'XHR',
  request: {
    url: o.url ?? 'https://api.acme.com/thing',
    method: o.method ?? 'GET',
    headers: o.reqHeaders ?? {},
    body: null
  },
  response: {
    status: 200,
    headers: o.respHeaders ?? {},
    body: o.body ?? '',
    base64Encoded: o.base64Encoded ?? false,
    mimeType: o.mimeType ?? 'application/json',
    bodyBytes: o.bodyBytes
  },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

describe('classifyDownload', () => {
  it('returns null for an ordinary JSON response', () => {
    expect(classifyDownload(mk({ body: '{"ok":true}' }))).toBeNull()
  })

  it('classifies a GET application/pdf as direct-url-get', () => {
    const d = classifyDownload(mk({ url: 'https://acme.com/inv/1', mimeType: 'application/pdf', bodyBytes: 9000 }))

    expect(d).toMatchObject({ mechanism: 'direct-url-get', confidence: 'high', origin: 'response' })
    expect(d?.response).toMatchObject({ pdfConfirmed: true, bytes: 9000 })
    expect(d?.request.initiator).toBe('xhr')
    expect(d?.sourceFile).toContain('0042_')
  })

  it('classifies a POST application/pdf as authed-post and captures the Accept header', () => {
    const d = classifyDownload(
      mk({ method: 'POST', mimeType: 'application/pdf', reqHeaders: { Accept: 'application/pdf' } })
    )

    expect(d).toMatchObject({ mechanism: 'authed-post', confidence: 'high' })
    expect(d?.request.accept).toBe('application/pdf')
  })

  it('classifies a Document navigation to a PDF as native-navigation', () => {
    const d = classifyDownload(mk({ type: 'Document', method: 'GET', mimeType: 'application/pdf' }))

    expect(d).toMatchObject({ mechanism: 'native-navigation', confidence: 'high' })
    expect(d?.request.initiator).toBe('navigation')
  })

  it('reads a Content-Disposition attachment (octet-stream) and its filename', () => {
    const d = classifyDownload(
      mk({
        mimeType: 'application/octet-stream',
        respHeaders: { 'content-disposition': 'attachment; filename="releve.pdf"' }
      })
    )

    expect(d?.mechanism).toBe('direct-url-get')
    expect(d?.response.filename).toBe('releve.pdf')
  })

  it('detects a base64 %PDF embedded in a JSON body', () => {
    const d = classifyDownload(mk({ mimeType: 'application/json', body: '{"rapport":"JVBERi0xLjcKJ..."}' }))

    expect(d).toMatchObject({ mechanism: 'base64-in-json', confidence: 'high' })
    expect(d?.response.pdfConfirmed).toBe(true)
  })

  it('flags a JSON body carrying a signed file URL as low-confidence url-in-json', () => {
    const d = classifyDownload(mk({ mimeType: 'application/json', body: '{"file_url":"https://s3/inv.pdf?sig=x"}' }))

    expect(d).toMatchObject({ mechanism: 'url-in-json', confidence: 'low' })
  })

  it('flags a one-time signed URL', () => {
    const d = classifyDownload(
      mk({ url: 'https://s3.acme.com/i.pdf?X-Amz-Signature=abc', mimeType: 'application/pdf' })
    )

    expect(d?.response.looksSigned).toBe(true)
  })

  it('detects a bare .pdf URL as a low-confidence unknown', () => {
    const d = classifyDownload(mk({ url: 'https://acme.com/statements/jan.pdf', mimeType: '' }))

    expect(d).toMatchObject({ mechanism: 'unknown', confidence: 'low' })
  })
})

describe('detectDownloads', () => {
  it('keeps only the downloadable requests', () => {
    const out = detectDownloads([
      mk({ body: '{"ok":true}' }),
      mk({ mimeType: 'application/pdf' }),
      mk({ mimeType: 'text/html', body: '<html></html>' })
    ])

    expect(out).toHaveLength(1)
    expect(out[0].mechanism).toBe('direct-url-get')
  })
})

describe('mergeDownloads', () => {
  const native: DetectedDownload = {
    mechanism: 'native-navigation',
    confidence: 'high',
    origin: 'native',
    request: { url: 'https://acme.com/dl/1', method: 'GET', initiator: 'navigation' },
    response: { filename: 'inv.pdf', pdfConfirmed: true, looksSigned: false },
    sourceFile: null,
    savedAs: 'downloads/0001_inv.pdf'
  }

  it('enriches a native download from its matching captured request and drops the dupe', () => {
    const passive = detectDownloads([
      mk({
        url: 'https://acme.com/dl/1',
        mimeType: 'application/pdf',
        reqHeaders: { referer: 'https://acme.com/bills' }
      })
    ])

    const merged = mergeDownloads(passive, [native])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ origin: 'native', savedAs: 'downloads/0001_inv.pdf' })
    expect(merged[0].request.referer).toBe('https://acme.com/bills')
    expect(merged[0].sourceFile).toContain('0042_')
  })

  it('keeps unmatched passive downloads alongside native ones', () => {
    const passive = detectDownloads([mk({ url: 'https://acme.com/other.pdf', mimeType: 'application/pdf' })])
    const merged = mergeDownloads(passive, [native])

    expect(merged).toHaveLength(2)
  })
})
