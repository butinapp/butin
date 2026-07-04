import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { I18nProvider, useLabels } from './context.js'

// One probe component exercising both halves of the unified hook: typed chrome + the dynamic `s()`.
const Probe = () => {
  const t = useLabels()

  return (
    <div>
      <span data-testid="chrome">{t.refreshAll}</span>
      <span data-testid="plugin">{t.s('Summary')}</span>
      <span data-testid="data">{t.s('prod-cluster-7')}</span>
    </div>
  )
}

test('useLabels() exposes typed chrome AND s() for plugin strings under the French provider', () => {
  render(
    <I18nProvider locale="fr">
      <Probe />
    </I18nProvider>
  )

  expect(screen.getByTestId('chrome').textContent).toBe('Tout rafraîchir') // typed chrome key
  expect(screen.getByTestId('plugin').textContent).toBe('Résumé') // global plugin-text dict
  expect(screen.getByTestId('data').textContent).toBe('prod-cluster-7') // unknown → passthrough (service data)
})

test('per-plugin messages merge over the global dict', () => {
  const Domain = () => {
    const t = useLabels()

    return <span data-testid="domain">{t.s('Posologie')}</span>
  }

  render(
    <I18nProvider locale="en" messages={{ en: { Posologie: 'Dosage' } }}>
      <Domain />
    </I18nProvider>
  )

  expect(screen.getByTestId('domain').textContent).toBe('Dosage')
})

test('without a provider, useLabels() falls back to English chrome + identity s()', () => {
  render(<Probe />)

  expect(screen.getByTestId('chrome').textContent).toBe('Refresh All')
  expect(screen.getByTestId('plugin').textContent).toBe('Summary') // identity — no translation without provider
})
