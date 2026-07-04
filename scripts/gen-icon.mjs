import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Generates Butin's mark (a convergence hub — six satellites representing your accounts gather into one central
// point, expressing "all your accounts, one place") into its canonical assets so the geometry is reproducible
// everywhere. The mark sits on a deep Quiet-instrument tile (#1b2129 → #0d1014) with a teal accent (#62d4c8),
// so it reads on any taskbar or dock at any size. Emits:
//   • packages/core/src/renderer/assets/butin-mark.svg   static  (top-bar chip + reduced-motion About)
//   • packages/core/src/renderer/assets/butin-logo.svg   animated (satellites pulse inward) — About hero
//   • packages/core/build/icon.svg + icon.png            the OS taskbar/dock icon (1024²)
//   • packages/recorder/build/icon.svg + icon.png        the dev recorder's icon — the same mark with a red hub
//     (#ef4444), so the recording tool is distinguishable from the app at a glance.
// Run: node scripts/gen-icon.mjs   (then pnpm fix)
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const C = 64 // center of the 128 viewBox

// The convergence hub: six satellites (your accounts) gather into one center (the one place). When
// `animated`, the satellites pulse inward toward the hub. `center` tints the hub dot (the app is teal,
// the recorder red). C = 64 (center of the 128 viewBox).
const hub = (animated, center) => {
  const spokes = Array.from({ length: 6 }, (_, i) => {
    const a = ((i * 60 - 90) * Math.PI) / 180
    const sx = (C + 34 * Math.cos(a)).toFixed(1)
    const sy = (C + 34 * Math.sin(a)).toFixed(1)
    const ix = (C + 16 * Math.cos(a)).toFixed(1)
    const iy = (C + 16 * Math.sin(a)).toFixed(1)
    const dot = animated
      ? `<animate attributeName="r" values="5;5;4;5" keyTimes="0;0.55;0.75;1" dur="3.6s" repeatCount="indefinite"/>`
      : ''

    return `<line x1="${sx}" y1="${sy}" x2="${ix}" y2="${iy}" stroke="#3c7d77" stroke-width="3.4" stroke-linecap="round"/>
      <circle cx="${sx}" cy="${sy}" r="5" fill="#bdeee8">${dot}</circle>`
  }).join('\n    ')
  const hubPulse = animated
    ? `<animate attributeName="r" values="11;11;13;11" keyTimes="0;0.55;0.78;1" dur="3.6s" repeatCount="indefinite"/>`
    : ''

  return `
  <g>
    ${spokes}
  </g>
  <circle cx="${C}" cy="${C}" r="11" fill="${center}">${hubPulse}</circle>`
}

const svg = ({
  animated = false,
  center = '#62d4c8'
} = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="v-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1b2129"/><stop offset="100%" stop-color="#0d1014"/>
    </linearGradient>
    <clipPath id="v-clip"><rect width="128" height="128" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#v-clip)">
    <rect width="128" height="128" fill="url(#v-bg)"/>
    <rect x="13" y="13" width="102" height="102" rx="19" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.10"/>
    ${hub(animated, center)}
  </g>
</svg>
`

const mark = svg({ animated: false })
const recorderMark = svg({ animated: false, center: '#ef4444' })

writeFileSync(join(root, 'packages/core/src/renderer/assets/butin-mark.svg'), mark)
writeFileSync(join(root, 'packages/core/src/renderer/assets/butin-logo.svg'), svg({ animated: true }))
writeFileSync(join(root, 'packages/core/build/icon.svg'), mark)
mkdirSync(join(root, 'packages/recorder/build'), { recursive: true })
writeFileSync(join(root, 'packages/recorder/build/icon.svg'), recorderMark)

// Rasterize each OS icon to 1024² (electron-builder / the dev window read build/icon.png).
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
const page = await context.newPage()

const rasterize = async (svgMark, out) => {
  await page.setContent(
    `<!doctype html><meta charset=utf-8><style>html,body{margin:0}svg{width:1024px;height:1024px;display:block}</style>${svgMark}`
  )
  await page.screenshot({ path: join(root, out), omitBackground: true })
}

await rasterize(mark, 'packages/core/build/icon.png')
await rasterize(recorderMark, 'packages/recorder/build/icon.png')
await browser.close()
console.log('wrote butin-mark.svg, butin-logo.svg, core build/icon.{svg,png}, recorder build/icon.{svg,png}')
