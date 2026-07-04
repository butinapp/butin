import type { ConfigOption } from '@butinapp/sdk'
import { type ConfigFieldView, type VerifyResult } from '@butinapp/ui'
import { useLabels } from '@butinapp/ui/i18n'
import { Button, cn, Combobox, Input, Label, Select } from '@butinapp/ui/primitives'
import { useEffect, useRef, useState } from 'react'

// A per-plugin settings form: renders a plugin's declared config fields (text/secret/select) and submits
// the edited values. Pure + prop-driven — the host owns persistence (window.butin.services.setConfig) and the
// optional connection test. This is the onboarding surface for `external`/api-key plugins that have no
// Magic Login. Secret fields render as password inputs and seed blank (a blank secret means "leave the
// stored value as-is"); `select` fields render as a dropdown and can gate other fields via `showWhen`.
export interface PluginConfigFormProps {
  fields: ConfigFieldView[]
  // Current non-secret values to prefill; secrets are always blank.
  values?: Record<string, string>
  busy?: boolean
  submitLabel?: string
  testLabel?: string
  // Whether submit stays disabled until the draft diverges from the saved baseline. True for a "Save" button
  // (nothing to save when unchanged); false for onboarding's "Continue", which must accept an already-valid
  // (often auto-detected) config and advance — gated then only on required fields being filled.
  requireDirty?: boolean
  // Submitting the draft. May be async and may return a probe result: a `{ ok: false }` is shown inline and
  // the draft is NOT accepted (kept dirty so the user can fix + resubmit) — letting a host gate "Save"/
  // "Continue" on a live connection probe. A void return (or `{ ok: true }`) accepts the submit.
  onSubmit: (values: Record<string, string>) => void | Promise<VerifyResult | void>
  // When provided, a Test button appears that runs the check against the current draft; the result is
  // shown inline. The host implements it (persist + probe).
  onTest?: (values: Record<string, string>) => Promise<VerifyResult>
  // --- combobox fields (kind:'combobox') ---
  // Already-fetched, host-MEMOIZED option lists, keyed by field key. The form reads these to render the
  // picker; it never fetches itself.
  optionsByField?: Record<string, ConfigOption[]>
  optionsLoading?: Record<string, boolean>
  // Triggered when a combobox opens — the host runs its memoized fetch (a no-op if cached). Called only
  // when canLoadOptions is true, so a disconnected service never fires an auth-failing request.
  onLoadOptions?: (fieldKey: string) => void
  // Whether a fresh option list CAN be fetched (i.e. the session is live). Gates the fetch only — the
  // combobox stays editable (pick from cache / free-text) regardless.
  canLoadOptions?: boolean
}

const seedValue = (f: ConfigFieldView, values?: Record<string, string>): string => {
  if (f.kind === 'secret') {
    return ''
  }

  if (f.kind === 'select') {
    return values?.[f.key] ?? f.options?.[0]?.value ?? ''
  }

  return values?.[f.key] ?? ''
}

