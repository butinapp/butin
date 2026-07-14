import { describe, expect, it } from 'vitest'

import { buildButinCss } from './build-css.mjs'

// Compiles the real embed bundle (Tailwind over the component source + theme.css, then the .butin scope pass)
// and guards the containment contract: nothing may land on a host's document, and the chart tokens must reach
// `.butin` (else embedded charts render with no series color). Regression guard against a token drifting back
// to `:root` or the scope pass regressing.
describe('butin.css bundle', () => {
  it('is fully contained under .butin and carries the chart tokens', async () => {
    const css = await buildButinCss()

    // No bare document-level selector survives — the host's :root / html / body / universal reset are untouched.
    expect(css).not.toMatch(/(^|})\s*:root\s*[,{]/)
    expect(css).not.toMatch(/(^|})\s*html\s*[,{]/)
    expect(css).not.toMatch(/(^|})\s*body\s*[,{]/)
    expect(css).not.toMatch(/(^|,|})\s*\*\s*[,{]/)

    // Tokens the echarts probe reads live on the scope element, light and dark.
    expect(css).toMatch(/\.butin\s*\{[^}]*--chart-1:/s)
    expect(css).toMatch(/\.butin\.dark[^{]*\{[^}]*--chart-1:/s)

    // Elements default their border color to the brand token — components use the bare `border` utility (width
    // only) and rely on this; without it embedded borders fall back to currentColor (dark in light, faint in dark).
    expect(css).toMatch(/border-color:\s*var\(--border\)/)
  }, 30_000)
})
