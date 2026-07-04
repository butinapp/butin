import type { ButinPlugin } from '@butinapp/sdk'

import { createCredentialStore } from '../store/credentials.js'

// Ids auto-captured during sign-in — a Groq org id off the `Groq-Organization` request header, a DNSimple
// account id off the dashboard URL — are stored in the credential store under their `storeAs` key. A config
// field of the same key the user hasn't filled resolves to that captured id, so an auto-detected id works in
// collect() (and prefills the Settings form) without a manual Save. The explicit config value always wins; the
// captured id only fills an otherwise-empty field. Both the collector context and the Settings-form payload run
// their config through here so the id shown in the form and the id the collector uses can't drift apart.
export const fillCapturedIds = <T extends Record<string, unknown>>(plugin: ButinPlugin, config: T): T => {
  const captures = [...(plugin.session?.captureFromUrl ?? []), ...(plugin.session?.captureFromHeader ?? [])]

  if (captures.length === 0) {
    return config
  }

  const fieldKeys = new Set((plugin.config?.fields ?? []).map((f) => f.key))
  const filled: Record<string, unknown> = { ...config }
  let creds: ReturnType<typeof createCredentialStore> | undefined

  for (const capture of captures) {
    const current = filled[capture.storeAs]
    const empty = current === undefined || (typeof current === 'string' && current.trim() === '')

    if (!fieldKeys.has(capture.storeAs) || !empty) {
      continue
    }

    creds ??= createCredentialStore(plugin.meta.id)
    const captured = creds.get(capture.storeAs)

    if (captured) {
      filled[capture.storeAs] = captured
    }
  }

  return filled as T
}