export const PluginConfigForm = ({
  fields,
  values,
  busy,
  submitLabel = 'Save',
  testLabel = 'Test',
  requireDirty = true,
  onSubmit,
  onTest,
  optionsByField,
  optionsLoading,
  onLoadOptions,
  canLoadOptions
}: PluginConfigFormProps) => {
  const t = useLabels()
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}

    for (const f of fields) {
      seed[f.key] = seedValue(f, values)
    }

    return seed
  })
  const [testing, setTesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<VerifyResult | null>(null)
  // The last-saved baseline — Save is disabled until the draft diverges from it (and re-armed after a save).
  // Captures the initial seed; the smart-default effect edits the draft, which correctly marks it dirty.
  const savedRef = useRef(draft)
  // Fields the user has actually typed in — late-arriving prefill must never clobber these.
  const editedRef = useRef(new Set<string>())

  const set = (key: string, value: string): void => {
    editedRef.current.add(key)
    setDraft((prev) => ({ ...prev, [key]: value }))
    setTestResult(null) // a draft edit invalidates the last test
  }

  // Adopt late-arriving prefill: an id auto-captured during Magic Login (captureFromUrl) lands in `values`
  // only after the post-login refetch — i.e. after this form first mounted + seeded. Sync it into any field
  // the user hasn't touched, re-baselining savedRef so the field shows the value WITHOUT arming Save.
  useEffect(() => {
    if (!values) {
      return
    }

    const fills: Record<string, string> = {}

    for (const f of fields) {
      if (f.kind === 'secret' || editedRef.current.has(f.key)) {
        continue
      }

      const incoming = values[f.key]

      if (incoming && incoming !== savedRef.current[f.key]) {
        fills[f.key] = incoming
      }
    }

    if (Object.keys(fills).length === 0) {
      return
    }

    savedRef.current = { ...savedRef.current, ...fills }
    setDraft((prev) => ({ ...prev, ...fills }))
  }, [values, fields])

  const dirty = fields.some((f) => (draft[f.key] ?? '') !== (savedRef.current[f.key] ?? ''))

  // A field shows unless its showWhen condition references another field that doesn't currently match.
  const visible = (f: ConfigFieldView): boolean => !f.showWhen || draft[f.showWhen.field] === f.showWhen.equals

  // Required fields (only the visible ones) must be filled to submit. Combined with the dirty gate below this
  // is what enables Continue when an auto-detected config is already valid but unchanged.
  const requiredMissing = fields.filter(visible).some((f) => f.required && (draft[f.key] ?? '').trim() === '')
  const canSubmit = !busy && !testing && !submitting && !requiredMissing && (requireDirty ? dirty : true)

  // Smart default: when a combobox's options arrive and the field has no value yet, pre-select the
  // plugin's `recommended` option into the DRAFT (not persisted). The user confirms with Save — so we get
  // a sensible pick without auto-running anything. Seeds once per field (a deliberate clear isn't re-seeded).
  const seededRef = useRef(new Set<string>())

  useEffect(() => {
    if (!optionsByField) {
      return
    }

    for (const f of fields) {
      if (f.kind !== 'combobox' || seededRef.current.has(f.key)) {
        continue
      }

      const recommended = optionsByField[f.key]?.find((o) => o.recommended)

      if (recommended) {
        seededRef.current.add(f.key)

        setDraft((prev) => (prev[f.key] ? prev : { ...prev, [f.key]: recommended.value }))
      }
    }
  }, [fields, optionsByField])

  // Await the submit so a host that probes the connection (onboarding's Continue) can reject a bad config:
  // a `{ ok: false }` result is shown inline and the draft stays dirty rather than being accepted.
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSubmitting(true)
    setTestResult(null)

    try {
      const result = await onSubmit(draft)

      if (result && !result.ok) {
        setTestResult(result)

        return
      }

      savedRef.current = draft // re-baseline so Save disables again until the next edit
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  const runTest = async (): Promise<void> => {
    if (!onTest) {
      return
    }

    setTesting(true)
    setTestResult(null)

    try {
      setTestResult(await onTest(draft))
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      {fields.filter(visible).map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`cfg-${f.key}`} className="text-xs">
            {t.s(f.label)}
            {f.required ? <span className="text-destructive">*</span> : null}
          </Label>
          {f.kind === 'combobox' ? (
            <Combobox
              id={`cfg-${f.key}`}
              value={draft[f.key] ?? ''}
              options={optionsByField?.[f.key] ?? []}
              loading={optionsLoading?.[f.key]}
              placeholder={f.placeholder}
              emptyHint={canLoadOptions ? undefined : 'Connect to load the list — or type a value.'}
              onOpen={() => {
                // Lazy first-load only: the host persists + seeds the list, so opening with a cached list does
                // NOT refetch (no "always reloading"). Fetch only when empty and a live session can load it.
                if (canLoadOptions && (optionsByField?.[f.key]?.length ?? 0) === 0) {
                  onLoadOptions?.(f.key)
                }
              }}
              onValueChange={(v) => set(f.key, v)}
            />
          ) : f.kind === 'select' ? (
            <Select
              id={`cfg-${f.key}`}
              value={draft[f.key] ?? ''}
              options={f.options ?? []}
              placeholder={f.placeholder}
              onValueChange={(v) => set(f.key, v)}
            />
          ) : (
            <Input
              id={`cfg-${f.key}`}
              type={f.kind === 'secret' ? 'password' : 'text'}
              className="h-8"
              value={draft[f.key] ?? ''}
              placeholder={f.placeholder}
              autoComplete={f.kind === 'secret' ? 'off' : undefined}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
          {f.help ? <p className="text-muted-foreground text-xs">{f.help}</p> : null}
        </div>
      ))}

      {testResult ? (
        <p
          className={cn(
            'text-xs',
            testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive break-all'
          )}
        >
          {testResult.ok ? '✓ OK' : (testResult.error ?? 'Failed')}
        </p>
      ) : null}

      <div className="flex gap-2">
        {onTest ? (
          <Button type="button" size="sm" variant="outline" disabled={busy || testing} onClick={() => void runTest()}>
            {testing ? '…' : testLabel}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {submitting ? '…' : submitLabel}
        </Button>
      </div>
    </form>
  )
}
