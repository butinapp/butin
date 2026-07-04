import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Badge } from './badge.js'

test('renders its children with the default variant', () => {
  render(<Badge>Connected</Badge>)

  const badge = screen.getByText('Connected')

  expect(badge).toBeInTheDocument()
  expect(badge).toHaveClass('bg-primary')
  expect(badge).toHaveAttribute('data-slot', 'badge')
})

test('applies the secondary variant classes', () => {
  render(<Badge variant="secondary">Cached</Badge>)

  expect(screen.getByText('Cached')).toHaveClass('bg-secondary')
})

test('merges a caller-supplied className alongside the variant classes', () => {
  render(<Badge className="ml-2">Stale</Badge>)

  const badge = screen.getByText('Stale')

  expect(badge).toHaveClass('ml-2')
  expect(badge).toHaveClass('bg-primary')
})

test('applies soft-fill tone variants (sentiment + categorical)', () => {
  render(
    <>
      <Badge variant="violet">Owner</Badge>
      <Badge variant="success">Member</Badge>
      <Badge variant="neutral">Manager</Badge>
      <Badge variant="danger">Revoked</Badge>
    </>
  )

  expect(screen.getByText('Owner')).toHaveClass('bg-violet-500/15')
  expect(screen.getByText('Member')).toHaveClass('bg-emerald-500/15')
  expect(screen.getByText('Manager')).toHaveClass('bg-muted')
  expect(screen.getByText('Revoked')).toHaveClass('bg-red-500/15')
})
