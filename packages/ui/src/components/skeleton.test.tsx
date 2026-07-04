import { render } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Skeleton } from './skeleton.js'

test('renders a pulsing placeholder slot and merges caller classes', () => {
  const { container } = render(<Skeleton className="h-4 w-10" />)

  const sk = container.querySelector('[data-slot="skeleton"]')

  expect(sk).toBeInTheDocument()
  expect(sk).toHaveClass('animate-pulse')
  expect(sk).toHaveClass('h-4')
  expect(sk).toHaveClass('w-10')
})
