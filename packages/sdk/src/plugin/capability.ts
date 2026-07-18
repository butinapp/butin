import type { CapabilityResult } from '../data/result.js'
import { createSampleGen, resolveSampleConfig, type SampleConfig, type SampleGenerator } from '../testing/synthetic.js'

import type { CredentialStore } from './auth.js'
import type { BrowserSession } from './browser.js'
import type { DocumentBytes } from './documents.js'
import type { ButinClient } from './transport.js'

// Everything a collector needs. `client` has auth + transport pre-applied; `config` is the plugin's
// own typed settings (hardcoded ids: org slug, account id, region); `creds` allows write-back.
export type CollectContext<TConfig = Record<string, unknown>> = {
  client: ButinClient
  // A client bound to one of the plugin's declared `backends` (a different host + token under the same
  // session) — for accounts split across platforms. Lazily built + memoized; throws on an unknown key.
  clientFor: (backendKey: string) => ButinClient
  creds: CredentialStore
  config: TConfig
  // A live authenticated browser session (offscreen window on the captured partition), for legacy backends
  // whose session can't be replayed with a bare headless request. Electron-backed; absent off-Electron and
  // in embeds — a collector that needs it must guard `if (!ctx.browser)`. See BrowserSession.
  browser?: BrowserSession
  // For an incremental capability's `fetch` only: the cutoff ISO date (`YYYY-MM-DD`) below which the service's
  // history is already stored, so the fetch can paginate newest-first and STOP once it crosses it. `undefined`
  // means fetch everything — the first run, a forced full refetch, or a non-incremental capability. Core derives
  // it from the stored row union (newest kept timestamp, minus the declared re-fetch window). See `incremental`.
  since?: string
  // The resolved `Authorization` header value for this session (e.g. `Bearer <jwt>` for a minted/SPA bearer), for
  // the rare case a collector must attach the SAME auth to a browser-side fetch (`ctx.browser`) — priming a
  // stateful portal's server session before its pages will render. Cached by `client`, so a normal `client` call
  // must have run first; `undefined` when the session is cookie-only.
  authToken?: () => string | undefined
  log: (message: string, extra?: Record<string, unknown>) => void
}

// `collect` is intentionally imperative — it can scrape a nonce, walk a Stripe portal, parse Remix
// flight data, decode protobuf. The contract standardizes its inputs (authed client) and output: every
// collector returns a CapabilityResult (datasets + views + summary), usually via a preset builder in
// presets/, which the generic DashboardRenderer draws. A standard capability is just `{ id, label, collect }`.
//
// `fetchFile` is the optional per-row byte source for a table view whose `files` declare a `{ fetch: true }`
// source (a POST/multi-step download — e.g. Videotron's invoice PDFs, carnet-sante's imaging/lab PDFs). Core
// calls it once per selected row with that row's record (which carries whatever key the fetch needs, e.g. a
// docId field not rendered as a column). Lives next to `collect` — never crosses IPC. When the files declare a
// `{ url }` source, core GETs that column's URL itself and `fetchFile` is unused.
// Declares a capability as incrementally fetchable. Its `fetch` returns a LIST of raw rows; core keeps a keyed
// union of those rows on disk (merging each fetch by `id`, retaining rows the service no longer returns), and
// runs `build` over the FULL union — so a partial fetch still renders the whole history with correct totals.
// `id` names the raw row's identity field; `timestamp` its ISO-date field (drives the `ctx.since` watermark);
// `window` is the trailing horizon always re-fetched to catch updates to recent rows (default applied by core).
export type IncrementalSpec = {
  id: string
  timestamp: string
  // Names the bundle field holding the row list, for a `fetch` that returns a composite bundle (e.g. rows +
  // an account-level field) rather than a bare array. Absent when the raw IS the list.
  listKey?: string
  window?: { days: number }
}

// The runtime incremental hooks the host needs: the raw-fetching `fetch` and the full-union `build`, kept
// SEPARATE (the standard `collect` collapses them). Carried on the Capability so the host can run the
// union/rebuild flow instead of a full collect. `fetch` may return a bare row list or, with `listKey` set, a
// bundle the host unwraps before merging; `build` always runs over the rebuilt raw (list or bundle).
export type IncrementalCapability = IncrementalSpec & {
  fetch: (ctx: CollectContext) => Promise<unknown>
  build: (raw: unknown) => CapabilityResult
}

