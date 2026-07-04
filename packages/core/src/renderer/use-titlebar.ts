import { useTheme } from 'next-themes'
import { useEffect } from 'react'

const platform = window.butin.platform

// Space the native window controls occupy, on the side the OS draws them — the header reserves it so the brand
// and actions never sit under the min/max/close buttons. Windows/Linux draw them right (~3×46px); macOS draws
// its traffic lights at the left. Undefined elsewhere (e.g. an embedded browser) → no inset.
export const titleBarInset: { left?: number; right?: number } | undefined =
  platform === 'win32' || platform === 'linux' ? { right: 138 } : platform === 'darwin' ? { left: 78 } : undefined

// Resolve a CSS custom property to an `rgb()` string. getComputedStyle serializes the resolved `color` in its
// authored space (the theme tokens are oklch), and the native overlay parser rejects oklch — so paint the
// color onto a 1×1 canvas and read the pixel back: getImageData always returns 0–255 sRGB bytes, whatever the
// input color space, giving an rgb() the overlay accepts.
const resolveColor = (cssVar: string): string => {
  const probe = document.createElement('span')

  probe.style.color = `var(${cssVar})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color

  probe.remove()

  const canvas = document.createElement('canvas')

  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return computed
  }

  ctx.fillStyle = computed
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data

  return `rgb(${r}, ${g}, ${b})`
}

// Keep the native window-controls overlay matched to the active theme — its tile to the header's `bg-card`, its
// glyphs to the muted-foreground — re-tinting on every light/dark switch. The main side no-ops on macOS.
export const useTitleBarOverlaySync = (): void => {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    // next-themes flips the `.dark` class in the ThemeProvider's effect, which React runs AFTER this (child)
    // effect — so reading the tokens synchronously here sees the PREVIOUS theme (the overlay ends up inverted).
    // Defer to the next frame, by which point the class is applied and the token cascade recomputed.
    const id = requestAnimationFrame(() => {
      void window.butin.window.setTitleBarOverlay({
        color: resolveColor('--card'),
        symbolColor: resolveColor('--muted-foreground')
      })
    })

    return () => cancelAnimationFrame(id)
  }, [resolvedTheme])
}
