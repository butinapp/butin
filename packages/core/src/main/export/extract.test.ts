import { describe, expect, it } from 'vitest'

import { runSubdir } from './extract.js'

describe('extract run-folder planning', () => {
  it('builds an ISO-stamped subfolder name (filesystem-safe, trimmed to the second)', () => {
    expect(runSubdir(new Date('2026-06-13T14:05:09.000Z'))).toBe('2026-06-13T14-05-09')
  })

  it('is lexically sortable (chronological)', () => {
    const a = runSubdir(new Date('2026-06-13T09:00:00.000Z'))
    const b = runSubdir(new Date('2026-06-13T14:00:00.000Z'))

    expect(a < b).toBe(true)
  })
})
