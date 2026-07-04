import type { ConfigOption } from '@butinapp/sdk'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { Combobox } from './combobox.js'

const opts: ConfigOption[] = [
  { value: 'p', label: 'Personal', description: 'p' },
  { value: 't', label: 'Acme Team', description: 't', recommended: true }
]

test('renders the selected option by label, not the raw value', () => {
  render(<Combobox value="t" options={opts} onValueChange={vi.fn()} />)

  expect(screen.getByRole('button')).toHaveTextContent('Acme Team')
})

test('falls back to the raw value when no option matches (cold cache shows the id)', () => {
  render(<Combobox value="unknown-id" options={[]} onValueChange={vi.fn()} />)

  expect(screen.getByRole('button')).toHaveTextContent('unknown-id')
})

test('opening fires onOpen and picking an option calls onValueChange', async () => {
  const onValueChange = vi.fn()
  const onOpen = vi.fn()

  render(<Combobox value="" options={opts} onValueChange={onValueChange} onOpen={onOpen} placeholder="Pick…" />)

  await userEvent.click(screen.getByRole('button'))
  expect(onOpen).toHaveBeenCalled()

  await userEvent.click(screen.getByText('Acme Team'))
  expect(onValueChange).toHaveBeenCalledWith('t')
})

test('free-text: typing an unknown id offers a Use row that selects the literal value', async () => {
  const onValueChange = vi.fn()

  render(<Combobox value="" options={opts} onValueChange={onValueChange} />)

  await userEvent.click(screen.getByRole('button'))
  await userEvent.type(screen.getByPlaceholderText('Search…'), 'raw-123')
  await userEvent.click(screen.getByText('raw-123'))

  expect(onValueChange).toHaveBeenCalledWith('raw-123')
})
