import { type PluginView } from '@butinapp/ui'
import { I18nProvider } from '@butinapp/ui/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AvailableCatalog } from './available-catalog.js'

const make = (over: Partial<PluginView>): PluginView => ({
  id: 'x',
  name: 'X',
  hasCookie: false,
  connected: false,
  sessionless: false,
  configFields: [],
  config: {},
  capabilities: [],
  ...over
})

const renderWith = (ui: ReactElement) => render(<I18nProvider locale="en">{ui}</I18nProvider>)

describe('AvailableCatalog', () => {
  it('renders a row + Install button per plugin and fires onInstall', () => {
    const onInstall = vi.fn()

    renderWith(
      <AvailableCatalog
        plugins={[make({ id: 'linear', name: 'Linear', category: 'productivity' })]}
        onInstall={onInstall}
      />
    )

    expect(screen.getByText('Linear')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /install/i }))
    expect(onInstall).toHaveBeenCalledWith('linear')
  })

  it('filters by the search query', () => {
    renderWith(
      <AvailableCatalog
        plugins={[make({ id: 'linear', name: 'Linear' }), make({ id: 'stripe', name: 'Stripe' })]}
        onInstall={vi.fn()}
      />
    )

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'stri' } })
    expect(screen.queryByText('Linear')).not.toBeInTheDocument()
    expect(screen.getByText('Stripe')).toBeInTheDocument()
  })

  it('shows the all-installed empty state when no plugins are available', () => {
    renderWith(<AvailableCatalog plugins={[]} onInstall={vi.fn()} />)
    expect(screen.getByText(/all services installed/i)).toBeInTheDocument()
  })
})
