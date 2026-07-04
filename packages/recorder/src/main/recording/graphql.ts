// Extracts a GraphQL operation name from a request body. GraphQL APIs typically
// POST one URL for everything, so the operation name is the only thing that
// tells requests apart — surfacing it makes a run far easier to navigate.
// Returns undefined for non-GraphQL bodies (cheap guards avoid parsing them).

function operationNameOf(op: unknown): string | undefined {
  if (!op || typeof op !== 'object') {
    return undefined
  }

  const o = op as { operationName?: unknown; query?: unknown }

  if (typeof o.operationName === 'string' && o.operationName.trim()) {
    return o.operationName
  }

  if (typeof o.query === 'string') {
    const m = o.query.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/)

    if (m) {
      return m[2]
    }
  }

  return undefined
}

export function extractGraphqlOperation(body: string | null): string | undefined {
  if (!body || body.length > 100_000) {
    return undefined
  }

  // Quick reject before the (potentially expensive) JSON.parse.
  if (!body.includes('"query"') && !body.includes('"operationName"')) {
    return undefined
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }

  const ops = Array.isArray(parsed) ? parsed : [parsed]
  const names: string[] = []

  for (const op of ops) {
    const name = operationNameOf(op)

    if (name) {
      names.push(name)
    }
  }

  return names.length ? names.join('+') : undefined
}
