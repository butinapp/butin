import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ManageProfiles, type ManageProfileRow } from './manage-profiles.js'

const profiles: ManageProfileRow[] = [
  { id: 'personal', name: 'Personal', active: true, encryption: 'off' },
  { id: 'work', name: 'Work', active: false, encryption: 'off' }
]

const noopEncryption = () => ({
  onEnable: async () => null,
  onLock: () => {},
  onChangePassword: async () => false,
  onResetViaRecovery: async () => false,
  onDisable: async () => false
})

const base = {
  onCreate: () => {},
  onRename: () => {},
  onDelete: () => {},
  onSwitch: () => {},
  onDuplicate: () => {},
  onRecolor: () => {}
}

const openMenu = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${name} actions`, 'i') }))
}

describe('ManageProfiles', () => {
  it('switches when an inactive card is clicked', () => {
    const onSwitch = vi.fn()

    render(<ManageProfiles {...base} profiles={profiles} onSwitch={onSwitch} />)
    fireEvent.click(screen.getByRole('button', { name: /Switch to Work/i }))

    expect(onSwitch).toHaveBeenCalledWith('work')
  })

  it('does not offer the active profile as a switch target', () => {
    render(<ManageProfiles {...base} profiles={profiles} />)

    expect(screen.queryByRole('button', { name: /Switch to Personal/i })).toBeNull()
    expect(screen.getByText(/Current/i)).toBeInTheDocument()
  })

  it('creates a profile from the input', () => {
    const onCreate = vi.fn()

    render(<ManageProfiles {...base} profiles={profiles} onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText(/New profile name/i), { target: { value: 'Side' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    expect(onCreate).toHaveBeenCalledWith('Side')
  })

  it('renames via the menu then save', () => {
    const onRename = vi.fn()

    render(<ManageProfiles {...base} profiles={profiles} onRename={onRename} />)
    openMenu('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/i }))
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Work 2' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    expect(onRename).toHaveBeenCalledWith('work', 'Work 2')
  })

  it('duplicates from the menu', () => {
    const onDuplicate = vi.fn()

    render(<ManageProfiles {...base} profiles={profiles} onDuplicate={onDuplicate} />)
    openMenu('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/i }))

    expect(onDuplicate).toHaveBeenCalledWith('work')
  })

  it('disables duplicate for a locked profile', () => {
    const onDuplicate = vi.fn()
    const locked: ManageProfileRow[] = [profiles[0]!, { id: 'work', name: 'Work', active: false, encryption: 'locked' }]

    render(<ManageProfiles {...base} profiles={locked} onDuplicate={onDuplicate} />)
    openMenu('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/i }))

    expect(onDuplicate).not.toHaveBeenCalled()
  })

  it('recolors from the menu color picker', () => {
    const onRecolor = vi.fn()

    render(<ManageProfiles {...base} profiles={profiles} onRecolor={onRecolor} />)
    openMenu('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: /Color/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /Color for Work/i })[0]!)

    expect(onRecolor).toHaveBeenCalledWith('work', expect.stringMatching(/^#/))
  })

  it('requires two steps to delete', () => {
    const onDelete = vi.fn()

    render(<ManageProfiles {...base} profiles={profiles} onDelete={onDelete} />)
    openMenu('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: /^Delete$/i }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete/i }))
    expect(onDelete).toHaveBeenCalledWith('work')
  })

  it('disables delete when only one profile remains', () => {
    render(<ManageProfiles {...base} profiles={[profiles[0]!]} />)
    openMenu('Personal')

    expect(screen.getByRole('menuitem', { name: /^Delete$/i })).toHaveAttribute('aria-disabled', 'true')
  })

  it('truncates a long profile name rather than overflowing the row', () => {
    const longName = 'a'.repeat(120)
    const rows: ManageProfileRow[] = [profiles[0]!, { id: 'work', name: longName, active: false, encryption: 'off' }]

    render(<ManageProfiles {...base} profiles={rows} />)
    const button = screen.getByRole('button', { name: new RegExp(`Switch to ${longName}`) })

    expect(button).toHaveClass('min-w-0')
    expect(button.querySelector('.truncate')).not.toBeNull()
  })

  it('renders the actions menu outside the scrollable list so it cannot clip', () => {
    render(<ManageProfiles {...base} profiles={profiles} />)
    openMenu('Work')

    const menu = screen.getByRole('menu')

    expect(screen.getByRole('list')).not.toContainElement(menu)
    // The dialog host is a modal (body pointer-events: none); the portaled menu must re-enable pointer events
    // or it's click-dead and hover bleeds to the rows beneath.
    expect(menu).toHaveClass('pointer-events-auto')
  })

  it('keeps encryption controls behind the menu, hidden by default', () => {
    render(<ManageProfiles {...base} profiles={profiles} encryptionActions={noopEncryption} />)

    expect(screen.queryByRole('button', { name: /Encrypt this profile/i })).toBeNull()

    openMenu('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: /Encryption/i }))

    expect(screen.getByRole('button', { name: /Encrypt this profile/i })).toBeInTheDocument()
  })
})
