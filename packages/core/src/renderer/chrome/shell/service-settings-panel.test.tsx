import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { ServiceSettingsPanel } from './service-settings-panel.js'

const noop = () => {}

const baseProps = {
  sessionless: false,
  connected: true,
  enabled: true,
  inventory: [],
  onReconnect: noop,
  onTest: async () => ({ ok: false }),
  onDisconnect: noop,
  onToggleEnabled: noop,
  onRefreshAll: noop,
  onExtract: noop,
  onRevealFolder: noop,
  onEraseData: noop
}

test('session plugin shows the connection trio + data actions and fires their callbacks', async () => {
  const onReconnect = vi.fn()
  const onTest = vi.fn(async () => ({ ok: false }))
  const onDisconnect = vi.fn()
  const onRefreshAll = vi.fn()
  const onExtract = vi.fn()

  render(
    <ServiceSettingsPanel
      {...baseProps}
      onReconnect={onReconnect}
      onTest={onTest}
      onDisconnect={onDisconnect}
      onRefreshAll={onRefreshAll}
      onExtract={onExtract}
    />
  )

  await userEvent.click(screen.getByRole('button', { name: /reconnect/i }))
  await userEvent.click(screen.getByRole('button', { name: /^test$/i }))
  await userEvent.click(screen.getByRole('button', { name: /disconnect/i }))
  await userEvent.click(screen.getByRole('button', { name: /refresh all tabs/i }))
  await userEvent.click(screen.getByRole('button', { name: /save everything/i }))

  expect(onReconnect).toHaveBeenCalledOnce()
  expect(onTest).toHaveBeenCalledOnce()
  expect(onDisconnect).toHaveBeenCalledOnce()
  expect(onRefreshAll).toHaveBeenCalledOnce()
  expect(onExtract).toHaveBeenCalledOnce()
})

test('enable toggle reflects state and fires onToggleEnabled', async () => {
  const onToggleEnabled = vi.fn()

  render(<ServiceSettingsPanel {...baseProps} enabled onToggleEnabled={onToggleEnabled} />)

  const toggle = screen.getByRole('switch')

  expect(toggle).toBeChecked()

  await userEvent.click(toggle)
  expect(onToggleEnabled).toHaveBeenCalledWith(false)
})

test('sessionless plugin renders the config form instead of Magic Login / Disconnect', () => {
  render(
    <ServiceSettingsPanel
      {...baseProps}
      sessionless
      configForm={{ fields: [{ key: 'region', label: 'Region', kind: 'text' }], onSubmit: noop }}
    />
  )

  expect(screen.getByLabelText(/region/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument()
})

test('sessionless plugin reflects a failed test in the connection status (not a stale "connected")', () => {
  render(
    <ServiceSettingsPanel
      {...baseProps}
      sessionless
      connected
      health={{ ok: false, error: 'Could not load credentials from any providers' }}
      configForm={{ fields: [{ key: 'region', label: 'Region', kind: 'text' }], onSubmit: noop }}
    />
  )

  // The card header must reflect the failed probe (disconnected), not "connected" off the filled-in form.
  expect(screen.getByText(/disconnected/i)).toBeInTheDocument()
  expect(screen.queryByText(/^connected$/i)).not.toBeInTheDocument()
})

test('data actions are disabled when disconnected', () => {
  render(<ServiceSettingsPanel {...baseProps} connected={false} />)

  expect(screen.getByRole('button', { name: /refresh all tabs/i })).toBeDisabled()
  expect(screen.getByRole('button', { name: /save everything/i })).toBeDisabled()
  // A disconnected session plugin offers Connect (not Reconnect) and hides Test/Disconnect.
  expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^test$/i })).not.toBeInTheDocument()
})

test('lists each capability with its record count + last-run time (or never), plus the description intro', () => {
  render(
    <ServiceSettingsPanel
      {...baseProps}
      description="Serper search-API billing."
      inventory={[
        { id: 'billing', label: 'Billing', recordCount: 88, lastRunAt: '2026-06-13T21:31:03.000Z', snapshotCount: 30 },
        { id: 'usage', label: 'Usage', recordCount: 0, snapshotCount: 0 }
      ]}
    />
  )

  expect(screen.getByText('Billing')).toBeInTheDocument()
  expect(screen.getByText('Usage')).toBeInTheDocument()
  expect(screen.getByText('88')).toBeInTheDocument()
  // "never" shows for the usage row's freshness AND the empty "Last synced" tile — at least one is present.
  expect(screen.getAllByText(/never/i).length).toBeGreaterThan(0)
  expect(screen.getByText('Serper search-API billing.')).toBeInTheDocument()
})

