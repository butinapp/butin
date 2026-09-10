import { dayMinus, isoDay } from '@butinapp/sdk/util'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { readJson as readJsonSecure, writeJson as writeJsonSecure } from './secure-fs.js'
import { dataRootDir } from './store.js'

const SCHEMA_VERSION = 1

// The keyed union of a capability's raw fetched rows — the source an incremental `build` re-runs over so a
// partial fetch still renders the whole history. `key` names the identity field; `rows` are merged by it across
// fetches, retaining rows the service has stopped returning. Captured data, so it routes through secure-fs (sealed at rest under an encrypted profile).
export type RawUnion = {
  schemaVersion: number
  key: string
  rows: Record<string, unknown>[]
}

const unionPath = (pluginId: string, capabilityId: string): string =>
  join(dataRootDir(), pluginId, 'raw', `${capabilityId}.json`)

export const readRawUnion = (pluginId: string, capabilityId: string): Promise<RawUnion | null> =>
  readJsonSecure<RawUnion>(dataRootDir(), unionPath(pluginId, capabilityId))

export const writeRawUnion = (
  pluginId: string,
  capabilityId: string,
  data: { key: string; rows: Record<string, unknown>[] }
): Promise<void> =>
  writeJsonSecure(dataRootDir(), unionPath(pluginId, capabilityId), { schemaVersion: SCHEMA_VERSION, ...data })

export const clearRawUnion = (pluginId: string, capabilityId: string): Promise<void> =>
  rm(unionPath(pluginId, capabilityId), { force: true })

// --- pure merge / watermark (fixture-tested) ----------------------------------------------------------------

const idOf = (row: Record<string, unknown>, key: string): string | undefined => {
  const v = row[key]

  return v === null || v === undefined || v === '' ? undefined : String(v)
}

// Merge freshly-fetched rows into the prior union by `key`: a re-seen key takes the fresh row (a row the service
// updated), a new key is appended, and a prior key absent from this fetch is RETAINED (the service stopped
// returning it but the local copy is durable). Rows with no usable key value can't dedupe — kept, appended last.
// Order: prior keyed rows first (positions preserved across updates), then new keyed rows, then keyless.
export const mergeRawRows = (
  prior: Record<string, unknown>[],
  fetched: Record<string, unknown>[],
  key: string
): Record<string, unknown>[] => {
  const keyed = new Map<string, Record<string, unknown>>()
  const keyless: Record<string, unknown>[] = []

  for (const row of [...prior, ...fetched]) {
    const id = idOf(row, key)

    if (id === undefined) {
      keyless.push(row)
    } else {
      keyed.set(id, row)
    }
  }

  return [...keyed.values(), ...keyless]
}

const newestTimestamp = (rows: Record<string, unknown>[], field: string): string => {
  let max = ''

  for (const row of rows) {
    const v = row[field]
    const day = typeof v === 'string' && v.length >= 10 ? isoDay(v) : undefined

    if (day && day > max) {
      max = day
    }
  }

  return max
}

// The `ctx.since` cutoff for an incremental fetch: `min(newest stored timestamp, now − window)` at day
// precision. Low enough to include every new row (≤ the newest we hold) AND to re-fetch the trailing window (≤
// now − window) so updates to recent rows are caught. `undefined` for an empty union (a full fetch). `now` is
// injected (ISO) so the computation stays deterministic + testable.
export const computeSince = (
  rows: Record<string, unknown>[],
  timestampField: string,
  windowDays: number,
  now: string
): string | undefined => {
  const newest = newestTimestamp(rows, timestampField)

  if (!newest) {
    return undefined
  }

  const windowStart = dayMinus(isoDay(now) ?? now, windowDays)

  return newest < windowStart ? newest : windowStart
}
