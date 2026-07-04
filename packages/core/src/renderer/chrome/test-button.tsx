import { type VerifyResult } from '@butinapp/ui'
import { useLabels } from '@butinapp/ui/i18n'
import { Button, cn } from '@butinapp/ui/primitives'
import { Check, Loader2, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Phase = 'idle' | 'running' | 'ok' | 'err'

// The Test action with built-in outcome feedback: a click runs the probe, then the button turns green with a
// check (pass) or red with a cross (fail) — immediate, local confirmation a probe finished, without watching
// the status dot. A pass is transient reassurance and settles back to the resting "Test" state; a failure is
// actionable, so it sticks until the next test rather than self-dismissing. `onTest` resolves the probe's ok;
// the host's `disabled` still locks it while a sibling or bulk action runs.
export const TestButton = ({
  onTest,
  disabled,
  variant = 'secondary',
  className
}: {
  onTest: () => Promise<VerifyResult>
  disabled?: boolean
  variant?: 'secondary' | 'outline'
  className?: string
}) => {
  const t = useLabels()
  const [phase, setPhase] = useState<Phase>('idle')
  const [reason, setReason] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A flash can outlive the component (navigate away mid-probe) — clear the revert timer so it never fires on
  // an unmounted button.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )

  const run = async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current)
    }

    setPhase('running')

    let result: VerifyResult = { ok: false }

    try {
      result = await onTest()
    } finally {
      setReason(result.error)
      setPhase(result.ok ? 'ok' : 'err')

      // Auto-revert only a pass; a failure stays until the next test so an unwatched result isn't lost.
      if (result.ok) {
        timer.current = setTimeout(() => setPhase('idle'), 1600)
      }
    }
  }

  const icon =
    phase === 'running' ? (
      <Loader2 className="animate-spin" />
    ) : phase === 'ok' ? (
      <Check />
    ) : phase === 'err' ? (
      <X />
    ) : (
      <Zap />
    )

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        disabled={disabled || phase === 'running'}
        title={phase === 'err' ? reason : undefined}
        onClick={() => void run()}
        className={cn(
          phase === 'ok' && 'bg-emerald-600 text-white hover:bg-emerald-600',
          phase === 'err' && 'bg-destructive hover:bg-destructive text-white',
          className
        )}
      >
        {icon}
        {t.test}
      </Button>
      {/* The pass/fail is otherwise only color + icon — announce the outcome so it reaches a screen reader.
          A sibling (not a child) keeps it out of the button's accessible name; sr-only drops it out of flow. */}
      <span role="status" aria-live="polite" className="sr-only">
        {phase === 'ok' ? t.testPassed : phase === 'err' ? (reason ?? t.testFailed) : ''}
      </span>
    </>
  )
}
