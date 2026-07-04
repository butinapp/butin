import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RefreshProgress, type RefreshProgressItem } from './refresh-progress.js'

const items: RefreshProgressItem[] = [
  { id: 'billing', label: 'Billing', status: 'done' },
  { id: 'usage', label: 'Usage', status: 'error', error: '403 Forbidden' },
  { id: 'members', label: 'Members', status: 'pending' }
]

describe('RefreshProgress', () => {
  it('renders a row per capability with the count and inline error', () => {
    render(<RefreshProgress items={items} />)

    expect(screen.getByText('Billing')).toBeInTheDocument()
    expect(screen.getByText('Usage')).toBeInTheDocument()
    expect(screen.getByText('Members')).toBeInTheDocument()
    expect(screen.getByText('403 Forbidden')).toBeInTheDocument()
    // One of three done.
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('renders nothing when empty', () => {
    const { container } = render(<RefreshProgress items={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows a dismiss button only when onDismiss is provided and calls it', async () => {
    const user = userEvent.setup()

    expect(render(<RefreshProgress items={items} />).queryByLabelText('Dismiss')).not.toBeInTheDocument()

    const onDismiss = vi.fn()

    render(<RefreshProgress items={items} onDismiss={onDismiss} />)
    await user.click(screen.getByLabelText('Dismiss'))

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
