import { ImageResponse } from 'next/og.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'

// Writes app/opengraph-image.png and app/fr/opengraph-image.png.
// Run with `pnpm og` after changing the card's copy or brand visuals.

function renderLogo(size = 72) {
  const spokes = [
    { x1: 64.0, y1: 28.0, x2: 64.0, y2: 47.0, cx: 64.0, cy: 28.0 },
    { x1: 95.2, y1: 46.0, x2: 78.7, y2: 55.5, cx: 95.2, cy: 46.0 },
    { x1: 95.2, y1: 82.0, x2: 78.7, y2: 72.5, cx: 95.2, cy: 82.0 },
    { x1: 64.0, y1: 100.0, x2: 64.0, y2: 81.0, cx: 64.0, cy: 100.0 },
    { x1: 32.8, y1: 82.0, x2: 49.3, y2: 72.5, cx: 32.8, cy: 82.0 },
    { x1: 32.8, y1: 46.0, x2: 49.3, y2: 55.5, cx: 32.8, cy: 46.0 }
  ]

  return h(
    'svg',
    { viewBox: '0 0 128 128', width: size, height: size, fill: 'none' },
    h(
      'g',
      null,
      ...spokes.flatMap((s, idx) => [
        h('line', {
          key: `line-${idx}`,
          x1: String(s.x1),
          y1: String(s.y1),
          x2: String(s.x2),
          y2: String(s.y2),
          stroke: '#3c7d77',
          strokeWidth: '4.5',
          strokeLinecap: 'round'
        }),
        h('circle', { key: `circle-${idx}`, cx: String(s.cx), cy: String(s.cy), r: '7', fill: '#bdeee8' })
      ]),
      h('circle', { cx: '64', cy: '64', r: '14', fill: '#62d4c8' })
    )
  )
}

function createCard({ locale = 'en' }) {
  const isFr = locale === 'fr'
  const titlePill = isFr ? 'LOCAL-FIRST · SANS NUAGE' : 'LOCAL-FIRST · NO CLOUD'
  const headlinePre = isFr ? 'Vos comptes réunis.' : 'Your data,'
  const headlineAccent = isFr ? 'Chez vous.' : 'brought home.'
  const description = isFr
    ? 'L’application de bureau locale qui réunit la facturation, l’utilisation et les documents de tous vos services au même endroit sur votre ordinateur.'
    : 'The local-first desktop app that pulls billing, usage, and records from every service you use into one place. Kept 100% on your machine.'
  const services = isFr
    ? ['AWS', 'Vidéotron', 'GitHub', 'Claude', 'Carnet Santé', 'Vercel', 'Airbnb']
    : ['AWS', 'Videotron', 'GitHub', 'Claude', 'Vercel', 'Carnet Santé', 'Airbnb']
  const moreText = isFr ? '+35 autres' : '+35 more'
  const platformsText = 'macOS · Windows · Linux'

  return h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '56px 68px',
        backgroundColor: '#0c0e14',
        backgroundImage:
          'radial-gradient(circle at 16% 22%, rgba(98, 212, 200, 0.20) 0%, transparent 45%), ' +
          'radial-gradient(circle at 84% 78%, rgba(60, 125, 119, 0.14) 0%, transparent 45%)',
        color: '#eef1f5',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }
    },
    // Top Row: Logo + Wordmark and Badges
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '22px' } },
        h(
          'div',
          {
            style: {
              width: '92px',
              height: '92px',
              borderRadius: '24px',
              backgroundColor: '#12171f',
              border: '1.5px solid rgba(98, 212, 200, 0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 40px rgba(98, 212, 200, 0.22)'
            }
          },
          renderLogo(68)
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              fontSize: '54px',
              fontWeight: '800',
              letterSpacing: '-0.035em'
            }
          },
          'butin',
          h('span', { style: { color: '#62d4c8' } }, '.')
        )
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 22px',
            borderRadius: '999px',
            backgroundColor: 'rgba(98, 212, 200, 0.08)',
            border: '1px solid rgba(98, 212, 200, 0.35)',
            color: '#62d4c8',
            fontSize: '13px',
            fontWeight: '700',
            letterSpacing: '0.14em'
          }
        },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#62d4c8' } }),
        titlePill
      )
    ),

    // Middle: Headline & Description
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', marginTop: '14px', marginBottom: '8px' } },
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            fontSize: '66px',
            fontWeight: '800',
            letterSpacing: '-0.03em',
            lineHeight: 1.12,
            color: '#eef1f5'
          }
        },
        h('span', null, headlinePre),
        h('span', { style: { color: '#62d4c8' } }, headlineAccent)
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            fontSize: '25px',
            color: '#8e9eaf',
            marginTop: '18px',
            lineHeight: 1.42,
            maxWidth: '960px'
          }
        },
        description
      )
    ),

    // Bottom Bar: Service Ecosystem + Supported Platforms
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          borderTop: '1px solid rgba(255, 255, 255, 0.09)',
          paddingTop: '22px'
        }
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        ...services.map((svc) =>
          h(
            'span',
            {
              key: svc,
              style: {
                display: 'flex',
                padding: '6px 14px',
                borderRadius: '8px',
                backgroundColor: '#141820',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#d0d8e2',
                fontSize: '13px',
                fontWeight: '500'
              }
            },
            svc
          )
        ),
        h(
          'span',
          {
            style: {
              display: 'flex',
              padding: '6px 12px',
              borderRadius: '8px',
              backgroundColor: 'rgba(98, 212, 200, 0.1)',
              border: '1px solid rgba(98, 212, 200, 0.25)',
              color: '#62d4c8',
              fontSize: '13px',
              fontWeight: '600'
            }
          },
          moreText
        )
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            color: '#6e7d91',
            fontSize: '13px',
            fontWeight: '600',
            letterSpacing: '0.04em'
          }
        },
        platformsText
      )
    )
  )
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// Generate English OG image
const imageEn = new ImageResponse(createCard({ locale: 'en' }), { width: 1200, height: 630 })
const outEn = join(rootDir, 'app', 'opengraph-image.png')

await writeFile(outEn, Buffer.from(await imageEn.arrayBuffer()))
console.log(`wrote ${outEn}`)

// Generate French OG image
const imageFr = new ImageResponse(createCard({ locale: 'fr' }), { width: 1200, height: 630 })
const outFrDir = join(rootDir, 'app', 'fr')

await mkdir(outFrDir, { recursive: true })
const outFr = join(outFrDir, 'opengraph-image.png')

await writeFile(outFr, Buffer.from(await imageFr.arrayBuffer()))
console.log(`wrote ${outFr}`)
