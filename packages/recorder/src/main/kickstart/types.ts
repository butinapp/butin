import type { DomainProfile, EndpointCategory, RunData } from '../../detect/types.js'

// A recorded request file that hits a planned capability's endpoint — the concrete evidence the brief points
// the implementer at to read the real response shape.
export type EvidenceRef = {
  /** Absolute path to the requests/*.json file under the run dir. */
  path: string
  method: string
  status?: number
  runId: string
}

// One capability the scaffold will stub, derived from an endpoint hint (or the `status` fallback when a
// recording surfaced no recognizable data endpoints).
export type PlannedCapability = {
  /** Stable capability id + function-name base, e.g. 'billing' | 'usage' | 'keys' | 'members' | 'status'. */
  capId: string
  label: string
  /** The endpoint-hint category this came from; absent for the `status` fallback. */
  category?: EndpointCategory
  /** The SDK preset to build with, e.g. 'billing.result'; absent for the `status` fallback. */
  preset?: string
  endpointUrl?: string
  endpointMethod?: string
  /** Recorded request files matching the endpoint — filled by resolveEvidence(). */
  evidence: EvidenceRef[]
}

export type KickstartInput = {
  surface: string
  id: string
  name: string
  vendor: string
  profile: DomainProfile
  /** All runs of the surface — drives evidence resolution and the dashboard-marker guess. */
  runs: RunData[]
  /** Workspace root — for the absolute plugin path in the brief. */
  repoRoot: string
  /** Recordings root (~/butin/.recordings) — base for evidence + brief paths. */
  runsRoot: string
}

export type KickstartResult = {
  mainTs: string
  testTs: string
  brief: string
  prompt: string
  capabilities: PlannedCapability[]
  /** The run whose dir the brief is written into (the surface's newest run). */
  briefRunId: string
}
