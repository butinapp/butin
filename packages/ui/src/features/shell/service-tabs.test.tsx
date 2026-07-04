import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'

import { ServiceTabs, type ServiceTab } from './service-tabs.js'

const tabs: ServiceTab[] = [
  { capability: { id: 'billing', label: 'Billing' }, body: <p>billing body</p> },
  { capability: { id: 'usage', label: 'Usage' }, body: <p>usage body</p> }
]

test('renders one tab per capability and only the active body', () => {
  render(<ServiceTabs tabs={tabs} active="billing" onSelect={() => {}} />)

  expect(screen.getByRole('tab', { name: 'Billing' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Usage' })).toBeInTheDocument()
  expect(screen.getByText('billing body')).toBeInTheDocument()
  expect(screen.queryByText('usage body')).not.toBeInTheDocument()
})

test('emits the capability id when another tab is picked', async () => {
  const onSelect = vi.fn()

  render(<ServiceTabs tabs={tabs} active="billing" onSelect={onSelect} />)

  await userEvent.click(screen.getByRole('tab', { name: 'Usage' }))
  expect(onSelect).toHaveBeenCalledWith('usage')
})

test('falls back to the first tab when the active id is unknown', () => {
  render(<ServiceTabs tabs={tabs} active="ghost" onSelect={() => {}} />)

  expect(screen.getByText('billing body')).toBeInTheDocument()
})

test('renders nothing when there are no tabs', () => {
  const { container } = render(<ServiceTabs tabs={[]} active="billing" onSelect={() => {}} />)

  expect(container).toBeEmptyDOMElement()
})

test('renders a trailing tab right-aligned with its icon and selects it', async () => {
  const onSelect = vi.fn()
  const withSettings: ServiceTab[] = [
    ...tabs,
    {
      capability: { id: '__settings', label: 'Settings' },
      body: <p>settings body</p>,
      trailing: true,
      icon: <span data-testid="gear" />
    }
  ]

  render(<ServiceTabs tabs={withSettings} active="billing" onSelect={onSelect} />)

  const settings = screen.getByRole('tab', { name: 'Settings' })

  expect(settings).toHaveClass('ml-auto')
  expect(screen.getByTestId('gear')).toBeInTheDocument()

  await userEvent.click(settings)
  expect(onSelect).toHaveBeenCalledWith('__settings')
})

// Captures its mount-time prop into state. If the body instance is reused across a tab switch (same
// component type at the same position, no key), the captured value stays stale — the data-bleed bug.
const MountLabel = ({ label }: { label: string }) => {
  const [mounted] = useState(label)

  return <p>mounted-with: {mounted}</p>
}

test('remounts the active body across tab changes so per-tab state never bleeds', () => {
  const stateful: ServiceTab[] = [
    { capability: { id: 'billing', label: 'Billing' }, body: <MountLabel label="billing" /> },
    { capability: { id: 'usage', label: 'Usage' }, body: <MountLabel label="usage" /> }
  ]

  const { rerender } = render(<ServiceTabs tabs={stateful} active="billing" onSelect={() => {}} />)

  expect(screen.getByText('mounted-with: billing')).toBeInTheDocument()

  // Switching tabs must mount a FRESH usage body — not reuse the billing instance (which would keep
  // showing 'billing', the symptom of a just-refreshed tab's data sticking after you switch).
  rerender(<ServiceTabs tabs={stateful} active="usage" onSelect={() => {}} />)
  expect(screen.getByText('mounted-with: usage')).toBeInTheDocument()
})
