import { I18nProvider } from '@butinapp/ui/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ErrorPanel } from './error-panel.js'

describe('ErrorPanel', () => {
  it('renders the message + action buttons and fires the handler', () => {
    const onAction = vi.fn()

    render(
      <I18nProvider locale="en">
        <ErrorPanel cause="session-expired" message="Session expired" actions={['reconnect']} onAction={onAction} />
      </I18nProvider>
    )

    expect(screen.getByText('Session expired')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }))
    expect(onAction).toHaveBeenCalledWith('reconnect')
  })

  it('reveals raw details on toggle', () => {
    render(
      <I18nProvider locale="en">
        <ErrorPanel
          cause="unknown"
          message="Something went wrong"
          actions={['retry']}
          details="Error: 500"
          onAction={vi.fn()}
        />
      </I18nProvider>
    )

    // The <details> summary is present; the raw text lives inside it.
    expect(screen.getByText(/details/i)).toBeInTheDocument()
    expect(screen.getByText('Error: 500')).toBeInTheDocument()
  })
})
