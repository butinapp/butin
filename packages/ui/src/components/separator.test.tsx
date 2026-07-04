import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Separator } from './separator.js'

test('is decorative (no separator role) and horizontal by default', () => {
  const { container } = render(<Separator />)

  const sep = container.querySelector('[data-slot="separator"]')

  expect(sep).toHaveAttribute('data-orientation', 'horizontal')
  // decorative separators are hidden from the accessibility tree.
  expect(screen.queryByRole('separator')).not.toBeInTheDocument()
})

test('exposes a separator role with the given orientation when not decorative', () => {
  render(<Separator decorative={false} orientation="vertical" />)

  const sep = screen.getByRole('separator')

  expect(sep).toHaveAttribute('data-orientation', 'vertical')
  expect(sep).toHaveAttribute('aria-orientation', 'vertical')
})
