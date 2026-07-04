import type { RecordedRequest } from '../main/recording/types.js'

import type { RenderGuess, RenderShape } from './types.js'
import { hostOf } from './url.js'

const shapeOf = (r: RecordedRequest): RenderShape | undefined => {
  const mime = r.response.mimeType.toLowerCase()

  if (r.request.graphqlOperation || /\/graphql\b/.test(r.request.url)) {
    return 'graphql'
  }

  if (/\/api\/trpc\//.test(r.request.url)) {
    return 'trpc'
  }

  if (mime.includes('text/x-component') || r.request.nextAction) {
    return 'rsc-flight'
  }

  if (mime.includes('application/grpc-web')) {
    return 'grpc-web'
  }

  if (mime.includes('text/html')) {
    return 'html-scrape'
  }

  if (mime.includes('application/json')) {
    return 'json'
  }

  return undefined
}

// One render shape per host — the dominant shape its data endpoints use, which is what a plugin's
// collect() has to parse. Documents/assets (no recognizable shape) are ignored.
export const classifyRender = (requests: RecordedRequest[]): RenderGuess[] => {
  const byHost = new Map<string, Map<RenderShape, string[]>>()

  for (const r of requests) {
    const shape = shapeOf(r)

    if (!shape) {
      continue
    }

    const host = hostOf(r.request.url)
    const shapes = byHost.get(host) ?? new Map<RenderShape, string[]>()
    const urls = shapes.get(shape) ?? []

    if (urls.length < 3) {
      urls.push(r.request.url)
    }

    shapes.set(shape, urls)
    byHost.set(host, shapes)
  }

  return [...byHost.entries()].map(([host, shapes]) => {
    const [shape, sampleUrls] = [...shapes.entries()].sort((a, b) => b[1].length - a[1].length)[0]

    return { host, shape, sampleUrls }
  })
}
