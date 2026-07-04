import { type Summary } from '@butinapp/sdk/data'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const { fakePlugin } = vi.hoisted(() => ({
  fakePlugin: {
    meta: { id: 'fake', name: 'Fake' },
    reportingCurrency: 'USD',
    auth: { kind: 'cookie' },
    capabilities: [{ id: 'summary', label: 'Summary' }]
  }
}))

vi.mock('../plugin/plugins.js', () => ({
  plugins: [fakePlugin],
  pluginById: (id: string) => (id === 'fake' ? fakePlugin : undefined)
}))
vi.mock('../plugin/connection.js', () => ({ isPluginConnected: () => true }))
vi.mock('../store/config-file.js', () => ({ getPluginInstalled: () => true }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-eval-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('writes a MoM change notification from monthly ledger spend', async () => {
  const { setDataRoot, saveCurrent } = await import('../store/store.js')
  const { accumulate } = await import('../store/ledger.js')
  const { setAlertConfig } = await import('./alerts-config.js')
  const { setFxConfig } = await import('../store/fx-rates.js')
  const { evaluateAlerts } = await import('./evaluate.js')
  const { readNotifications } = await import('./notifications-store.js')

  setDataRoot(dir)
  await setFxConfig({ baseCurrency: 'USD', rates: {} })
  await setAlertConfig({ change: { dod: {}, wow: {}, mom: { spend: 20 } }, health: { fxMissing: false } })

  const summary: Summary = { section: 'spend', label: 'MTD', value: 130, role: 'money', currency: 'USD' }

  // The latest cached report gives buildOverview the spend section + lastRunAt + currency.
  await saveCurrent('fake', 'summary', {
    datasets: [],
    summaries: [summary],
    manifest: { views: [], summaries: { spend: { label: 'MTD' } } }
  })

  // Three monthly-end readings of a monthly-resetting MTD counter. deriveDailySpend attributes each
  // month-rollover's value as that month's spend → Apr 100, May 130 (the March seed lets April derive).
  const reading = (capturedAt: string, value: number) => ({
    capturedAt,
    datasets: [],
    summaries: [{ section: 'spend', label: 'MTD', value, role: 'money', currency: 'USD' } as Summary]
  })

  await accumulate('fake', 'summary', reading('2026-03-31T00:00:00Z', 90))
  await accumulate('fake', 'summary', reading('2026-04-30T00:00:00Z', 100))
  await accumulate('fake', 'summary', reading('2026-05-31T00:00:00Z', 130))

  await evaluateAlerts()

  const items = await readNotifications()
  const change = items.find((n) => n.kind === 'change')

  expect(change?.window).toBe('mom')
  expect(change?.pluginId).toBe('fake')
  expect(change?.facet).toBe('spend')
})
