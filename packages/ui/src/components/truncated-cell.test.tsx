import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { TruncatedCell } from './truncated-cell.js'

const longText = 'Wireless Mouse, USB-C Cable 2m, Mechanical Keyboard, Laptop Stand, Webcam 1080p'

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

test('renders the value ellipsized on one line with a native hover-peek title', () => {
  render(<TruncatedCell text={longText} />)

  const trigger = screen.getByRole('button', { name: longText })

  expect(trigger).toHaveClass('truncate')
  expect(trigger).toHaveAttribute('title', longText)
})

test('renders nothing for empty text', () => {
  const { container } = render(<TruncatedCell text="" />)

  expect(container).toBeEmptyDOMElement()
})

test('opens a popover with the full selectable value on click', () => {
  render(<TruncatedCell text={longText} />)

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: longText }))

  // The full value appears both as the trigger label and inside the popover.
  const dialog = screen.getByRole('dialog')

  expect(dialog).toHaveTextContent(longText)
})

test('copies the full value to the clipboard from the popover', () => {
  render(<TruncatedCell text={longText} />)

  fireEvent.click(screen.getByRole('button', { name: longText }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(longText)
  expect(screen.getByText('Copied')).toBeInTheDocument()
})
