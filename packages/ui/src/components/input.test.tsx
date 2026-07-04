import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { Input } from './input.js'

test('forwards type and placeholder and tags itself as an input slot', () => {
  render(<Input type="email" placeholder="you@example.com" />)

  const input = screen.getByPlaceholderText('you@example.com')

  expect(input).toHaveAttribute('type', 'email')
  expect(input).toHaveAttribute('data-slot', 'input')
})

test('fires onChange for each typed character', async () => {
  const onChange = vi.fn()

  render(<Input onChange={onChange} aria-label="cookie" />)

  await userEvent.type(screen.getByLabelText('cookie'), 'abc')
  expect(onChange).toHaveBeenCalledTimes(3)
})

test('does not accept input when disabled', async () => {
  const onChange = vi.fn()

  render(<Input disabled onChange={onChange} aria-label="cookie" />)

  const input = screen.getByLabelText('cookie')

  expect(input).toBeDisabled()
  await userEvent.type(input, 'abc')
  expect(onChange).not.toHaveBeenCalled()
})
