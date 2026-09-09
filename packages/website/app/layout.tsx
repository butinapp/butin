import './global.css'
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import { lazy, type ReactNode } from 'react'

// Lazy so the Orama runtime and the downloaded index stay out of the initial bundle of a marketing page that may
// never open search. Fumadocs preloads the dialog on hover/focus of the search trigger.
const StaticSearchDialog = lazy(() => import('@/components/search-dialog'))

const sans = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-space', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jet', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL('https://butin.app'),
  title: {
    default: 'Butin — your data, brought home',
    template: '%s · Butin'
  },
  description:
    'A local-first desktop app that pulls the billing, usage, and records your services keep behind their own dashboards — using your own login — and keeps every byte on your machine.',
  applicationName: 'Butin',
  openGraph: {
    title: 'Butin — your data, brought home',
    description:
      'A local-first desktop app that puts all your accounts in one place. Billing, usage, and documents stored locally on your machine.',
    url: 'https://butin.app',
    siteName: 'Butin',
    type: 'website'
  },
  twitter: { card: 'summary_large_image', title: 'Butin', description: 'Your data, brought home.' }
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable} dark`}
      style={{ colorScheme: 'dark' }}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        {/*
          Cloudflare Web Analytics — cookieless, stores no PII, sets nothing on the visitor's machine, so it needs no
          consent banner under Law 25. That is the whole reason it is here and GA4 is not: this is the site of a
          product whose claim is that your data stays on your machine.

          The beacon is inline rather than left to Cloudflare's "automatic setup", which is enabled on this site
          (`auto_install: true`) and demonstrably injects nothing — checked 2026-09-09 across four hostnames on this
          account, Worker-served and droplet-served alike, and none of them carried the script.

          The token is public by design: it ships in the HTML of every page it measures, exactly like a GA
          measurement id. It is not a secret and does not belong in a build arg.
        */}
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "5e83a33c90674d7abb81169668c6d532"}'
        />
        <RootProvider
          theme={{ defaultTheme: 'dark', enableSystem: false }}
          search={{ SearchDialog: StaticSearchDialog }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
