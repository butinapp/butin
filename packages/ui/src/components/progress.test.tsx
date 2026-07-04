import { render } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Progress } from './progress.js'

test('renders a progressbar with the rounded percent + fill width', () => {
  const { getByRole } = render(<Progress value={0.52} />)
  const bar = getByRole('progressbar')

  expect(bar).toHaveAttribute('aria-valuenow', '52')
  expect(bar.firstChild).toHaveStyle({ width: '52%' })
})

test('clamps out-of-range values to [0, 100]', () => {
  const over = render(<Progress value={1.5} />)

  expect(over.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  over.unmount()

  expect(render(<Progress value={-1} />).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
})
