import { capabilityResult, table } from '../data/builders.js'
import type { CapabilityResult } from '../data/result.js'

// One API key — secrets masked at the source (`sk-…last4`).
export type ApiKeyInput = {
  id: string
  name?: string
  masked?: string
  createdAt?: string
  lastUsedAt?: string
  revoked?: boolean
}

export type ApiKeysInput = {
  keys: ApiKeyInput[]
}

const day = (ts?: string): string | null => (ts ? ts.slice(0, 10) : null)

type KeyRow = {
  name: string | null
  masked: string | null
  createdAt: string | null
  lastUsedAt: string | null
  status: string
}

// The apiKeys preset: a single inventory table (name / key / created / last used / status). No summary —
// a key count isn't a meaningful cross-service rollup.
export const apiKeysResult = (input: ApiKeysInput): CapabilityResult => {
  const keys = table<KeyRow>({
    id: 'keys',
    columns: [
      { key: 'name', role: 'label', label: 'Name' },
      { key: 'masked', role: 'label', label: 'Key' },
      { key: 'createdAt', role: 'timestamp', label: 'Created' },
      { key: 'lastUsedAt', role: 'timestamp', label: 'Last used' },
      { key: 'status', role: 'status', label: 'Status' }
    ],
    rows: input.keys.map((k) => ({
      name: k.name ?? null,
      masked: k.masked ?? null,
      createdAt: day(k.createdAt),
      lastUsedAt: day(k.lastUsedAt),
      status: k.revoked ? 'revoked' : 'active'
    }))
  })

  return capabilityResult({ sections: [keys.table({ title: 'API keys' })] })
}
