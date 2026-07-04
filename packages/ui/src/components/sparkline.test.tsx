import { render } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Sparkline } from './sparkline.js'

test('renders a polyline path + an end dot for a multi-point series', () => {
  const { container } = render(<Sparkline values={[1, 4, 2, 8]} />)
  const path = container.querySelector('path')

  expect(path).toBeInTheDocument()
  // one move + three line segments for four points
  expect(path?.getAttribute('d')).toMatch(/^M.*L.*L.*L/)
  expect(container.querySelector('circle')).toBeInTheDocument()
})

test('renders nothing for fewer than two finite points', () => {
  expect(render(<Sparkline values={[5]} />).container.querySelector('svg')).toBeNull()
  expect(render(<Sparkline values={[]} />).container.querySelector('svg')).toBeNull()
  expect(render(<Sparkline values={[NaN, Infinity]} />).container.querySelector('svg')).toBeNull()
})

test('a flat series pins to the vertical middle (a baseline, not a spike)', () => {
  const { container } = render(<Sparkline values={[7, 7, 7]} height={20} />)

  // every y coordinate is height/2
  const d = container.querySelector('path')?.getAttribute('d') ?? ''

  expect([...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => m[1])).toEqual(['10.00', '10.00', '10.00'])
})
