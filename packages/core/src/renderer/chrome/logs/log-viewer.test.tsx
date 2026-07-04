import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { LogViewer, type LogViewerEntry } from './log-viewer.js'

const entries: LogViewerEntry[] = [
  { seq: 1, ts: '2026-06-15T10:00:01.000Z', level: 'info', scope: 'main', message: 'app started' },
  {
    seq: 2,
    ts: '2026-06-15T10:00:02.000Z',
    level: 'debug',
    plugin: 'groq',
    action: 'usage',
    message: 'fetching usage'
  },
  {
    seq: 3,
    ts: '2026-06-15T10:00:03.000Z',
    level: 'error',
    plugin: 'groq',
    action: 'billing',
    message: 'rate limited',
    data: { retryAfter: 30 }
  }
]

const renderViewer = (overrides: Partial<Parameters<typeof LogViewer>[0]> = {}) =>
  render(<LogViewer entries={entries} onClear={vi.fn()} onReveal={vi.fn()} {...overrides} />)

test('renders every entry with its message and origin chip', () => {
  renderViewer()

  expect(screen.getByText('app started')).toBeInTheDocument()
  expect(screen.getByText('fetching usage')).toBeInTheDocument()
  expect(screen.getByText('rate limited')).toBeInTheDocument()
  expect(screen.getAllByText('groq').length).toBeGreaterThan(0)
})

test('toggling off a display level hides those rows without touching the others', async () => {
  renderViewer()

  await userEvent.click(screen.getByRole('button', { name: 'debug', pressed: true }))

  expect(screen.queryByText('fetching usage')).not.toBeInTheDocument()
  expect(screen.getByText('app started')).toBeInTheDocument()
})

test('search filters by message text', async () => {
  renderViewer()

  await userEvent.type(screen.getByPlaceholderText('Search messages…'), 'rate')

  expect(screen.getByText('rate limited')).toBeInTheDocument()
  expect(screen.queryByText('app started')).not.toBeInTheDocument()
})

test('clicking a row with data expands its structured payload', async () => {
  renderViewer()

  expect(screen.queryByText(/retryAfter/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('rate limited'))

  expect(screen.getByText(/retryAfter/)).toBeInTheDocument()
})

test('Clear fires the host callback', async () => {
  const onClear = vi.fn()

  renderViewer({ onClear })
  await userEvent.click(screen.getByTitle('Clear'))

  expect(onClear).toHaveBeenCalledOnce()
})
