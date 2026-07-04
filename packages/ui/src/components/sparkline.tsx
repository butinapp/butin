import { cn } from '../lib/utils.js'

// A compact inline trend line for a table cell — a row's per-day series at a glance. Pure SVG (no chart
// engine), so it's cheap to render once per row. Stroke is `currentColor`, so the line takes the cell's text
// color (set via className) and stays theme-portable. A series shorter than two finite points renders nothing.
export const Sparkline = ({
  values,
  width = 72,
  height = 20,
  strokeWidth = 1.5,
  className
}: {
  values: number[]
  width?: number
  height?: number
  strokeWidth?: number
  className?: string
}) => {
  const points = values.filter((v) => Number.isFinite(v))

  if (points.length < 2) {
    return null
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min
  const pad = strokeWidth
  const usable = height - pad * 2
  const stepX = width / (points.length - 1)

  // A flat series (all equal) pins to the vertical middle so it reads as a baseline, not a spike.
  const y = (v: number): number => (span === 0 ? height / 2 : pad + (1 - (v - min) / span) * usable)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)} ${y(v).toFixed(2)}`).join(' ')
  const last = points[points.length - 1]!

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      className={cn('text-muted-foreground inline-block overflow-visible align-middle', className)}
      aria-hidden
    >
      <path d={d} stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={y(last)} r={strokeWidth} fill="currentColor" />
    </svg>
  )
}
