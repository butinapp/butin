import { en, LabelsProvider } from '@butinapp/ui/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ExportDialog, type ExportServiceRow } from './export-dialog.js'

const wrap = (ui: ReactNode) => render(<LabelsProvider value={en}>{ui}</LabelsProvider>)

const services: ExportServiceRow[] = [
  { id: 'sentry', name: 'Sentry', hasData: true },
  { id: 'vercel', name: 'Vercel', hasData: false }
]

const renderDialog = (props: Partial<Parameters<typeof ExportDialog>[0]> = {}) =>
  wrap(
    <ExportDialog
      open
      onOpenChange={vi.fn()}
      services={services}
      profileEncrypted={false}
      running={false}
      onPickDestination={vi.fn()}
      onExport={vi.fn()}
      {...props}
    />
  )

describe('ExportDialog', () => {
  it('selects only services with cached data by default and exports their ids', () => {
    const onExport = vi.fn()

    renderDialog({ onExport })
    fireEvent.click(screen.getByRole('button', { name: en.exportButton }))

    expect(onExport).toHaveBeenCalledWith({ serviceIds: ['sentry'], encrypt: false })
  })

  it('disables the no-data row and labels it', () => {
    renderDialog()

    expect(screen.getByText(en.exportNoData)).toBeInTheDocument()
  })

  it('shows the plaintext note and no encrypt checkbox on an unencrypted profile', () => {
    renderDialog({ profileEncrypted: false })

    expect(screen.getByText(en.exportPlaintextNote)).toBeInTheDocument()
    expect(screen.queryByText(en.exportEncrypt)).not.toBeInTheDocument()
  })

  it('offers the encrypt checkbox on an encrypted profile and exports the flag', () => {
    const onExport = vi.fn()

    renderDialog({ profileEncrypted: true, onExport })

    const encrypt = screen.getByText(en.exportEncrypt)

    expect(encrypt).toBeInTheDocument()
    fireEvent.click(encrypt)
    fireEvent.click(screen.getByRole('button', { name: en.exportButton }))

    expect(onExport).toHaveBeenCalledWith({ serviceIds: ['sentry'], encrypt: true })
  })

  it('disables Export when nothing is selectable', () => {
    renderDialog({ services: [{ id: 'vercel', name: 'Vercel', hasData: false }] })

    expect(screen.getByRole('button', { name: en.exportButton })).toBeDisabled()
  })

  it('shows the chosen destination and triggers the picker', () => {
    const onPickDestination = vi.fn()

    renderDialog({ destPath: 'C:/Users/me/Downloads/butin.json', onPickDestination })

    expect(screen.getByText('C:/Users/me/Downloads/butin.json')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en.exportChange }))
    expect(onPickDestination).toHaveBeenCalledTimes(1)
  })
})
