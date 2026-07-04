import type { DomainProfile, EndpointCategory } from '../../detect/types.js'

import type { PlannedCapability } from './types.js'

// One row per endpoint-hint category we can scaffold against a known SDK preset. `totals` carries no own
// capability — it strengthens the billing summary — so it's intentionally absent here.
const CATEGORY_MAP: Partial<Record<EndpointCategory, { capId: string; label: string; preset: string }>> = {
  invoices: { capId: 'billing', label: 'Billing', preset: 'billing.result' },
  usage: { capId: 'usage', label: 'Usage', preset: 'usage.result' },
  'api-keys': { capId: 'keys', label: 'API Keys', preset: 'keys.result' },
  members: { capId: 'members', label: 'Members', preset: 'members.result' }
}

// The compile-green fallback when a recording surfaced no recognizable data endpoints — mirrors the single
// `status` stub new-plugin.mjs emits, so the scaffold always typechecks and renders.
const STATUS_FALLBACK: PlannedCapability = { capId: 'status', label: 'Status', evidence: [] }

// Map the detected endpoint hints to a deduped set of planned capabilities (the first hint of a category
// wins its endpoint URL; same-category hits fold in during evidence resolution). Order follows the canonical
// billing → usage → keys → members layout regardless of detection order. No hints → the `status` fallback.
export const planCapabilities = (profile: DomainProfile): PlannedCapability[] => {
  const order: EndpointCategory[] = ['invoices', 'usage', 'api-keys', 'members']
  const planned: PlannedCapability[] = []

  for (const category of order) {
    const hint = profile.endpoints.find((e) => e.category === category)
    const mapped = CATEGORY_MAP[category]

    if (hint && mapped) {
      planned.push({
        capId: mapped.capId,
        label: mapped.label,
        category,
        preset: mapped.preset,
        endpointUrl: hint.url,
        endpointMethod: hint.method,
        evidence: []
      })
    }
  }

  return planned.length > 0 ? planned : [{ ...STATUS_FALLBACK }]
}