test('per-row refresh is gated on connection (a live fetch); View stays available for cached data', () => {
  const inv = [{ id: 'billing', label: 'Billing', recordCount: 5, snapshotCount: 0 }]
  const props = { onRefreshCapability: vi.fn(), onViewCapability: vi.fn() }

  const { rerender } = render(<ServiceSettingsPanel {...baseProps} connected={false} inventory={inv} {...props} />)

  expect(screen.getByRole('button', { name: /refresh billing/i })).toBeDisabled()
  // Viewing cached data doesn't need a live session, so it stays enabled while disconnected.
  expect(screen.getByRole('button', { name: /view billing/i })).toBeEnabled()

  rerender(<ServiceSettingsPanel {...baseProps} connected inventory={inv} {...props} />)
  expect(screen.getByRole('button', { name: /refresh billing/i })).toBeEnabled()
})

test('a long capability label is truncated with its full text available on hover', () => {
  const label = 'Organization member spend over the open billing period (per-seat breakdown)'

  render(<ServiceSettingsPanel {...baseProps} inventory={[{ id: 'spend', label, recordCount: 1, snapshotCount: 0 }]} />)

  expect(screen.getByText(label)).toHaveClass('truncate')
  expect(screen.getByText(label)).toHaveAttribute('title', label)
})

test('names the Open-dashboard destination host so it is clear it opens externally', async () => {
  const onOpenDashboard = vi.fn()

  render(
    <ServiceSettingsPanel
      {...baseProps}
      dashboardUrl="https://sentry.io/organizations/x"
      onOpenDashboard={onOpenDashboard}
    />
  )

  // The host is shown alongside the label, and the whole control fires onOpenDashboard.
  expect(screen.getByText('sentry.io')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /open dashboard/i }))
  expect(onOpenDashboard).toHaveBeenCalledOnce()
})

test('async folder stats: pending tiles, then the resolved file count + size', () => {
  const { rerender } = render(<ServiceSettingsPanel {...baseProps} folderStats={{ pending: true }} />)

  // While pending, neither the count nor a size is shown yet.
  expect(screen.queryByText('37')).not.toBeInTheDocument()

  rerender(<ServiceSettingsPanel {...baseProps} folderStats={{ pending: false, fileCount: 37, totalBytes: 325_632 }} />)

  expect(screen.getByText('37')).toBeInTheDocument()
  expect(screen.getByText('318 KB')).toBeInTheDocument()
})

const sampleMechanics = {
  authKind: 'cookie',
  authSummary: 'Replays your stored session cookie, fetched headless.',
  transportEngine: 'node' as const,
  requiresBrowserEngine: false,
  cookieDomains: ['sentry.io']
}

test('"Under the hood" is gated behind developer mode, then expands to reveal the connection mechanics', async () => {
  const { rerender } = render(<ServiceSettingsPanel {...baseProps} mechanics={sampleMechanics} />)

  // Hidden from the everyday view — it's a developer-mode disclosure.
  expect(screen.queryByRole('button', { name: /under the hood/i })).not.toBeInTheDocument()

  rerender(<ServiceSettingsPanel {...baseProps} mechanics={sampleMechanics} devMode />)
  expect(screen.queryByText(/replays your stored session cookie/i)).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: /under the hood/i }))

  expect(screen.getByText(/replays your stored session cookie/i)).toBeInTheDocument()
  expect(screen.getByText('sentry.io')).toBeInTheDocument()
})

test('erase needs a confirming second click before firing onEraseData', async () => {
  const onEraseData = vi.fn()

  render(<ServiceSettingsPanel {...baseProps} onEraseData={onEraseData} />)

  const btn = screen.getByRole('button', { name: /erase stored data/i })

  await userEvent.click(btn)
  expect(onEraseData).not.toHaveBeenCalled() // first click only arms it

  await userEvent.click(screen.getByRole('button', { name: /click again to confirm/i }))
  expect(onEraseData).toHaveBeenCalledOnce()
})

