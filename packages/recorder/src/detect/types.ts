import type { AuthKind, TransportEngine } from '@butinapp/sdk'

import type { NavigationLogLine, RecordedRequest, RecordingManifest } from '../main/recording/types.js'

export type Confidence = 'high' | 'medium' | 'low'

// A classifier's output: the best-guess value, how strongly the evidence supports it, and the concrete
// observations behind it (shown verbatim in the domain overview so a guess is never a black box).
export type Guess<T> = { value: T; confidence: Confidence; evidence: string[] }

export type RunData = { manifest: RecordingManifest; requests: RecordedRequest[]; navigation: NavigationLogLine[] }

export type TransportLabel = { engine: TransportEngine; requiresBrowserEngine: boolean }

export type RenderShape = 'json' | 'graphql' | 'trpc' | 'rsc-flight' | 'html-scrape' | 'grpc-web'
export type RenderGuess = { host: string; shape: RenderShape; sampleUrls: string[] }

export type LoginMode = 'oauth-sso' | 'password' | 'magic-link' | 'mfa' | 'unknown'

// Data surfaces a plugin author usually wants to gather. A hint is a clue, not a contract: it flags that the
// trace touched an endpoint whose path looks like one of these — a starting point for writing collect().
export type EndpointCategory = 'members' | 'api-keys' | 'invoices' | 'usage' | 'totals'
export type EndpointHint = { category: EndpointCategory; method: string; url: string; host: string }

export type RunProfile = {
  transport: Guess<TransportLabel>
  auth: Guess<AuthKind>
  render: RenderGuess[]
  login: Guess<LoginMode>
  endpoints: EndpointHint[]
  /** Cookie names to list in `session.clearCookiesBeforeCapture` (IdP session / rotating OAuth-state cookies). */
  clearBeforeCapture: Guess<string[]>
  /** Whether any request carried a Cookie header — folds a dual web+API auth scheme without re-reading requests. */
  hasCookieHeader: boolean
}
export type DomainProfile = {
  surface: string
  runCount: number
  auth: Guess<AuthKind>
  /** Other auth kinds seen across this surface's runs (a service may web-auth by cookie and API-auth by Bearer). */
  authAlternatives: AuthKind[]
  transport: Guess<TransportLabel>
  render: RenderGuess[]
  login: Guess<LoginMode>
  endpoints: EndpointHint[]
  /** Cookie names to list in `session.clearCookiesBeforeCapture`, unioned across this surface's runs. */
  clearBeforeCapture: Guess<string[]>
  conflicts: string[]
}
