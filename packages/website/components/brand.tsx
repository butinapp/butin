import type { SVGProps } from 'react'

// The convergence hub — six accounts gathering into one place. Flat + theme-adaptive: the structure
// (spokes + satellites) inherits `currentColor`, the center node is the teal accent token. Rendered inline
// (not via <img>), so it reads on any background — dark site today, light surfaces if ever needed.
const C = 64

export const BrandMark = ({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) => {
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
          opacity={0.85}
        />
        <circle cx={sx} cy={sy} r={5} fill="currentColor" opacity={0.85} />
      </g>
    )
  })

  return (
    <svg viewBox="0 0 128 128" fill="none" role={title ? 'img' : 'presentation'} aria-label={title} {...props}>
      {spokes}
      <circle cx={C} cy={C} r={11} fill="var(--color-teal)" />
    </svg>
  )
}

export const Wordmark = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '-0.03em' }}>
    butin<span style={{ color: 'var(--color-teal)' }}>.</span>
  </span>
)
