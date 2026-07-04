import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Label } from './label.js'

test('renders as a label slot', () => {
  render(<Label>Cookie</Label>)

  expect(screen.getByText('Cookie')).toHaveAttribute('data-slot', 'label')
})

test('associates with its control via htmlFor', () => {
  render(
    <>
      <Label htmlFor="cookie">Cookie</Label>
      <input id="cookie" />
    </>
  )

  // getByLabelText only resolves when the label is correctly wired to the input.
  expect(screen.getByLabelText('Cookie')).toBe(document.getElementById('cookie'))
})
