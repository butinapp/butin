import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProfileSwitcher } from './profile-switcher.js'

const profiles = [
  { id: 'personal', name: 'Personal', active: true, encryption: 'off' as const },
  { id: 'work', name: 'Work', active: false, encryption: 'off' as const }
]

describe('ProfileSwitcher', () => {
  it('shows the active profile name', () => {
    render(<ProfileSwitcher profiles={profiles} onSwitch={() => {}} onManage={() => {}} />)

    expect(screen.getByRole('button', { name: /Personal/ })).toBeInTheDocument()
  })

  it('fires onSwitch with the chosen id', () => {
    const onSwitch = vi.fn()

    render(<ProfileSwitcher profiles={profiles} onSwitch={onSwitch} onManage={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Personal/ }))
    fireEvent.click(screen.getByText('Work'))

    expect(onSwitch).toHaveBeenCalledWith('work')
  })

  it('fires onManage', () => {
    const onManage = vi.fn()

    render(<ProfileSwitcher profiles={profiles} onSwitch={() => {}} onManage={onManage} />)
    fireEvent.click(screen.getByRole('button', { name: /Personal/ }))
    fireEvent.click(screen.getByText(/Manage profiles/i))

    expect(onManage).toHaveBeenCalled()
  })
})
