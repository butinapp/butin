import { cn } from '../lib/utils.js'

// A thin horizontal progress bar. `value` is a 0..1 fraction (clamped). Theme-portable: track is `bg-muted`,
// fill is `bg-primary`, so it takes the host's palette. Width-driven, no animation.
export const Progress = ({ value, className }: { value: number; className?: string }) => {
  const pct = Math.max(0, Math.min(1, value)) * 100

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('bg-muted h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
    </div>
  )
}
