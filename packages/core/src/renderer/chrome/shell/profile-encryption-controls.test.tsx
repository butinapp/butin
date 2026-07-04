import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProfileEncryptionControls, type ProfileEncryptionActions } from './profile-encryption-controls.js'

const actions = (over: Partial<ProfileEncryptionActions> = {}): ProfileEncryptionActions => ({
  onEnable: vi.fn(async () => 'RECOVERY-CODE-1234'),
  onLock: vi.fn(),
  onChangePassword: vi.fn(async () => true),
  onResetViaRecovery: vi.fn(async () => true),
  onDisable: vi.fn(async () => true),
  ...over
})

describe('ProfileEncryptionControls', () => {
  it('shows an Encrypt action when off', () => {
    render(<ProfileEncryptionControls state="off" active {...actions()} />)

    expect(screen.getByRole('button', { name: /encrypt this profile/i })).toBeInTheDocument()
  })

  it('enables encryption and reveals the recovery key once', async () => {
    const onEnable = vi.fn(async () => 'RECOVERY-CODE-1234')

    render(<ProfileEncryptionControls state="off" active {...actions({ onEnable })} />)
    fireEvent.click(screen.getByRole('button', { name: /encrypt this profile/i }))
    fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: 'pw' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: /encrypt profile/i }))

    await waitFor(() => expect(onEnable).toHaveBeenCalledWith('pw'))
    expect(screen.getByTestId('recovery-key')).toHaveTextContent('RECOVERY-CODE-1234')
  })

  it('blocks enabling when passwords differ', () => {
    const onEnable = vi.fn(async () => 'x')

    render(<ProfileEncryptionControls state="off" active {...actions({ onEnable })} />)
    fireEvent.click(screen.getByRole('button', { name: /encrypt this profile/i }))
    fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: 'a' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: /encrypt profile/i }))

    expect(onEnable).not.toHaveBeenCalled()
    expect(screen.getByText(/don’t match/i)).toBeInTheDocument()
  })

  it('locks an active unlocked profile', () => {
    const onLock = vi.fn()

    render(<ProfileEncryptionControls state="unlocked" active {...actions({ onLock })} />)
    fireEvent.click(screen.getByRole('button', { name: /^lock$/i }))

    expect(onLock).toHaveBeenCalled()
  })

  it('offers a reset path on a locked profile', () => {
    render(<ProfileEncryptionControls state="locked" active={false} {...actions()} />)

    expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument()
  })

  it('hides management on an unlocked non-active profile', () => {
    render(<ProfileEncryptionControls state="unlocked" active={false} {...actions()} />)

    expect(screen.queryByRole('button', { name: /^lock$/i })).not.toBeInTheDocument()
  })
})