test('uninstall arms a confirm panel and fires onUninstall without erasing the folder by default', async () => {
  const onUninstall = vi.fn()

  render(<ServiceSettingsPanel {...baseProps} onUninstall={onUninstall} />)

  await userEvent.click(screen.getByRole('button', { name: /^uninstall$/i }))
  // No files on disk → no erase-folder toggle is offered (only the always-present enable switch remains).
  expect(screen.getAllByRole('switch')).toHaveLength(1)

  await userEvent.click(screen.getByRole('button', { name: /confirm uninstall/i }))
  expect(onUninstall).toHaveBeenCalledWith(false)
})

test('uninstall offers an erase-folder toggle when files exist and passes the choice through', async () => {
  const onUninstall = vi.fn()

  render(
    <ServiceSettingsPanel
      {...baseProps}
      folderStats={{ pending: false, fileCount: 12, totalBytes: 4096, documentCount: 3 }}
      onUninstall={onUninstall}
    />
  )

  await userEvent.click(screen.getByRole('button', { name: /^uninstall$/i }))
  // The armed panel adds a second switch (the erase-folder toggle) alongside the enable switch.
  const switches = screen.getAllByRole('switch')

  expect(switches).toHaveLength(2)
  // The label names the downloaded-document count so the user knows what gets removed.
  expect(screen.getByText(/3 downloaded documents/i)).toBeInTheDocument()

  await userEvent.click(switches[1])
  await userEvent.click(screen.getByRole('button', { name: /confirm uninstall/i }))
  expect(onUninstall).toHaveBeenCalledWith(true)
})

test('cancelling an armed uninstall returns to the trigger without firing', async () => {
  const onUninstall = vi.fn()

  render(<ServiceSettingsPanel {...baseProps} onUninstall={onUninstall} />)

  await userEvent.click(screen.getByRole('button', { name: /^uninstall$/i }))
  await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

  expect(onUninstall).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /^uninstall$/i })).toBeInTheDocument()
})

test('hides the move-to-profile control when there are no target profiles', () => {
  render(<ServiceSettingsPanel {...baseProps} />)

  expect(screen.queryByRole('button', { name: /move to another profile/i })).not.toBeInTheDocument()
})

test('picking a target profile then confirming fires onMoveToProfile with its id', () => {
  const onMoveToProfile = vi.fn()

  render(
    <ServiceSettingsPanel
      {...baseProps}
      moveTargets={[
        { id: 'work', name: 'Work' },
        { id: 'side', name: 'Side' }
      ]}
      onMoveToProfile={onMoveToProfile}
    />
  )

  // Open the plain menu and pick a profile — this only arms an explicit confirm, no move yet.
  fireEvent.click(screen.getByRole('button', { name: /move to another profile/i }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }))
  expect(onMoveToProfile).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: /confirm move to work/i }))
  expect(onMoveToProfile).toHaveBeenCalledWith('work')
})

test('cancelling a pending move returns to the trigger without firing', () => {
  const onMoveToProfile = vi.fn()

  render(
    <ServiceSettingsPanel
      {...baseProps}
      moveTargets={[{ id: 'work', name: 'Work' }]}
      onMoveToProfile={onMoveToProfile}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: /move to another profile/i }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }))
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

  expect(onMoveToProfile).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /move to another profile/i })).toBeInTheDocument()
})

test('shows an Open dashboard link when dashboardUrl is set and fires onOpenDashboard', async () => {
  const onOpenDashboard = vi.fn()

  render(<ServiceSettingsPanel {...baseProps} dashboardUrl="https://sentry.io" onOpenDashboard={onOpenDashboard} />)

  await userEvent.click(screen.getByRole('button', { name: /open dashboard/i }))
  expect(onOpenDashboard).toHaveBeenCalledOnce()
})

test('omits the Open dashboard link when dashboardUrl is absent', () => {
  render(<ServiceSettingsPanel {...baseProps} />)

  expect(screen.queryByRole('button', { name: /open dashboard/i })).not.toBeInTheDocument()
})

