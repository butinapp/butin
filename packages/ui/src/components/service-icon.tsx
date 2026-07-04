import { createContext, useContext, type ReactNode } from 'react'

import { cn } from '../lib/utils.js'

// A host-supplied logo source: given a service's identity (stable `id` + display `name`/`color`) and the
// pixel size, return a node to draw INSTEAD of the monogram, or a nullish/false value to fall through to the
// default. Lets an embedder paint real brand logos it holds in its OWN bundle — Butin ships none.
export type ServiceIconResolver = (service: { id?: string; name?: string; color?: string }, size: number) => ReactNode

const ServiceIconContext = createContext<ServiceIconResolver | undefined>(undefined)

// Wrap a tree to override how `<ServiceIcon>` draws: every icon consults `resolve` first, so an embed can map
// plugin ids to its own logos without threading a prop through the shell. No provider → the monogram default.
export const ServiceIconProvider = ({ resolve, children }: { resolve?: ServiceIconResolver; children: ReactNode }) => (
  <ServiceIconContext.Provider value={resolve}>{children}</ServiceIconContext.Provider>
)

// Pick a legible letter color (near-black or white) for a solid brand-color tile, by the brand color's
// luminance — so the monogram reads on any accent, in either theme. Falls back to white for non-hex colors.
export const readableOn = (hex: string): string => {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.replace(/./g, (c) => c + c) : m

  if (full.length !== 6) {
    return '#fff'
  }

  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

  return luminance > 0.62 ? '#15181c' : '#fff'
}

// A service's brand mark. We don't ship third-party logos — instead a service renders a brand-colored
// letter monogram (its name's initial on a solid tile of `meta.color`, with an auto-contrast glyph). A host
// can override per service via `ServiceIconProvider` (keyed on `id`), or a plugin can supply its OWN `icon`
// data-URI; absent both, the monogram is the default. Pure + prop-driven, so it renders identically in the
// app and a snapshot embed. The box is always `size`×`size` so rows stay aligned regardless of which branch
// renders.
export const ServiceIcon = ({
  id,
  icon,
  name,
  color,
  size = 16,
  className
}: {
  id?: string
  icon?: string
  name?: string
  color?: string
  size?: number
  className?: string
}) => {
  const resolved = useContext(ServiceIconContext)?.({ id, name, color }, size)

  if (resolved != null && resolved !== false) {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden', className)}
        style={{ width: size, height: size }}
      >
        {resolved}
      </span>
    )
  }

  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        className={cn('shrink-0 rounded-sm object-contain', className)}
      />
    )
  }

  const letter = name?.trim().charAt(0).toUpperCase()

  if (letter) {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex shrink-0 items-center justify-center rounded-[5px] font-semibold', className)}
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.62),
          lineHeight: 1,
          backgroundColor: color ?? 'var(--muted)',
          color: color ? readableOn(color) : 'var(--muted-foreground)'
        }}
      >
        {letter}
      </span>
    )
  }

  const dot = Math.max(6, Math.round(size / 2))

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <span className="rounded-full" style={{ width: dot, height: dot, backgroundColor: color ?? 'var(--border)' }} />
    </span>
  )
}
