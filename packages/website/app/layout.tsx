import './global.css'
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import type { ReactNode } from 'react'

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
    description: "Their session expires. Your data doesn't. Your data, normalized and on your machine.",
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
        <RootProvider theme={{ defaultTheme: 'dark', enableSystem: false }}>{children}</RootProvider>
      </body>
    </html>
  )
}