export type Capability<TConfig = Record<string, unknown>> = {
  id: string
  label: string
  collect: (ctx: CollectContext<TConfig>) => Promise<CapabilityResult>
  // Present when the capability opted into incremental fetch via defineCapability. The host runs the
  // union/rebuild flow off these instead of `collect`; absent → every refresh is a full collect (the default).
  incremental?: IncrementalCapability
  // A synthetic snapshot for demo/seed runs, drawn by the generic renderer like any real result. Authored via
  // defineCapability (a generator that builds a raw from the synthetic toolkit, then through `build`), so it
  // renders exactly what the live collector would and cannot carry real data. `opts` lets the seed pick the
  // dataset size + a per-capability seed; called with no args (the contract test) it uses the medium preset.
  sample?: (opts?: { config?: SampleConfig; seed?: string }) => CapabilityResult
  fetchFile?: (ctx: CollectContext<TConfig>, row: Record<string, unknown>) => Promise<DocumentBytes>
}

// There is ONE capability shape. A capability that wants a downloadable table marks it with a `files` view
// descriptor (see view.ts). "Save everything" is entirely core-side: it serializes every capability's result
// and downloads each `files` table, with no plugin code. Cross-service rollup keys off `summary.section`.

// Author a capability by its two halves: `fetch` (the service-specific network/parse) and `build` (the pure
// raw → CapabilityResult transform). `sample` is a GENERATOR that fabricates a synthetic raw from the seeded
// toolkit (its people/emails are always fake — `@example.invalid`), so a sample can NEVER carry real recorded
// data; `collect` and `sample` both close over the SAME `build`, so the demo render can't drift from the live
// one. `build(sample(...))` also doubles as a contract test (validateCapabilityResult).
// The row type of an array-shaped raw; `never` for a non-array raw, which makes the `incremental` field's key
// names uninhabitable on a raw that isn't a list (incremental fetch only makes sense over a row list).
type RowOf<TRaw> = TRaw extends readonly (infer R)[] ? R : never

// Keys of a bundle whose value is a row array — the candidates for an incremental `listKey`.
type ListKeys<T> = { [K in keyof T]: T[K] extends readonly unknown[] ? K : never }[keyof T]
type FieldOf<A> = keyof RowOf<A> & string

// The `incremental` declaration: array-raw form (raw IS the list) OR bundle form (`listKey` names the list
// field on a composite raw — e.g. `{ invoices: [...], plan: 'pro' }`).
type IncrementalDecl<TRaw> = TRaw extends readonly unknown[]
  ? { id: FieldOf<TRaw>; timestamp: FieldOf<TRaw>; window?: { days: number } }
  : {
      [K in ListKeys<TRaw>]: {
        listKey: K
        id: FieldOf<TRaw[K]>
        timestamp: FieldOf<TRaw[K]>
        window?: { days: number }
      }
    }[ListKeys<TRaw>]

export const defineCapability = <TRaw, TConfig = Record<string, unknown>>(spec: {
  id: string
  label: string
  fetch: (ctx: CollectContext<TConfig>) => Promise<TRaw>
  build: (raw: TRaw) => CapabilityResult
  sample: SampleGenerator<TRaw>
  fetchFile?: (ctx: CollectContext<TConfig>, row: Record<string, unknown>) => Promise<DocumentBytes>
  // Opt into incremental fetch. Array-raw: `id`/`timestamp` name fields of the row. Bundle-raw: `listKey` names
  // the bundle field holding the row list, and `id`/`timestamp` name fields of ITS elements. `fetch` must then
  // honour `ctx.since` (paginate newest-first, stop past it); `build` already runs over the full raw, so it
  // needs no change.
  incremental?: IncrementalDecl<TRaw>
}): Capability<TConfig> => {
  const inc = spec.incremental as { id: string; timestamp: string; listKey?: string; window?: { days: number } }

  return {
    id: spec.id,
    label: spec.label,
    collect: async (ctx) => spec.build(await spec.fetch(ctx)),
    sample: (opts) =>
      spec.build(spec.sample(createSampleGen(opts?.seed ?? spec.id), resolveSampleConfig(opts?.config))),
    ...(spec.fetchFile ? { fetchFile: spec.fetchFile } : {}),
    ...(spec.incremental
      ? {
          incremental: {
            id: inc.id,
            timestamp: inc.timestamp,
            ...(inc.listKey ? { listKey: inc.listKey } : {}),
            ...(inc.window ? { window: inc.window } : {}),
            fetch: spec.fetch as unknown as IncrementalCapability['fetch'],
            build: spec.build as unknown as IncrementalCapability['build']
          }
        }
      : {})
  }
}
