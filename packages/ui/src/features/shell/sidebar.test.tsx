import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { fr, LabelsProvider } from '../../i18n/index.js'

import { Sidebar, type SidebarService } from './sidebar.js'

const services: SidebarService[] = [
  { id: 'sentry', name: 'Sentry', color: '#362d59' },
  { id: 'github', name: 'GitHub' },
  { id: 'groq', name: 'Groq' }
]

const renderSidebar = (overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) => {
  const onSelect = vi.fn()

  render(<Sidebar services={services} active={{ kind: 'overview' }} onSelect={onSelect} {...overrides} />)

  return { onSelect }
}

test('renders the nav links and every service', () => {
  renderSidebar()

  expect(screen.getByRole('button', { name: 'Management' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument()

  for (const s of services) {
    expect(screen.getByRole('button', { name: s.name })).toBeInTheDocument()
  }
})

test('hides Management and/or Developer when their flags are off', () => {
  const { rerender } = render(
    <Sidebar services={services} active={{ kind: 'overview' }} onSelect={() => {}} showDeveloper={false} />
  )

  expect(screen.getByRole('button', { name: 'Management' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Developer' })).not.toBeInTheDocument()

  // Both off (the offline embed): the whole System section, heading included, is gone.
  rerender(
    <Sidebar
      services={services}
      active={{ kind: 'overview' }}
      onSelect={() => {}}
      showManagement={false}
      showDeveloper={false}
    />
  )
  expect(screen.queryByRole('button', { name: 'Management' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Developer' })).not.toBeInTheDocument()
  expect(screen.queryByText('System')).not.toBeInTheDocument()
})

test('shows a Settings action only when onOpenSettings is given, firing it + onNavigate', async () => {
  const onOpenSettings = vi.fn()
  const onNavigate = vi.fn()
  const { rerender } = render(<Sidebar services={services} active={{ kind: 'overview' }} onSelect={() => {}} />)

  expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()

  rerender(
    <Sidebar
      services={services}
      active={{ kind: 'overview' }}
      onSelect={() => {}}
      onOpenSettings={onOpenSettings}
      onNavigate={onNavigate}
    />
  )

  await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(onOpenSettings).toHaveBeenCalledOnce()
  expect(onNavigate).toHaveBeenCalledOnce()
})

test('shows People only when showPeople is set, emitting its target on click', async () => {
  const { onSelect } = renderSidebar()

  expect(screen.queryByRole('button', { name: 'People' })).not.toBeInTheDocument()

  const withPeople = renderSidebar({ showPeople: true })

  await userEvent.click(screen.getByRole('button', { name: 'People' }))
  expect(withPeople.onSelect).toHaveBeenCalledWith({ kind: 'people' })
  expect(onSelect).not.toHaveBeenCalled()
})

test('emits the matching target on click and runs onNavigate after', async () => {
  const onNavigate = vi.fn()
  const { onSelect } = renderSidebar({ onNavigate })

  await userEvent.click(screen.getByRole('button', { name: 'GitHub' }))
  expect(onSelect).toHaveBeenCalledWith({ kind: 'service', serviceId: 'github' })
  expect(onNavigate).toHaveBeenCalledOnce()

  await userEvent.click(screen.getByRole('button', { name: 'Management' }))
  expect(onSelect).toHaveBeenLastCalledWith({ kind: 'management' })

  await userEvent.click(screen.getByRole('button', { name: 'Overview' }))
  expect(onSelect).toHaveBeenLastCalledWith({ kind: 'overview' })
})

test('filters the service list by the search query (case-insensitive)', async () => {
  renderSidebar()

  await userEvent.type(screen.getByPlaceholderText('Search…'), 'git')
  expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Sentry' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Groq' })).not.toBeInTheDocument()
})

test('shows the empty-state when nothing matches', async () => {
  renderSidebar()

  await userEvent.type(screen.getByPlaceholderText('Search…'), 'zzz')
  expect(screen.getByText('No services match')).toBeInTheDocument()
})

test('shows a connection dot (titled by state) only for services that have one', () => {
  const withDots: SidebarService[] = [
    { id: 'sentry', name: 'Sentry', dot: 'connected' },
    { id: 'github', name: 'GitHub', dot: 'unverified' },
    { id: 'groq', name: 'Groq' } // no data → no dot
  ]

  render(<Sidebar services={withDots} active={{ kind: 'overview' }} onSelect={() => {}} />)

  expect(within(screen.getByRole('button', { name: 'Sentry' })).getByTitle('connected')).toBeInTheDocument()
  expect(within(screen.getByRole('button', { name: 'GitHub' })).getByTitle('unverified')).toBeInTheDocument()
  const groq = screen.getByRole('button', { name: 'Groq' })

  expect(within(groq).queryByTitle('connected')).not.toBeInTheDocument()
})

test('a disabled service is listed but inert — no button, a re-enable tooltip, no navigation', async () => {
  const onSelect = vi.fn()
  const withDisabled: SidebarService[] = [
    { id: 'sentry', name: 'Sentry' },
    { id: 'groq', name: 'Groq', disabled: true }
  ]

  render(<Sidebar services={withDisabled} active={{ kind: 'overview' }} onSelect={onSelect} />)

  // Still in the list, but not openable: rendered as an inert row, not a button.
  expect(screen.queryByRole('button', { name: 'Groq' })).not.toBeInTheDocument()
  const row = screen.getByText('Groq').closest('[aria-disabled]')

  expect(row).toHaveAttribute('title', 'Disabled — re-enable in Management')

  await userEvent.click(screen.getByText('Groq'))
  expect(onSelect).not.toHaveBeenCalled()
})

test('renders translated chrome through the LabelsProvider', () => {
  render(
    <LabelsProvider value={fr}>
      <Sidebar services={services} active={{ kind: 'overview' }} onSelect={() => {}} />
    </LabelsProvider>
  )

  expect(screen.getByRole('button', { name: 'Gestion' })).toBeInTheDocument()
  expect(screen.getByPlaceholderText('Rechercher…')).toBeInTheDocument()
})
