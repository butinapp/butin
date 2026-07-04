import { z } from 'zod'

import { OverviewPluginSchema } from './overview.js'

// The portable export artifact — Butin's normalized data lifted out as ONE self-contained JSON blob, so a
// cloud page can render it through @butinapp/ui with zero recompute. Producer = core (buildExportBundle);
// consumer = @butinapp/viewer.
//
// Versioned + zod-validated: the bundle is the most boundary-crossing object in the system — produced by one
// version of Butin, possibly merged by a gateway, consumed by a separately-deployed viewer. A consumer runs
// `parseExportBundle` to gate on `formatVersion` (refusing a bundle from a NEWER Butin) and to reject a
// malformed blob rather than mis-rendering it. Bump the version only on a breaking shape change.

export const EXPORT_BUNDLE_FORMAT_VERSION = 1

// One capability's cached state at export time. `result` is the stored CapabilityResult (datasets/views/
// summary) — whatever the generic renderer received live. `error` carries a failed last run so the viewer
// can surface it instead of an empty tab.
export const ExportBundleCapabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  result: z.unknown().optional(),
  lastRunAt: z.string().optional(),
  error: z.string().optional()
})
export type ExportBundleCapability = z.infer<typeof ExportBundleCapabilitySchema>

// Who contributed a service in a MERGED bundle (produced by @butinapp/gateway). Additive + optional, so it is
// formatVersion-safe: the single-instance export omits it and the current viewer ignores it.
export const ExportPluginProvenanceSchema = z.object({
  contributedBy: z.array(z.object({ contributorId: z.string(), label: z.string(), capturedAt: z.string() })),
  coveredBy: z.number()
})
export type ExportPluginProvenance = z.infer<typeof ExportPluginProvenanceSchema>

// One service's identity + its capabilities' cached data. `meta.icon` (a self-contained data-URI) is
// optional — the viewer renders a brand-colored letter monogram from `name` + `color` when it's absent.
export const ExportPluginSchema = z.object({
  meta: z.object({
    id: z.string(),
    name: z.string(),
    vendor: z.string().optional(),
    category: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    dashboardUrl: z.string().optional(),
    capabilities: z.array(z.object({ id: z.string(), label: z.string() }))
  }),
  capabilities: z.array(ExportBundleCapabilitySchema),
  // Present only on a gateway-merged bundle; absent on a single-instance export.
  provenance: ExportPluginProvenanceSchema.optional()
})
export type ExportPlugin = z.infer<typeof ExportPluginSchema>

export const ExportBundleSchema = z.object({
  formatVersion: z.literal(EXPORT_BUNDLE_FORMAT_VERSION),
  generatedAt: z.string(), // ISO
  butinVersion: z.string().optional(),
  profileName: z.string().optional(), // display-only label
  plugins: z.array(ExportPluginSchema),
  // The exact input @butinapp/ui's <Overview> consumes — precomputed by the producer so the viewer is a pure
  // renderer ("the cloud is dumb on purpose").
  overview: z.array(OverviewPluginSchema)
})
export type ExportBundle = z.infer<typeof ExportBundleSchema>

// Validate an untrusted bundle blob at the viewer boundary. Gates on `formatVersion` FIRST so a bundle from
// a newer Butin gets a clear "unsupported version" rather than a wall of shape errors, then full-parses.
export type ParseBundleResult = { ok: true; bundle: ExportBundle } | { ok: false; errors: string[] }

export const parseExportBundle = (raw: unknown): ParseBundleResult => {
  const version = (raw as { formatVersion?: unknown } | null)?.formatVersion

  if (typeof version === 'number' && version > EXPORT_BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      errors: [`bundle formatVersion ${version} is newer than this viewer supports (${EXPORT_BUNDLE_FORMAT_VERSION})`]
    }
  }

  const parsed = ExportBundleSchema.safeParse(raw)

  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  }

  return { ok: true, bundle: parsed.data }
}
