import { render } from '@testing-library/react'
import { expect, test } from 'vitest'

import { ServiceIcon, ServiceIconProvider } from './service-icon.js'

const DATA_URI = 'data:image/svg+xml;base64,PHN2Zy8+'

test('renders a custom icon as an img when one is supplied', () => {
  const { container } = render(<ServiceIcon icon={DATA_URI} name="Sentry" size={24} />)

  const img = container.querySelector('img')

  expect(img).not.toBeNull()
  expect(img).toHaveAttribute('src', DATA_URI)
  expect(img).toHaveAttribute('width', '24')
  expect(img).toHaveAttribute('height', '24')
})

test('renders a brand-colored letter monogram from the name when no icon is supplied', () => {
  const { container } = render(<ServiceIcon name="sentry" color="#ff0000" size={16} />)

  expect(container.querySelector('img')).toBeNull()
  const box = container.querySelector('span')

  expect(box).toHaveTextContent('S') // first initial, uppercased
  expect(box).toHaveStyle({ width: '16px', height: '16px', backgroundColor: '#ff0000' })
  // Decorative — the visible name text carries the accessible label, so the monogram is hidden from it.
  expect(box).toHaveAttribute('aria-hidden', 'true')
})

test('falls back to a dot when neither icon nor name is supplied', () => {
  const { container } = render(<ServiceIcon />)

  const dot = container.querySelectorAll('span')[1]

  expect(dot).toHaveStyle({ backgroundColor: 'var(--border)' })
})

test('a ServiceIconProvider resolver draws its own node, keyed by id, sized to the box', () => {
  const { container } = render(
    <ServiceIconProvider resolve={({ id }, size) => <img src={`/logos/${id}.svg`} data-size={size} alt="" />}>
      <ServiceIcon id="acme" name="Acme" color="#ff0000" size={24} />
    </ServiceIconProvider>
  )

  const img = container.querySelector('img')

  expect(img).toHaveAttribute('src', '/logos/acme.svg')
  expect(img).toHaveAttribute('data-size', '24')
  // No monogram glyph — the resolved node replaced it; the box still constrains to size×size.
  expect(container).not.toHaveTextContent('A')
  expect(container.querySelector('span')).toHaveStyle({ width: '24px', height: '24px' })
})

test('a resolver returning a falsy value falls through to the default monogram', () => {
  const { container } = render(
    <ServiceIconProvider resolve={() => undefined}>
      <ServiceIcon id="acme" name="Acme" color="#ff0000" size={16} />
    </ServiceIconProvider>
  )

  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('span')).toHaveTextContent('A')
})
