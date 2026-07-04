import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { AlertsPane } from './alerts-pane.js'
import type { AlertConfigView } from './types.js'

const config: AlertConfigView = {
  change: { dod: { spend: 50 }, wow: {}, mom: { spend: 20, usage: 40 } },
  health: { fxMissing: true }
}
const labels = {
  changeTitle: 'Change alerts',
  healthTitle: 'Data health',
  fxMissing: 'Warn on missing rate',
  hint: 'Blank = off',
  windows: { dod: 'Day', wow: 'Week', mom: 'Month' },
  facets: { spend: 'Spend', usage: 'Usage' }
}

describe('AlertsPane', () => {
  test('renders a threshold input per window×facet and edits emit a new config', () => {
    const onChange = vi.fn()

    render(<AlertsPane config={config} onChange={onChange} labels={labels} />)
    fireEvent.change(screen.getByLabelText('Month Spend'), { target: { value: '25' } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ change: expect.objectContaining({ mom: expect.objectContaining({ spend: 25 }) }) })
    )
  })

  test('clearing an input removes that threshold (alert off)', () => {
    const onChange = vi.fn()

    render(<AlertsPane config={config} onChange={onChange} labels={labels} />)
    fireEvent.change(screen.getByLabelText('Day Spend'), { target: { value: '' } })
    expect(onChange.mock.calls.at(-1)![0].change.dod.spend).toBeUndefined()
  })

  test('clamps an absurd threshold to the ceiling', () => {
    const onChange = vi.fn()

    render(<AlertsPane config={config} onChange={onChange} labels={labels} />)
    fireEvent.change(screen.getByLabelText('Month Spend'), { target: { value: '23234' } })
    expect(onChange.mock.calls.at(-1)![0].change.mom.spend).toBe(1000)
  })

  test('toggling the health switch emits', () => {
    const onChange = vi.fn()

    render(<AlertsPane config={config} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange.mock.calls.at(-1)![0].health.fxMissing).toBe(false)
  })
})
