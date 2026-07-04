import { en, LabelsProvider } from '@butinapp/ui/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ExtractAllControl } from './extract-all-control.js'

const wrap = (ui: ReactNode) => render(<LabelsProvider value={en}>{ui}</LabelsProvider>)

describe('ExtractAllControl', () => {
  it('renders the idle label and fires onExtract on click', () => {
    const onExtract = vi.fn()

    wrap(<ExtractAllControl running={false} onExtract={onExtract} />)

    const btn = screen.getByRole('button', { name: /save everything/i })

    fireEvent.click(btn)
    expect(onExtract).toHaveBeenCalledTimes(1)
  })

  it('shows the running label with the live phase and is disabled', () => {
    wrap(<ExtractAllControl running progress={{ phase: 'medications' }} onExtract={vi.fn()} />)

    const btn = screen.getByRole('button')

    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent(/saving/i)
    expect(btn).toHaveTextContent(/medications/i)
  })

  it('is disabled when the disabled prop is set', () => {
    wrap(<ExtractAllControl running={false} disabled onExtract={vi.fn()} />)

    expect(screen.getByRole('button')).toBeDisabled()
  })
})
