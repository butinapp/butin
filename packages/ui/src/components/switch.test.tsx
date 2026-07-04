import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { Switch } from './switch.js'

test('renders an unchecked switch by default', () => {
  render(<Switch aria-label="enabled" />)

  const sw = screen.getByRole('switch', { name: 'enabled' })

  expect(sw).toHaveAttribute('data-slot', 'switch')
  expect(sw).toHaveAttribute('aria-checked', 'false')
})

test('reflects the checked prop', () => {
  render(<Switch aria-label="enabled" checked onCheckedChange={() => {}} />)

  expect(screen.getByRole('switch', { name: 'enabled' })).toHaveAttribute('aria-checked', 'true')
})

test('fires onCheckedChange when toggled', async () => {
  const onCheckedChange = vi.fn()

  render(<Switch aria-label="enabled" onCheckedChange={onCheckedChange} />)

  await userEvent.click(screen.getByRole('switch', { name: 'enabled' }))
  expect(onCheckedChange).toHaveBeenCalledWith(true)
})

test('does not toggle when disabled', async () => {
  const onCheckedChange = vi.fn()

  render(<Switch aria-label="enabled" disabled onCheckedChange={onCheckedChange} />)

  await userEvent.click(screen.getByRole('switch', { name: 'enabled' }))
  expect(onCheckedChange).not.toHaveBeenCalled()
})
