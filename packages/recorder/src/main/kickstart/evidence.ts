import { join } from 'node:path'

import type { RunData } from '../../detect/types.js'
import { requestFileName } from '../recording/naming.js'
import type { RecordedRequest } from '../recording/types.js'

import type { EvidenceRef, PlannedCapability } from './types.js'

const MAX_EVIDENCE = 3

// host + path, query stripped — the match key tying a capability's detected endpoint to the request files
// that hit it. Unparseable URLs collapse to the raw string so they still compare equal to themselves.
const pathKey = (url: string): string => {
  try {
    const u = new URL(url)

    return `${u.host}${u.pathname}`
  } catch {
    return url
  }
}

// Reconstruct the on-disk request filename storage.ts wrote (same index/method/url/extra derivation), so the
// brief can point at the exact file without re-listing the requests dir.
const fileNameFor = (req: RecordedRequest): string => {
  const extra =
    req.request.graphqlOperation ??
    (req.request.nextAction ? `action-${req.request.nextAction.slice(0, 8)}` : undefined)

  return requestFileName(req.index, req.request.method, req.request.url, extra)
}

// Resolve, for each planned capability, the recorded request files whose host+path match its detected
// endpoint — across ALL runs of the surface — as absolute paths the brief references verbatim. Mutates the
// capabilities' `evidence` arrays and returns them for convenience.
export const resolveEvidence = (
  capabilities: PlannedCapability[],
  runs: RunData[],
  runsRoot: string
): PlannedCapability[] => {
  for (const cap of capabilities) {
    if (!cap.endpointUrl) {
      continue
    }

    const wanted = pathKey(cap.endpointUrl)
    const refs: EvidenceRef[] = []

    for (const run of runs) {
      if (refs.length >= MAX_EVIDENCE) {
        break
      }

      const runId = run.manifest.runId

      for (const req of run.requests) {
        if (refs.length >= MAX_EVIDENCE) {
          break
        }

        if (pathKey(req.request.url) === wanted) {
          refs.push({
            path: join(runsRoot, runId, 'requests', fileNameFor(req)),
            method: req.request.method,
            status: req.response?.status,
            runId
          })
        }
      }
    }

    cap.evidence = refs
  }

  return capabilities
}
