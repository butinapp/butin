import { useLabels } from '@butinapp/ui/i18n'
import { Button, Card, CardContent, cn } from '@butinapp/ui/primitives'
import { Check, Circle, CircleDot, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

export type OnboardingStepStatus = 'pending' | 'active' | 'done' | 'failed'

export type OnboardingStepView = {
  id: string
  title: string
  blurb?: string
  status: OnboardingStepStatus
  // A reachable earlier (or current) step the user can click to jump back to — e.g. re-run Sign in from
  // Settings, or edit Settings from First fetch. Steps not yet reached aren't selectable.
  selectable?: boolean
}

// The active step is a STATIC "you're here" marker by default — it only spins when work is actually in flight
// (busy). A bare spinner on a waiting step reads as "something's happening" when nothing is.
const StepMark = ({ status, busy }: { status: OnboardingStepStatus; busy: boolean }) => {
  if (status === 'done') {
    return <Check className="size-4 text-emerald-500" />
  }

  if (status === 'active') {
    return busy ? (
      <Loader2 className="text-primary size-4 animate-spin" />
    ) : (
      <CircleDot className="text-primary size-4" />
    )
  }

  return <Circle className={cn('size-4', status === 'failed' ? 'text-destructive' : 'text-muted-foreground/40')} />
}

// Presentational onboarding stepper: the ordered steps with status marks, the active step's body slot, and a
// Skip affordance. The host (core service page) owns advancing status + the body (Connect / config / refresh).
export const OnboardingStepper = ({
  steps,
  activeBody,
  activeBusy,
  onStepSelect,
  onSkip
}: {
  steps: OnboardingStepView[]
  activeBody: ReactNode
  // Whether the active step's action is in flight (connecting / refreshing) — only then does its mark spin.
  activeBusy?: boolean
  // Jump back to a `selectable` step (re-run Sign in, edit Settings). Absent → steps aren't navigable.
  onStepSelect?: (id: string) => void
  onSkip: () => void
}) => {
  const t = useLabels()

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <ol className="space-y-3">
          {steps.map((s) => {
            const header = (
              <div className={cn('flex items-center gap-2.5', s.status === 'pending' && !s.selectable && 'opacity-50')}>
                <StepMark status={s.status} busy={s.status === 'active' && Boolean(activeBusy)} />
                <span className={cn('font-medium', s.selectable && onStepSelect && 'group-hover:underline')}>
                  {s.title}
                </span>
              </div>
            )

            return (
              <li key={s.id} className="space-y-2">
                {s.selectable && onStepSelect ? (
                  <button type="button" onClick={() => onStepSelect(s.id)} className="group block text-left">
                    {header}
                  </button>
                ) : (
                  header
                )}
                {s.blurb ? <p className="text-muted-foreground ml-6 text-xs">{s.blurb}</p> : null}
                {s.status === 'active' ? <div className="ml-6">{activeBody}</div> : null}
              </li>
            )
          })}
        </ol>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onSkip}>
            {t.skipForNow}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
