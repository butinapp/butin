import type { Service } from '@/lib/services'

// Pick a legible letter color (near-black or white) for a solid brand-color tile by the color's luminance,
// so the monogram reads on any accent.
const readableOn = (hex: string): string => {
  const full = hex.replace('#', '').replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3')

  if (full.length !== 6) {
    return '#fff'
  }

  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255

  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62 ? '#15181c' : '#fff'
}

// A brand-colored letter monogram — the service's initial on a solid tile of its accent. We don't ship
// third-party logos; the monogram is the mark everywhere.
export const ServiceIcon = ({ service, size = 40 }: { service: Service; size?: number }) => (
  <span
    aria-hidden
    className="grid place-items-center rounded-lg font-semibold"
    style={{
      width: size,
      height: size,
      background: service.color,
      color: readableOn(service.color),
      fontFamily: 'var(--font-display)',
      fontSize: size * 0.44
    }}
  >
    {service.name.charAt(0)}
  </span>
)
