import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ProvidersPage, type ProviderView } from './providers.js'

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
const HOUR = 60 * 60 * 1000

const base = {
  hasCookie: true,
  connected: true,
  sessionless: false,
  configFields: [],
  config: {},
  capabilities: [],
  enabled: true
}

const providers: ProviderView[] = [
  { ...base, id: 'aws', name: 'AWS', category: 'cloud', state: 'connected' },
  { ...base, id: 'desjardins', name: 'Desjardins', category: 'finance', state: 'connected' },
  { ...base, id: 'claude', name: 'Claude', category: 'ai', state: 'disconnected', connected: false }
]

const noop = () => {}

const renderPage = (extra: Partial<Parameters<typeof ProvidersPage>[0]> = {}) =>
  render(
    <ProvidersPage
      providers={providers}
      busy={null}
      onOpen={noop}
      onTest={async () => ({ ok: false })}
      onConnect={noop}
      onDisconnect={noop}
      onRefresh={noop}
      onToggleEnabled={noop}
      {...extra}
    />
  )

test('renders category section headers in fixed order', () => {
  renderPage()

  const headers = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)

  expect(headers).toEqual(['Finance', 'Cloud', 'AI'])
})

test('shows the refresh summary banner when provided', () => {
  renderPage({ refreshSummary: { refreshed: 2, needsReconnect: ['claude'] } })

  expect(screen.getByText('2 refreshed · 1 need reconnect')).toBeInTheDocument()
})

test('a card shows when its data was last refreshed, and "Never refreshed" when it never has', () => {
  renderPage({
    providers: [
      { ...base, id: 'aws', name: 'AWS', category: 'cloud', state: 'connected', lastRunAt: ago(2 * HOUR) },
      { ...base, id: 'claude', name: 'Claude', category: 'ai', state: 'connected' }
    ]
  })

  expect(screen.getByText(/Refreshed .*hours? ago/)).toBeInTheDocument()
  expect(screen.getByText('Never refreshed')).toBeInTheDocument()
})

test('the "Needs refresh" filter isolates connected services whose data is stale or never fetched', () => {
  renderPage({
    providers: [
      { ...base, id: 'fresh', name: 'Fresh', category: 'cloud', state: 'connected', lastRunAt: ago(1 * HOUR) },
      { ...base, id: 'stale', name: 'Stale', category: 'cloud', state: 'connected', lastRunAt: ago(24 * HOUR) },
      { ...base, id: 'never', name: 'Never', category: 'cloud', state: 'unverified' },
      {
        ...base,
        id: 'dead',
        name: 'Dead',
        category: 'cloud',
        state: 'disconnected',
        connected: false,
        lastRunAt: ago(48 * HOUR)
      }
    ]
  })

  fireEvent.click(screen.getByRole('button', { name: 'Needs refresh' }))

  // Stale + never-fetched (with a live-enough session) surface; the fresh one and the disconnected one don't.
  expect(screen.getByText('Stale')).toBeInTheDocument()
  expect(screen.getByText('Never')).toBeInTheDocument()
  expect(screen.queryByText('Fresh')).toBeNull()
  expect(screen.queryByText('Dead')).toBeNull()
})

test('the bulk buttons show how many services they will process', () => {
  renderPage({ onTestAll: noop, onRefreshAll: noop })

  // Test all targets every enabled service (3); Refresh all skips the disconnected one (2).
  expect(screen.getByRole('button', { name: 'Test all (3)' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Refresh all (2)' })).toBeInTheDocument()
})

test('the refresh summary banner can be dismissed', () => {
  const onDismissSummary = vi.fn()

  renderPage({ refreshSummary: { refreshed: 2, needsReconnect: ['claude'] }, onDismissSummary })
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

  expect(onDismissSummary).toHaveBeenCalledOnce()
})

test('a disabled (dormant) card hides connection actions and keeps the enable switch live', () => {
  render(
    <ProvidersPage
      providers={[{ ...base, id: 'aws', name: 'AWS', category: 'cloud', state: 'connected', enabled: false }]}
      busy={null}
      onOpen={noop}
      onTest={async () => ({ ok: false })}
      onConnect={noop}
      onDisconnect={noop}
      onRefresh={noop}
      onToggleEnabled={noop}
    />
  )

  // No Test / Reconnect / Disconnect / Refresh card actions while dormant — only the dormant hint + the toggle.
  for (const name of ['Test', 'Reconnect', 'Clear session', 'Refresh data']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }

  // The title is inert too — a dormant card can't be opened (its only live control is the Enable switch).
  expect(screen.queryByRole('button', { name: /AWS/ })).toBeNull()
  expect(screen.getByText('Off — enable to use')).toBeInTheDocument()
  expect(screen.getByRole('switch')).toBeInTheDocument()
})
