import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card.js'

test('composes its parts with the matching data-slot attributes', () => {
  render(
    <Card>
      <CardHeader>
        <CardTitle>Sentry</CardTitle>
        <CardDescription>error tracking</CardDescription>
      </CardHeader>
      <CardContent>body</CardContent>
      <CardFooter>footer</CardFooter>
    </Card>
  )

  expect(screen.getByText('Sentry')).toHaveAttribute('data-slot', 'card-title')
  expect(screen.getByText('error tracking')).toHaveAttribute('data-slot', 'card-description')
  expect(screen.getByText('body')).toHaveAttribute('data-slot', 'card-content')
  expect(screen.getByText('footer')).toHaveAttribute('data-slot', 'card-footer')
})

test('merges a caller className onto the base card classes', () => {
  const { container } = render(<Card className="border-dashed">x</Card>)

  const card = container.querySelector('[data-slot="card"]')

  expect(card).toHaveClass('border-dashed')
  expect(card).toHaveClass('bg-card')
})
