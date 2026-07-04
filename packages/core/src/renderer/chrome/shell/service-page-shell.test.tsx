import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { ServicePageShell } from './service-page-shell.js'

test('shows the not-loaded meta and renders children when there is no last run', () => {
  render(
    <ServicePageShell running={false} onRefresh={() => {}}>
      <p>panel body</p>
    </ServicePageShell>
  )

  expect(screen.getByText('not loaded yet')).toBeInTheDocument()
  expect(screen.getByText('panel body')).toBeInTheDocument()
})

test('shows a relative "refreshed ... ago" line with the absolute date when lastRunAt is set', () => {
  const lastRunAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString()

  render(
    <ServicePageShell lastRunAt={lastRunAt} running={false} onRefresh={() => undefined}>
      x
    </ServicePageShell>
  )

  expect(screen.getByText(/refreshed/)).toBeInTheDocument()
  expect(screen.getByText(/hours ago/)).toBeInTheDocument()
})

test('shows notLoadedYet when there is no lastRunAt', () => {
  render(
    <ServicePageShell running={false} onRefresh={() => undefined}>
      x
    </ServicePageShell>
  )

  expect(screen.getByText('not loaded yet')).toBeInTheDocument()
})

test('fires onRefresh when the Refresh button is pressed', async () => {
  const onRefresh = vi.fn()

  render(
    <ServicePageShell running={false} onRefresh={onRefresh}>
      <p>body</p>
    </ServicePageShell>
  )

  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(onRefresh).toHaveBeenCalledOnce()
})

test('disables Refresh while running or when refresh is not possible', () => {
  const { rerender } = render(
    <ServicePageShell running onRefresh={() => {}}>
      <p>body</p>
    </ServicePageShell>
  )

  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()

  rerender(
    <ServicePageShell running={false} refreshDisabled onRefresh={() => {}}>
      <p>body</p>
    </ServicePageShell>
  )
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
})

test('the per-tab Refresh is icon-only (no visible text) but keeps its accessible name', () => {
  render(
    <ServicePageShell running={false} onRefresh={() => {}}>
      <p>body</p>
    </ServicePageShell>
  )

  const btn = screen.getByRole('button', { name: 'Refresh' })

  expect(btn).toBeInTheDocument()
  expect(btn).toHaveTextContent('') // icon-only — the label lives on aria-label, not in the text
})

test('shows the stale-refresh warning banner only when warn is set', () => {
  const { rerender } = render(
    <ServicePageShell running={false} onRefresh={() => {}}>
      <p>body</p>
    </ServicePageShell>
  )

  expect(screen.queryByText(/Refresh failed/)).not.toBeInTheDocument()

  rerender(
    <ServicePageShell running={false} warn onRefresh={() => {}}>
      <p>body</p>
    </ServicePageShell>
  )
  expect(screen.getByText(/Refresh failed/)).toBeInTheDocument()
})
