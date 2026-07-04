import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { TestButton } from './test-button.js'

afterEach(() => vi.useRealTimers())

test('runs the probe and flashes a green check when it passes', async () => {
  const onTest = vi.fn(async () => ({ ok: true }))

  render(<TestButton onTest={onTest} />)
  await userEvent.click(screen.getByRole('button', { name: 'Test' }))

  expect(onTest).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toHaveClass('bg-emerald-600'))
})

test('flashes red when the probe fails', async () => {
  render(<TestButton onTest={async () => ({ ok: false })} />)
  await userEvent.click(screen.getByRole('button', { name: 'Test' }))

  await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toHaveClass('bg-destructive'))
})

test('keeps a failure visible until the next test (a pass auto-reverts)', async () => {
  vi.useFakeTimers()

  render(<TestButton onTest={async () => ({ ok: false })} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test' })))

  expect(screen.getByRole('button', { name: 'Test' })).toHaveClass('bg-destructive')

  // A failure does not self-dismiss — no revert timer was set, so time passing leaves it red.
  await act(async () => vi.advanceTimersByTime(5000))
  expect(screen.getByRole('button', { name: 'Test' })).toHaveClass('bg-destructive')
})

test('announces the outcome and surfaces the failure reason for screen readers', async () => {
  const { rerender } = render(<TestButton onTest={async () => ({ ok: true })} />)

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test' })))
  expect(screen.getByRole('status')).toHaveTextContent('connection ok')

  rerender(<TestButton onTest={async () => ({ ok: false, error: 'Session expired' })} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test' })))
  expect(screen.getByRole('status')).toHaveTextContent('Session expired')
  expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute('title', 'Session expired')
})

test('host disabled keeps the button inert', () => {
  const onTest = vi.fn(async () => ({ ok: true }))

  render(<TestButton onTest={onTest} disabled />)

  expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
})
