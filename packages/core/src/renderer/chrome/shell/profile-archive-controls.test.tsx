import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  type ArchivePreviewRow,
  ProfileExportPanel,
  ProfileImportPanel,
  type ProfileArchiveActions
} from './profile-archive-controls.js'

const preview: ArchivePreviewRow = {
  profileName: 'Work',
  appVersion: '0.1.1',
  packedAt: '2026-09-01T12:00:00.000Z',
  fileCount: 42,
  totalBytes: 2048,
  services: ['claude', 'stripe'],
  reHomed: [],
  unreadableSecrets: [],
  sourceEncrypted: false
}

const type = (label: RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('ProfileExportPanel', () => {
  it('refuses to pack until both passphrases match', async () => {
    const onExport = vi.fn()

    render(<ProfileExportPanel profileId="work" onExport={onExport} onClose={() => {}} />)

    type(/^passphrase$/i, 'hunter2')
    type(/confirm passphrase/i, 'hunter3')
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))

    expect(await screen.findByText(/passphrases .*match/i)).toBeInTheDocument()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('reveals the recovery code once the archive is written', async () => {
    const onExport = vi.fn().mockResolvedValue({
      recoveryCode: 'ABCDE-FGHJK-LMNPQ-RSTUV',
      fileCount: 42,
      totalBytes: 2048,
      services: ['claude'],
      reHomed: ['claude'],
      unreadableSecrets: [],
      sourceEncrypted: false
    })

    render(<ProfileExportPanel profileId="work" onExport={onExport} onClose={() => {}} />)

    type(/^passphrase$/i, 'hunter2')
    type(/confirm passphrase/i, 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))

    expect(await screen.findByTestId('recovery-key')).toHaveTextContent('ABCDE-FGHJK-LMNPQ-RSTUV')
    expect(onExport).toHaveBeenCalledWith('work', 'hunter2')
    // Files kept outside the profile were brought back in — the user is told, not left to discover it.
    expect(screen.getByText(/brought back into it/i)).toBeInTheDocument()
  })

  it('closes without claiming success when the save dialog is dismissed', async () => {
    const onClose = vi.fn()

    render(
      <ProfileExportPanel profileId="work" onExport={vi.fn().mockResolvedValue({ canceled: true })} onClose={onClose} />
    )

    type(/^passphrase$/i, 'hunter2')
    type(/confirm passphrase/i, 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.queryByTestId('recovery-key')).not.toBeInTheDocument()
  })
})

describe('ProfileImportPanel', () => {
  const actions = (over: Partial<ProfileArchiveActions> = {}): ProfileArchiveActions => ({
    onExport: vi.fn(),
    onPickArchive: vi.fn().mockResolvedValue('C:/tmp/work.butin'),
    onInspect: vi.fn().mockResolvedValue(preview),
    onImport: vi.fn().mockResolvedValue(preview),
    ...over
  })

  const chooseFile = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: /choose file/i }))
    await screen.findByText('C:/tmp/work.butin')
  }

  it('shows what the archive holds before anything is written', async () => {
    const a = actions()

    render(<ProfileImportPanel actions={a} onClose={() => {}} onImported={() => {}} />)

    await chooseFile()
    type(/^passphrase$/i, 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))

    expect(await screen.findByLabelText(/import as/i)).toHaveValue('Work')
    expect(screen.getByText(/2 services, 42 files/i)).toBeInTheDocument()
    expect(a.onInspect).toHaveBeenCalledWith('C:/tmp/work.butin', 'hunter2')
    // The preview is a read — nothing lands until the second click.
    expect(a.onImport).not.toHaveBeenCalled()
  })

  it('says so when the passphrase does not open the archive', async () => {
    render(
      <ProfileImportPanel
        actions={actions({ onInspect: vi.fn().mockResolvedValue(null) })}
        onClose={() => {}}
        onImported={() => {}}
      />
    )

    await chooseFile()
    type(/^passphrase$/i, 'nope')
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))

    expect(await screen.findByText(/does not open this archive/i)).toBeInTheDocument()
  })

  it('imports on the confirming click and reports the profile that landed', async () => {
    const a = actions()
    const onImported = vi.fn()
    const onClose = vi.fn()

    render(<ProfileImportPanel actions={a} onClose={onClose} onImported={onImported} />)

    await chooseFile()
    type(/^passphrase$/i, 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))
    await screen.findByLabelText(/import as/i)
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))

    await waitFor(() => expect(a.onImport).toHaveBeenCalledWith('C:/tmp/work.butin', 'hunter2', 'Work'))
    expect(onImported).toHaveBeenCalledWith(preview)
    expect(onClose).toHaveBeenCalled()
  })

  it('imports under a name typed in the panel, not the archived one', async () => {
    const a = actions()

    render(<ProfileImportPanel actions={a} onClose={() => {}} onImported={() => {}} />)

    await chooseFile()
    type(/^passphrase$/i, 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))
    await screen.findByLabelText(/import as/i)
    type(/import as/i, 'Old laptop')
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }))

    await waitFor(() => expect(a.onImport).toHaveBeenCalledWith('C:/tmp/work.butin', 'hunter2', 'Old laptop'))
  })
})
