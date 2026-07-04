import type { AuthKind } from '@butinapp/sdk'

import { classifyAuth } from './auth.js'
import { detectClearBeforeCapture } from './cookies.js'
import { classifyEndpoints } from './endpoints.js'
import { detectLoginMode } from './login.js'
import { classifyRender } from './render.js'
import { classifyTransport } from './transport.js'
import type { DomainProfile, EndpointHint, Guess, RenderGuess, RunData, RunProfile } from './types.js'

export const profileRun = (run: RunData): RunProfile => ({
  transport: classifyTransport(run.requests),
  auth: classifyAuth(run.requests),
  render: classifyRender(run.requests),
  login: detectLoginMode(run),
  endpoints: classifyEndpoints(run.requests),
  clearBeforeCapture: detectClearBeforeCapture(run)
})

// Union the per-run cookie suggestions across a surface — more recordings surface more of the auth handshake,
// so the flagged set only grows. Empty when no run flagged anything.
const mergeClearBeforeCapture = (guesses: Guess<string[]>[]): Guess<string[]> => {
  const flagged = guesses.filter((g) => g.value.length > 0)

  if (flagged.length === 0) {
    return { value: [], confidence: 'low', evidence: ['no transient auth/session cookies detected across runs'] }
  }

  return {
    value: [...new Set(flagged.flatMap((g) => g.value))].sort(),
    confidence: flagged.some((g) => g.confidence === 'high') ? 'high' : 'medium',
    evidence: [...new Set(flagged.flatMap((g) => g.evidence))]
  }
}

// Auth kinds that imply a Bearer is in play — when one of these is the primary, a Cookie header alongside it
// usually means the service web-auths by cookie and API-auths by token (a second method worth surfacing).
const BEARER_KINDS = new Set<AuthKind>(['minted-jwt', 'bearer-token', 'spa-bearer'])

const hasCookieHeader = (run: RunData): boolean =>
  run.requests.some((r) =>
    Object.keys({ ...r.request.headers, ...(r.request.wireHeaders ?? {}) }).some((k) => k.toLowerCase() === 'cookie')
  )

const bestGuess = <T>(guesses: Guess<T>[]): Guess<T> => {
  const ranked = [...guesses].sort((a, b) => {
    const order = { high: 3, medium: 2, low: 1 }

    return order[b.confidence] - order[a.confidence]
  })

  return ranked[0]
}

const dedupeRender = (lists: RenderGuess[][]): RenderGuess[] => {
  const byHost = new Map<string, RenderGuess>()

  for (const g of lists.flat()) {
    byHost.set(`${g.host}:${g.shape}`, g)
  }

  return [...byHost.values()]
}

const dedupeEndpoints = (lists: EndpointHint[][]): EndpointHint[] => {
  const byKey = new Map<string, EndpointHint>()

  for (const e of lists.flat()) {
    // Key on category + host + path-without-query so the same surface across runs collapses to one hint.
    const path = (() => {
      try {
        return new URL(e.url).pathname
      } catch {
        return e.url
      }
    })()

    byKey.set(`${e.category}:${e.host}:${path}`, e)
  }

  return [...byKey.values()]
}

// Fold every recorded session of a surface into one profile. The primary auth is the strongest guess; any
// other method seen (a different kind across runs, or a Cookie riding alongside a Bearer) is surfaced as
// `authAlternatives` so a dual web+API auth scheme is visible rather than silently dropped.
export const aggregateProfile = (surface: string, runs: RunData[]): DomainProfile => {
  const profiles = runs.map(profileRun)
  const conflicts: string[] = []

  const auth = bestGuess(profiles.map((p) => p.auth))

  const alternatives = new Set<AuthKind>()

  for (const p of profiles) {
    if (p.auth.value !== auth.value) {
      alternatives.add(p.auth.value)
    }
  }

  if (BEARER_KINDS.has(auth.value) && auth.value !== 'cookie' && runs.some(hasCookieHeader)) {
    alternatives.add('cookie')
  }

  return {
    surface,
    runCount: runs.length,
    auth,
    authAlternatives: [...alternatives],
    transport: bestGuess(profiles.map((p) => p.transport)),
    render: dedupeRender(profiles.map((p) => p.render)),
    login: bestGuess(profiles.map((p) => p.login)),
    endpoints: dedupeEndpoints(profiles.map((p) => p.endpoints)),
    clearBeforeCapture: mergeClearBeforeCapture(profiles.map((p) => p.clearBeforeCapture)),
    conflicts
  }
}
