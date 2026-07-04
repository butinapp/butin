import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { NotificationBell } from './notification-bell.js'
import type { NotificationView } from './types.js'

const items: NotificationView[] = [
  { id: 'a', createdAt: '', kind: 'change', severity: 'info', read: false },
  { id: 'b', createdAt: '', kind: 'health', severity: 'warning', read: true }
]
const labels = {
  title: 'Notifications',
  empty: 'All clear',
  markAll: 'Mark all read',
  dismiss: 'Dismiss',
  unread: (n: number) => `${n} unread`
}
const props = {
  items,
  format: (n: NotificationView) => ({ title: `T-${n.id}`, body: `B-${n.id}` }),
  onMarkRead: vi.fn(),
  onMarkAll: vi.fn(),
  onDismiss: vi.fn(),
  labels
}

describe('NotificationBell', () => {
  test('shows the unread count badge', () => {
    render(<NotificationBell {...props} />)
    expect(screen.getByText('1')).toBeInTheDocument() // one unread
  })

  test('opening lists items and mark-all fires', () => {
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByText('T-a')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Mark all read'))
    expect(props.onMarkAll).toHaveBeenCalled()
  })

  test('empty state', () => {
    render(<NotificationBell {...props} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByText('All clear')).toBeInTheDocument()
  })

  test('announces the unread count in the trigger label', () => {
    render(<NotificationBell {...props} />)
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument()
  })

  test('caps the unread badge at 9+', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      createdAt: '',
      kind: 'change' as const,
      severity: 'info' as const,
      read: false
    }))

    render(<NotificationBell {...props} items={many} />)
    expect(screen.getByText('9+')).toBeInTheDocument()
  })

  test('dismiss fires for an item', () => {
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0])
    expect(props.onDismiss).toHaveBeenCalled()
  })

  test('Escape closes the popover', () => {
    render(<NotificationBell {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByText('T-a')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('T-a')).not.toBeInTheDocument()
  })

  test('renders a relative timestamp when a formatter is supplied', () => {
    const dated: NotificationView = { ...items[0], createdAt: '2026-06-18T10:00:00Z' }

    render(<NotificationBell {...props} items={[dated]} formatTime={() => '2h ago'} />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByText('2h ago')).toBeInTheDocument()
  })
})
