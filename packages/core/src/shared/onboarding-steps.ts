export type OnboardingStepId = 'sign-in' | 'settings' | 'first-refresh'

// Derive the ordered onboarding steps for a plugin. Session plugins start with Magic Login; sessionless ones
// skip it (their config form IS the connection, so they always get a settings step). A settings step is
// included for any plugin that has config fields, and always for sessionless plugins. Lives in shared/ so
// both main and the renderer container can derive the same list. Pure — no Electron, no IO.
export const buildOnboardingSteps = (plugin: {
  sessionless: boolean
  hasConfigFields: boolean
}): OnboardingStepId[] => {
  const steps: OnboardingStepId[] = []

  if (!plugin.sessionless) {
    steps.push('sign-in')
  }

  if (plugin.sessionless || plugin.hasConfigFields) {
    steps.push('settings')
  }

  steps.push('first-refresh')

  return steps
}
