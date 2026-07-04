import { I18nProvider } from '@butinapp/ui/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { OnboardingStepper, type OnboardingStepView } from './onboarding-stepper.js'

const steps: OnboardingStepView[] = [
  { id: 'sign-in', title: 'Sign in', status: 'done' },
  { id: 'settings', title: 'Settings', status: 'active' },
  { id: 'first-refresh', title: 'First refresh', status: 'pending' }
]

describe('OnboardingStepper', () => {
  it('renders each step title and the active step body', () => {
    render(
      <I18nProvider locale="en">
        <OnboardingStepper steps={steps} activeBody={<div>BODY</div>} onSkip={vi.fn()} />
      </I18nProvider>
    )

    expect(screen.getByText('Sign in')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('BODY')).toBeInTheDocument()
  })

  it('fires onSkip', () => {
    const onSkip = vi.fn()

    render(
      <I18nProvider locale="en">
        <OnboardingStepper steps={steps} activeBody={null} onSkip={onSkip} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /skip/i }))
    expect(onSkip).toHaveBeenCalled()
  })

  it('lets the user click a selectable (earlier) step to jump back', () => {
    const onStepSelect = vi.fn()
    const navigable: OnboardingStepView[] = [
      { id: 'sign-in', title: 'Sign in', status: 'done', selectable: true },
      { id: 'settings', title: 'Settings', status: 'active' },
      { id: 'first-refresh', title: 'First refresh', status: 'pending' }
    ]

    render(
      <I18nProvider locale="en">
        <OnboardingStepper steps={navigable} activeBody={null} onStepSelect={onStepSelect} onSkip={vi.fn()} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onStepSelect).toHaveBeenCalledWith('sign-in')
  })
})
