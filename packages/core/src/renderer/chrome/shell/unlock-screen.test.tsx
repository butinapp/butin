import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UnlockScreen, type UnlockProfile } from './unlock-screen.js'

const profiles: UnlockProfile[] = [
  { id: 'personal', name: 'Personal', active: true, encryption: 'locked' },
  { id: 'work', name: 'Work', active: false, encryption: 'unlocked' }
]

describe('UnlockScreen', () => {
  it('unlocks with the typed secret', () => {
    const onUnlock = vi.fn()

    render(<UnlockScreen profiles={profiles} onUnlock={onUnlock} onSwitchProfile={() => {}} />)
    fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: /^unlock$/i }))

    expect(onUnlock).toHaveBeenCalledWith('hunter2')
  })

  it('shows the error message on a failed unlock', () => {
    render(<UnlockScreen profiles={profiles} onUnlock={() => {}} onSwitchProfile={() => {}} error />)

    expect(screen.getByText(/incorrect password or recovery key/i)).toBeInTheDocument()
  })

  it('toggles to the recovery-key field', () => {
    render(<UnlockScreen profiles={profiles} onUnlock={() => {}} onSwitchProfile={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /use recovery key/i }))

    expect(screen.getByLabelText(/recovery key/i)).toBeInTheDocument()
  })

  it('switches to another profile', () => {
    const onSwitchProfile = vi.fn()

    render(<UnlockScreen profiles={profiles} onUnlock={() => {}} onSwitchProfile={onSwitchProfile} />)
    fireEvent.click(screen.getByRole('button', { name: /Work/ }))

    expect(onSwitchProfile).toHaveBeenCalledWith('work')
  })
})
