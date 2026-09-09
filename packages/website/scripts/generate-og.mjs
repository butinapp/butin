import { ImageResponse } from 'next/og.js'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'

// Writes app/opengraph-image.png. Run with `pnpm og` after changing the card's copy or the brand colours.
//
// This is a script rather than an `app/opengraph-image.tsx` route on purpose. That route works, but under
// `output: 'export'` it emits `out/opengraph-image` with NO extension, and an asset server derives content-type
// from the extension — so the card would ship as application/octet-stream and every unfurl would silently render
// nothing. A committed .png has an extension, so it is served as image/png everywhere with no special casing.
//
// Plain `createElement` rather than JSX so Node can run this file directly, with no build step or loader.
//
// Colours are the brand tokens from app/global.css. Satori cannot read the stylesheet, so a CSS variable would
// resolve to nothing here — keep these in step by hand.
const card = h(
  'div',
  {
    style: {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '80px',
      background: 'linear-gradient(135deg, #161b22 0%, #0e1116 100%)',
      color: '#eef1f5'
    }
  },
  h('div', { style: { fontSize: 96, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 } }, 'butin.'),
  h('div', { style: { fontSize: 46, marginTop: 28, color: '#62d4c8' } }, 'Your data, brought home.'),
  h(
    'div',
    { style: { fontSize: 27, marginTop: 34, color: '#7c8a9a', maxWidth: 940, lineHeight: 1.45 } },
    'A local-first desktop app that pulls the billing, usage and records your services keep behind their own ' +
      'dashboards — using your own login — and keeps every byte on your machine.'
  )
)

// No webfont is fetched: a remote font fetch is the usual way OG generation fails, and it buys little at this size.
const image = new ImageResponse(card, { width: 1200, height: 630 })
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'opengraph-image.png')

await writeFile(out, Buffer.from(await image.arrayBuffer()))
console.log(`wrote ${out}`)
