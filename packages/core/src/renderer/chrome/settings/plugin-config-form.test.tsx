import { type ConfigFieldView } from '@butinapp/ui'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { PluginConfigForm } from './plugin-config-form.js'

const fields: ConfigFieldView[] = [
  { key: 'profile', label: 'AWS profile', kind: 'text', placeholder: 'default' },
  { key: 'secretAccessKey', label: 'Secret access key', kind: 'secret' }
]

const branched: ConfigFieldView[] = [
  {
    key: 'authMode',
    label: 'Auth',
    kind: 'select',
    options: [
      { value: 'profile', label: 'Profile' },
      { value: 'iam', label: 'IAM keys' }
    ]
  },
  { key: 'profile', label: 'AWS profile', kind: 'text', showWhen: { field: 'authMode', equals: 'profile' } },
  { key: 'accessKeyId', label: 'Access key ID', kind: 'secret', showWhen: { field: 'authMode', equals: 'iam' } }
]

test('renders text fields prefilled and secret fields blank as password inputs', () => {
  render(<PluginConfigForm fields={fields} values={{ profile: 'prod' }} onSubmit={vi.fn()} />)

  const profile = screen.getByLabelText('AWS profile') as HTMLInputElement

  expect(profile.value).toBe('prod')
  expect(profile.type).toBe('text')

  const secret = screen.getByLabelText('Secret access key') as HTMLInputElement

  expect(secret.value).toBe('')
  expect(secret.type).toBe('password')
})

test('submits the edited draft (secret included, text preserved)', async () => {
  const onSubmit = vi.fn()

  render(
    <PluginConfigForm fields={fields} values={{ profile: 'prod' }} submitLabel="Save settings" onSubmit={onSubmit} />
  )

  await userEvent.type(screen.getByLabelText('Secret access key'), 'shhh')
  await userEvent.click(screen.getByRole('button', { name: 'Save settings' }))

  expect(onSubmit).toHaveBeenCalledWith({ profile: 'prod', secretAccessKey: 'shhh' })
})

test('disables the submit button while busy', () => {
  render(<PluginConfigForm fields={fields} busy onSubmit={vi.fn()} />)

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})

test('showWhen gates fields on the select value — default (first option) shows the profile branch', () => {
  render(<PluginConfigForm fields={branched} onSubmit={vi.fn()} />)

  expect(screen.getByLabelText('AWS profile')).toBeInTheDocument()
  expect(screen.queryByLabelText('Access key ID')).not.toBeInTheDocument()
})

