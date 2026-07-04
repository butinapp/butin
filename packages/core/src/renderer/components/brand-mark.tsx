import type { SVGProps } from 'react'

// The convergence hub — six accounts gathering into one place. Rendered inline (not via <img>) so it is
// theme-adaptive: the structure (spokes + satellites) inherits `currentColor`, the center node is the teal
// `--primary` token. That makes the mark read on both the dark and light app themes from one asset. The
// tiled variant (its own dark background) still lives in gen-icon.mjs for the OS icon / favicon.
const C = 64

export const BrandMark = ({ animated = false, ...props }: SVGProps<SVGSVGElement> & { animated?: boolean }) => {
  const spokes = Array.from({ length: 6 }, (_, i) => {
    const a = ((i * 60 - 90) * Math.PI) / 180
    const sx = +(C + 34 * Math.cos(a)).toFixed(1)
    const sy = +(C + 34 * Math.sin(a)).toFixed(1)
    const ix = +(C + 16 * Math.cos(a)).toFixed(1)
    const iy = +(C + 16 * Math.sin(a)).toFixed(1)

    return (
      <g key={i}>
        <line
          x1={sx}
          y1={sy}
          x2={ix}
          y2={iy}
          stroke="currentColor"
          strokeWidth={3.4}
          strokeLinecap="round"
          opacity={0.8}
        />
        <circle cx={sx} cy={sy} r={5} fill="currentColor" opacity={0.8}>
          {animated && (
            <animate attributeName="r" values="5;5;4;5" keyTimes="0;0.55;0.75;1" dur="3.6s" repeatCount="indefinite" />
          )}
        </circle>
      </g>
    )
  })

  return (
    <svg viewBox="0 0 128 128" fill="none" aria-hidden="true" {...props}>
      {spokes}
      <circle cx={C} cy={C} r={11} fill="var(--primary)">
        {animated && (
          <animate
            attributeName="r"
            values="11;11;13;11"
            keyTimes="0;0.55;0.78;1"
            dur="3.6s"
            repeatCount="indefinite"
          />
        )}
      </circle>
    </svg>
  )
}
