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
    type: 'website',
    images: [
      {
        url: '/opengraph-image.png',
        width: 1200,
        height: 630,
        alt: 'Butin — your data, brought home'
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Butin — your data, brought home',
    description:
      'A local-first desktop app that puts all your accounts in one place. Billing, usage, and documents stored locally on your machine.',
    images: ['/opengraph-image.png']
  }
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
