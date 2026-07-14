import { useEffect, useLayoutEffect, useMemo, useState } from 'react'

// ECharts colors live in JS (canvas), so they can't ride the CSS cascade the way Tailwind classes can.
// Reading the resolved shadcn semantic tokens off the DOM at render and feeding those concrete values to
// ECharts keeps charts correct in light OR dark, in the app and an embedded viewer, with no theme state
// threaded through. `useEchartsTheme()` re-reads whenever the `.dark` class flips.

export interface EchartsTheme {
  LABEL: { color: string; fontSize: number }
  AXIS_LINE: {
    axisLine: { lineStyle: { color: string } }
    splitLine: { lineStyle: { color: string } }
  }
  TOOLTIP: {
    trigger: 'axis'
    backgroundColor: string
    borderColor: string
    textStyle: { color: string }
  }
  LEGEND_TEXT: string
  // Brand series color (the cyan --chart-1), for bars/lines that can't ride the CSS cascade.
  ACCENT: string
  // The full categorical palette (--chart-1..5), for stacked/multi-series charts. Cycles past 5.
  PALETTE: string[]
}

// Chart grid. `top` defaults to 28 (room for a legend); pass 16 for charts without one.
export const grid = (top = 28) => ({ left: 8, right: 16, top, bottom: 8, containLabel: true })

// Tailwind v4 ships full color functions (`oklch(…)`) that are valid as-is, but a bare HSL triplet
// (`0 0% 26%`) is meant to be wrapped by the CSS. The canvas can't parse a bare triplet and silently
// drops the stroke. Wrap triplets into `hsl(…)`; pass real color functions through.
const HSL_TRIPLET = /^-?[\d.]+\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/

export const asCanvasColor = (value: string): string => (HSL_TRIPLET.test(value) ? `hsl(${value})` : value)

// Resolve a CSS custom property to a CONCRETE rgb() string. Reading the property directly yields its raw
// authored value (e.g. `oklch(0.235 0.01 275)`), which ECharts/zrender — and especially the DOM tooltip's
// background — can't reliably parse, so it silently falls back to its translucent default. We instead set
// `color: var(--token)` on a throwaway probe in the theme element's subtree and read the *computed* color,
// which the browser has already resolved to `rgb(…)`. Works for oklch, hsl-triplet, or hex tokens alike.
const readToken = (el: Element, name: string, fallback: string): string => {
  const probe = document.createElement('span')

  probe.style.cssText = `color: var(${name}); position: absolute; visibility: hidden; pointer-events: none`
  el.appendChild(probe)

  const rgb = getComputedStyle(probe).color

  probe.remove()

  // An unresolved var computes to the inherited color or fully-transparent black; treat that as "missing".
  return rgb && rgb !== 'rgba(0, 0, 0, 0)' ? rgb : fallback
}

// Element whose computed tokens reflect the theme: the nearest `.butin` scope (an embed wrapper, or the app's
// <html>), which is where the token values are defined. Falls back to <html> if the class isn't found.
const probeElement = (): Element => document.querySelector('.butin') ?? document.documentElement

const computeTheme = (): EchartsTheme => {
  const el = probeElement()
  const muted = readToken(el, '--muted-foreground', '#888')
  const border = readToken(el, '--border', '#2a2a35')
  const popover = readToken(el, '--popover', '#1b1b22')
  const popoverFg = readToken(el, '--popover-foreground', '#e8e8ea')
  // Fallbacks for an unthemed embed; the live values come from the --chart-N tokens. Quiet-instrument:
  // teal lead, then blue / amber / green / violet — no neon, no magenta.
  const palette = ['#62d4c8', '#5b9bd5', '#d9a441', '#4bbf8a', '#9b7fd4'].map((fb, i) =>
    readToken(el, `--chart-${i + 1}`, fb)
  )

  return {
    LABEL: { color: muted, fontSize: 11 },
    AXIS_LINE: {
      axisLine: { lineStyle: { color: border } },
      splitLine: { lineStyle: { color: border } }
    },
    TOOLTIP: { trigger: 'axis', backgroundColor: popover, borderColor: border, textStyle: { color: popoverFg } },
    LEGEND_TEXT: muted,
    ACCENT: palette[0]!,
    PALETTE: palette
  }
}

// Resolved ECharts styling for the current theme. Returns new objects whenever `.dark` toggles on
// <html>/<body>, so charts that fold these into a useMemo option builder re-color on the next render.
export const useEchartsTheme = (): EchartsTheme => {
  const [tick, setTick] = useState(0)

  // Recompute once after the first commit. The render-phase useMemo above runs BEFORE this component's DOM is
  // committed, so `document.querySelector('.butin')` in the probe is still null → it falls back to <html>,
  // which doesn't carry the scoped `.butin` tokens, and the chart comes up black until something re-ticks.
  // useLayoutEffect fires after commit (so `.butin` exists) but before paint (so there is no black flash).
  useLayoutEffect(() => {
    setTick((t) => t + 1)
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => setTick((t) => t + 1))

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    }

    return () => observer.disconnect()
  }, [])

  return useMemo(() => computeTheme(), [tick])
}
