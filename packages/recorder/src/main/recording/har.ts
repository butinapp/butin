import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RecordedRequest } from './types.js'

// Builds a standard HAR 1.2 archive from a finished run's per-request files, so
// recordings open in Postman / Insomnia / Chrome DevTools and feed generic
// replay tooling. Pure transform — no capture, no network.

interface HarNameValue {
  name: string
  value: string
}

function headersToArray(headers: Record<string, string> | undefined): HarNameValue[] {
  if (!headers) {
    return []
  }

  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}

function queryStringOf(url: string): HarNameValue[] {
  try {
    const u = new URL(url)

    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

function httpVersionOf(protocol: string | undefined): string {
  if (!protocol) {
    return 'HTTP/1.1'
  }

  if (protocol === 'h2') {
    return 'HTTP/2.0'
  }

  if (protocol === 'h3') {
    return 'HTTP/3.0'
  }

  if (protocol.startsWith('http/')) {
    return `HTTP/${protocol.slice(5)}`
  }

  return protocol.toUpperCase()
}

export function toHarEntry(rec: RecordedRequest): object {
  const reqHeaders = rec.request.wireHeaders ?? rec.request.headers
  const respHeaders = rec.response.wireHeaders ?? rec.response.headers
  const durationMs = Math.max(0, Math.round(rec.timing.responseReceivedMs - rec.timing.requestSentMs))

  const postData =
    rec.request.body != null
      ? {
          mimeType: reqHeaders?.['content-type'] ?? reqHeaders?.['Content-Type'] ?? 'application/octet-stream',
          text: rec.request.body
        }
      : undefined

  return {
    startedDateTime: rec.timestamp,
    time: durationMs,
    _resourceType: rec.type,
    _context: rec.context?.kind,
    request: {
      method: rec.request.method,
      url: rec.request.url,
      httpVersion: httpVersionOf(rec.response.protocol),
      headers: headersToArray(reqHeaders),
      queryString: queryStringOf(rec.request.url),
      cookies: (rec.request.cookies ?? []).map((c) => ({ name: c.name, value: c.value })),
      headersSize: -1,
      bodySize: rec.request.body ? Buffer.byteLength(rec.request.body) : 0,
      ...(postData ? { postData } : {})
    },
    response: {
      status: rec.response.status,
      statusText: rec.response.statusText ?? '',
      httpVersion: httpVersionOf(rec.response.protocol),
      headers: headersToArray(respHeaders),
      cookies: [],
      content: {
        size: rec.response.bodyBytes ?? 0,
        mimeType: rec.response.mimeType,
        text: rec.response.body,
        ...(rec.response.base64Encoded ? { encoding: 'base64' } : {})
      },
      redirectURL: respHeaders?.['location'] ?? respHeaders?.['Location'] ?? '',
      headersSize: -1,
      bodySize: rec.response.bodyBytes ?? -1
    },
    cache: {},
    timings: { send: 0, wait: durationMs, receive: 0 }
  }
}

export function buildHarLog(records: RecordedRequest[]): object {
  const entries = records
    .slice()
    .sort((a, b) => a.index - b.index)
    .map(toHarEntry)

  return {
    log: {
      version: '1.2',
      creator: { name: 'Butin Recorder', version: '0.0.0' },
      entries
    }
  }
}

/** Read a run's requests/*.json and write session.har next to them. */
export async function writeHarForRun(runDir: string): Promise<void> {
  const requestsDir = join(runDir, 'requests')

  if (!existsSync(requestsDir)) {
    return
  }

  const files = (await readdir(requestsDir)).filter((f) => f.endsWith('.json'))
  const records: RecordedRequest[] = []

  for (const f of files) {
    try {
      records.push(JSON.parse(await readFile(join(requestsDir, f), 'utf8')))
    } catch {
      // skip unreadable record
    }
  }

  await writeFile(join(runDir, 'session.har'), JSON.stringify(buildHarLog(records), null, 2), 'utf8')
}
