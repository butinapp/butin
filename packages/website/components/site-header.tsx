import Link from 'next/link'

import { BrandMark, Wordmark } from './brand'

const GITHUB = 'https://github.com/allardy/butin'

const nav = [
  { href: '/docs', label: 'Docs' },
  { href: '/services', label: 'Services' },
  { href: '/tour', label: 'Tour' }
]

export const SiteHeader = () => (
  <header className="sticky top-0 z-50 border-b border-line/80 bg-bg/70 backdrop-blur-xl">
    <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-8 px-5">
      <Link href="/" className="flex items-center gap-2.5">
        <BrandMark className="size-7" />
        <Wordmark className="text-lg" />
      </Link>

      <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className="transition-colors hover:text-ink">
            {item.label}
          </Link>
        ))}
        <a href={GITHUB} className="transition-colors hover:text-ink" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <a
          href={`${GITHUB}/releases`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-teal/40 bg-teal/10 px-4 py-1.5 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15"
        >
          Download
        </a>
      </div>
    </div>
  </header>
)