test('showWhen reveals the iam branch when the stored value selects it', () => {
  render(<PluginConfigForm fields={branched} values={{ authMode: 'iam' }} onSubmit={vi.fn()} />)

  expect(screen.queryByLabelText('AWS profile')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Access key ID')).toBeInTheDocument()
})

test('Test button runs onTest with the draft and shows the result', async () => {
  const onTest = vi.fn().mockResolvedValue({ ok: false, error: 'bad creds' })

  render(<PluginConfigForm fields={branched} onTest={onTest} onSubmit={vi.fn()} />)

  await userEvent.click(screen.getByRole('button', { name: 'Test' }))

  expect(onTest).toHaveBeenCalledWith({ authMode: 'profile', profile: '', accessKeyId: '' })
  expect(await screen.findByText('bad creds')).toBeInTheDocument()
})

test('no Test button when onTest is not provided', () => {
  render(<PluginConfigForm fields={fields} onSubmit={vi.fn()} />)

  expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
})

const combo: ConfigFieldView[] = [{ key: 'orgId', label: 'Organization', kind: 'combobox' }]
const orgOptions = [
  { value: 'p', label: 'Personal' },
  { value: 't', label: 'Acme Team', recommended: true }
]

test('combobox: seeds the recommended option into an empty field as a smart default', async () => {
  const onSubmit = vi.fn()

  render(
    <PluginConfigForm
      fields={combo}
      optionsByField={{ orgId: orgOptions }}
      canLoadOptions
      submitLabel="Save"
      onSubmit={onSubmit}
    />
  )

  // The trigger shows the recommended choice by name, and Save submits it without any extra interaction.
  expect(await screen.findByText('Acme Team')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSubmit).toHaveBeenCalledWith({ orgId: 't' })
})

test('combobox: never overrides an already-set value with the recommended default', () => {
  render(
    <PluginConfigForm
      fields={combo}
      values={{ orgId: 'p' }}
      optionsByField={{ orgId: orgOptions }}
      submitLabel="Save"
      onSubmit={vi.fn()}
    />
  )

  // The picker keeps the stored choice (Personal), not the recommended (Acme Team) — and since nothing
  // changed, Save stays disabled.
  expect(screen.getByText('Personal')).toBeInTheDocument()
  expect(screen.queryByText('Acme Team')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})

test('requireDirty=false: submits the pristine pre-filled config (onboarding Continue accepts it as-is)', async () => {
  const onSubmit = vi.fn()

  render(
    <PluginConfigForm
      fields={combo}
      values={{ orgId: 'p' }}
      requireDirty={false}
      submitLabel="Continue"
      onSubmit={onSubmit}
    />
  )

  const button = screen.getByRole('button', { name: 'Continue' })

  expect(button).toBeEnabled()

  await userEvent.click(button)
  expect(onSubmit).toHaveBeenCalledWith({ orgId: 'p' })
})

test('requireDirty=false: still gated on required fields being filled', async () => {
  const required: ConfigFieldView[] = [{ key: 'token', label: 'API token', kind: 'text', required: true }]

  render(<PluginConfigForm fields={required} requireDirty={false} submitLabel="Continue" onSubmit={vi.fn()} />)

  const button = screen.getByRole('button', { name: 'Continue' })

  expect(button).toBeDisabled()

  await userEvent.type(screen.getByLabelText(/API token/), 'abc')
  expect(button).toBeEnabled()
})

test('onSubmit returning { ok: false } shows the error inline and keeps the draft submittable', async () => {
  const onSubmit = vi.fn().mockResolvedValue({ ok: false, error: 'cannot connect' })

  render(<PluginConfigForm fields={fields} values={{ profile: 'prod' }} submitLabel="Continue" onSubmit={onSubmit} />)

  await userEvent.type(screen.getByLabelText('AWS profile'), '-x')

  const button = screen.getByRole('button', { name: 'Continue' })

  await userEvent.click(button)

  expect(onSubmit).toHaveBeenCalledWith({ profile: 'prod-x', secretAccessKey: '' })
  // The probe failure is surfaced inline, and the draft stays dirty so the button is still enabled to retry.
  expect(await screen.findByText('cannot connect')).toBeInTheDocument()
  expect(button).toBeEnabled()
})

test('adopts a late-arriving prefill (auto-captured id) into an untouched field without arming Save', async () => {
  const { rerender } = render(<PluginConfigForm fields={fields} values={{}} submitLabel="Save" onSubmit={vi.fn()} />)

  expect((screen.getByLabelText('AWS profile') as HTMLInputElement).value).toBe('')

  // The captured value lands after Magic Login's post-login refetch (the form already mounted empty).
  rerender(<PluginConfigForm fields={fields} values={{ profile: 'org_xyz' }} submitLabel="Save" onSubmit={vi.fn()} />)

  expect((screen.getByLabelText('AWS profile') as HTMLInputElement).value).toBe('org_xyz')
  // It's the saved baseline, not a user edit → Save stays disabled.
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})

test('a late-arriving prefill never clobbers a field the user has typed in', async () => {
  const { rerender } = render(<PluginConfigForm fields={fields} values={{}} submitLabel="Save" onSubmit={vi.fn()} />)

  await userEvent.type(screen.getByLabelText('AWS profile'), 'mine')
  rerender(<PluginConfigForm fields={fields} values={{ profile: 'org_xyz' }} submitLabel="Save" onSubmit={vi.fn()} />)

  expect((screen.getByLabelText('AWS profile') as HTMLInputElement).value).toBe('mine')
})

test('Save is disabled until a field is modified, then enabled', async () => {
  render(<PluginConfigForm fields={fields} values={{ profile: 'prod' }} submitLabel="Save" onSubmit={vi.fn()} />)

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

  await userEvent.type(screen.getByLabelText('AWS profile'), '-x')
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
})
