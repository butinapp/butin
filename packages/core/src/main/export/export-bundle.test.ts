import { type Summary } from '@butinapp/sdk/data'
import { describe, expect, it } from 'vitest'

import type { OverviewTileDto } from '../../shared/ipc.js'

import { toOverviewPlugin } from './export-bundle.js'

// The electron-free pure mapping (buildExportBundle itself reaches into electron's `app`, so it stays
// typecheck-only). Both the export bundle and the live Overview depend on this mapping, so it carries the
// coverage.
describe('toOverviewPlugin', () => {
  const base: OverviewTileDto = { pluginId: 'svc', name: 'Service', state: 'connected' }

  it('copies identity + series fields straight across', () => {
    const monthly = [{ month: '2026-06', amount: 12 }]
    const mapped = toOverviewPlugin({ ...base, color: '#abc', icon: 'data:x', monthly, itemCount: 3, lastRunAt: 't' })

    expect(mapped).toMatchObject({
      pluginId: 'svc',
      pluginName: 'Service',
      color: '#abc',
      icon: 'data:x',
      monthly,
      itemCount: 3,
      lastRunAt: 't',
      state: 'connected'
    })
  })

  it('sets balance from the balance-section summary, not from a spend one', () => {
    const balance: Summary = { section: 'balance', label: 'Balance', value: 1284.55, role: 'money', currency: 'USD' }
    const spend: Summary = { section: 'spend', label: 'MTD', value: 42, role: 'money', currency: 'USD' }

    // A bank reporting both spend AND balance: balance comes from the balance summary, spend never sets it.
    expect(toOverviewPlugin({ ...base, summaries: [spend, balance] }).balance).toBe(1284.55)
    expect(toOverviewPlugin({ ...base, summaries: [spend] }).balance).toBeUndefined()
  })

  it('leaves balance undefined when there are no summaries', () => {
    expect(toOverviewPlugin(base).balance).toBeUndefined()
  })
})