test('clicking the output folder path reveals it', async () => {
  const onRevealFolder = vi.fn()

  render(<ServiceSettingsPanel {...baseProps} folderPath="/home/you/butin/serper" onRevealFolder={onRevealFolder} />)

  await userEvent.click(screen.getByRole('button', { name: /butin\/serper/i }))
  expect(onRevealFolder).toHaveBeenCalledOnce()
})

const ledgerInventory = [{ id: 'usage', label: 'Usage', recordCount: 2, snapshotCount: 1 }]

const sampleLedger = {
  schemaVersion: 1,
  datasets: [
    {
      id: 'members',
      key: 'email',
      columns: [
        { key: 'spend', role: 'money' as const, accrual: 'cumulative' as const, resetPeriod: 'monthly' as const }
      ],
      rows: [
        {
          id: 'a@x.com',
          firstSeen: '2026-06-15T10:00:00.000Z',
          seenTo: '2026-06-17T10:00:00.000Z',
          versions: [
            { from: '2026-06-15T10:00:00.000Z', to: '2026-06-16T10:00:00.000Z', data: { email: 'a@x.com', spend: 1 } },
            { from: '2026-06-16T10:00:00.000Z', data: { email: 'a@x.com', spend: 4 } }
          ]
        }
      ]
    }
  ],
  series: [{ section: 'spend' as const, points: [{ capturedAt: '2026-06-17T10:00:00.000Z', value: 4 }] }]
}

test('the ledger debug panel is hidden unless developer mode is on', () => {
  const { rerender } = render(<ServiceSettingsPanel {...baseProps} inventory={ledgerInventory} />)

  expect(screen.queryByRole('button', { name: /ledger \(debug\)/i })).not.toBeInTheDocument()

  rerender(<ServiceSettingsPanel {...baseProps} inventory={ledgerInventory} devMode />)
  expect(screen.getByRole('button', { name: /ledger \(debug\)/i })).toBeInTheDocument()
})

test('expanding a capability loads its ledger lazily and renders the datasets, series, and row history', async () => {
  const onLoadLedger = vi.fn()
  const { rerender } = render(
    <ServiceSettingsPanel {...baseProps} inventory={ledgerInventory} devMode onLoadLedger={onLoadLedger} />
  )

  // Section collapsed → capability rows hidden until the section is opened.
  await userEvent.click(screen.getByRole('button', { name: /ledger \(debug\)/i }))

  // Expanding the capability requests its ledger (nothing cached yet) and shows the loading state.
  await userEvent.click(screen.getByRole('button', { name: /^usage$/i }))
  expect(onLoadLedger).toHaveBeenCalledWith('usage')
  expect(screen.getByText(/loading/i)).toBeInTheDocument()

  // Host resolves the fetch → the loaded ledger renders datasets + the row + the series headline.
  rerender(
    <ServiceSettingsPanel
      {...baseProps}
      inventory={ledgerInventory}
      devMode
      onLoadLedger={onLoadLedger}
      ledgers={{ usage: sampleLedger }}
    />
  )

  expect(screen.getByText('a@x.com')).toBeInTheDocument()
  expect(screen.getByText(/spend/)).toBeInTheDocument()

  // Clicking the row reveals its raw version history (the changed value 1 → 4 lives in the JSON dump) plus the
  // derived per-day readout for the cumulative column (so an empty trend's cause is visible).
  await userEvent.click(screen.getByText('a@x.com'))
  expect(screen.getByText(/"spend": 4/)).toBeInTheDocument()
  expect(screen.getByText(/derived daily/i)).toBeInTheDocument()
})

test('a capability whose ledger loaded empty shows the no-data message', async () => {
  render(
    <ServiceSettingsPanel
      {...baseProps}
      inventory={ledgerInventory}
      devMode
      ledgers={{ usage: null }}
      onLoadLedger={vi.fn()}
    />
  )

  await userEvent.click(screen.getByRole('button', { name: /ledger \(debug\)/i }))
  await userEvent.click(screen.getByRole('button', { name: /^usage$/i }))

  expect(screen.getByText(/no ledger recorded yet/i)).toBeInTheDocument()
})
