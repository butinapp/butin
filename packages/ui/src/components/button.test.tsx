import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'

import { Button } from './button.js'

test('renders its children as a button with the default variant classes', () => {
  render(<Button>Lift</Button>)

  const btn = screen.getByRole('button', { name: 'Lift' })

  expect(btn).toBeInTheDocument()
  expect(btn).toHaveClass('bg-primary')
  expect(btn).toHaveAttribute('data-slot', 'button')
})

test('applies the requested variant and size classes', () => {
  render(
    <Button variant="destructive" size="sm">
      Disconnect
    </Button>
  )

  const btn = screen.getByRole('button', { name: 'Disconnect' })

  expect(btn).toHaveClass('bg-destructive')
  expect(btn).toHaveClass('h-8')
})

test('fires onClick when pressed', async () => {
  const onClick = vi.fn()

  render(<Button onClick={onClick}>Refresh</Button>)

  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(onClick).toHaveBeenCalledOnce()
})

// `ref` is a plain prop (no forwardRef) and must still reach the underlying element.
test('forwards ref to the underlying button element', () => {
  const ref = createRef<HTMLButtonElement>()

  render(<Button ref={ref}>Save</Button>)

  expect(ref.current).toBeInstanceOf(HTMLButtonElement)
  expect(ref.current?.textContent).toBe('Save')
})

// asChild merges Button's styling onto the child element (Radix Slot) instead of rendering a <button>.
test('asChild renders the child element with the button classes', () => {
  render(
    <Button asChild>
      <a href="https://butin.app">Home</a>
    </Button>
  )

  const link = screen.getByRole('link', { name: 'Home' })

  expect(link).toHaveClass('bg-primary')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
