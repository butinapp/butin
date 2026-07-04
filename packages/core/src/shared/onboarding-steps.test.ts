import { describe, expect, it } from 'vitest'

import { buildOnboardingSteps } from './onboarding-steps.js'

describe('buildOnboardingSteps', () => {
  it('session plugin with config: sign-in → settings → refresh', () => {
    expect(buildOnboardingSteps({ sessionless: false, hasConfigFields: true })).toEqual([
      'sign-in',
      'settings',
      'first-refresh'
    ])
  })

  it('session plugin without config: sign-in → refresh', () => {
    expect(buildOnboardingSteps({ sessionless: false, hasConfigFields: false })).toEqual(['sign-in', 'first-refresh'])
  })

  it('sessionless plugin: settings → refresh (no sign-in)', () => {
    expect(buildOnboardingSteps({ sessionless: true, hasConfigFields: true })).toEqual(['settings', 'first-refresh'])
  })

  it('sessionless plugin with no config fields still gets a settings step (config IS the connection)', () => {
    expect(buildOnboardingSteps({ sessionless: true, hasConfigFields: false })).toEqual(['settings', 'first-refresh'])
  })
})
