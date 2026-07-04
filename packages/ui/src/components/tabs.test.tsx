import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js'

const Fixture = () => (
  <Tabs defaultValue="a">
    <TabsList>
      <TabsTrigger value="a">A</TabsTrigger>
      <TabsTrigger value="b">B</TabsTrigger>
    </TabsList>
    <TabsContent value="a">panel a</TabsContent>
    <TabsContent value="b">panel b</TabsContent>
  </Tabs>
)

test('shows the default tab panel and marks its trigger selected', () => {
  render(<Fixture />)

  expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('panel a')).toBeInTheDocument()
  expect(screen.queryByText('panel b')).not.toBeInTheDocument()
})

test('switches the visible panel when another trigger is clicked', async () => {
  render(<Fixture />)

  await userEvent.click(screen.getByRole('tab', { name: 'B' }))
  expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('panel b')).toBeInTheDocument()
  expect(screen.queryByText('panel a')).not.toBeInTheDocument()
})

test('the list carries its variant as a data attribute', () => {
  render(
    <Tabs defaultValue="a">
      <TabsList variant="line">
        <TabsTrigger value="a">A</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  expect(screen.getByRole('tablist')).toHaveAttribute('data-variant', 'line')
})
