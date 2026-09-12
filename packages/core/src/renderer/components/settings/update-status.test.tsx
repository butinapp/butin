import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { UpdateStatus } from './update-status.js'

describe('UpdateStatus', () => {
  it('idle offers a check and nothing else', async () => {
    const user = userEvent.setup()
    const onCheck = vi.fn()

    render(<UpdateStatus state={{ kind: 'idle' }} onCheck={onCheck} onInstall={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(onCheck).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Restart to update' })).not.toBeInTheDocument()
  })

  it('a running check disables the button and says so', () => {
    render(<UpdateStatus state={{ kind: 'checking' }} onCheck={vi.fn()} onInstall={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
    expect(screen.getByText('Checking…')).toBeInTheDocument()
  })

  it('a download shows its version and progress', () => {
    render(
      <UpdateStatus
        state={{ kind: 'downloading', version: '0.3.0', percent: 44 }}
        onCheck={vi.fn()}
        onInstall={vi.fn()}
      />
    )

    expect(screen.getByText('Downloading 0.3.0… 44%')).toBeInTheDocument()
  })

  it('a ready update swaps the check for a restart', async () => {
    const user = userEvent.setup()
    const onInstall = vi.fn()

    render(<UpdateStatus state={{ kind: 'ready', version: '0.3.0' }} onCheck={vi.fn()} onInstall={onInstall} />)
    await user.click(screen.getByRole('button', { name: 'Restart to update' }))

    expect(onInstall).toHaveBeenCalledOnce()
    expect(screen.getByText('Butin 0.3.0 is ready')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument()
  })

  it('an error shows its message and keeps the check available', () => {
    render(<UpdateStatus state={{ kind: 'error', message: 'net::ERR_FAILED' }} onCheck={vi.fn()} onInstall={vi.fn()} />)

    expect(screen.getByText('Update check failed: net::ERR_FAILED')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it('an unupdatable run hides the check and explains', () => {
    render(<UpdateStatus state={{ kind: 'unavailable', reason: 'dev' }} onCheck={vi.fn()} onInstall={vi.fn()} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('Updates apply to the installed app only.')).toBeInTheDocument()
  })
})
