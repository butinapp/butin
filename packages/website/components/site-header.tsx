'use client'

import { useState } from 'react'

import { BrandMark, Wordmark } from './brand'

import { Link } from '@/components/site-link'
import { GITHUB } from '@/lib/links'

const nav = [
  { href: '/docs', label: 'Docs' },
  { href: '/services', label: 'Services' },
  { href: '/tour', label: 'Tour' }
]

export const SiteHeader = () => {
  const [open, setOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-8 px-5">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
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
            className="hidden sm:inline-flex rounded-full border border-teal/40 bg-teal/10 px-4 py-1.5 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15"
          >
            Download
          </a>

          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="grid size-9 place-items-center rounded-lg border border-line text-muted transition-colors hover:border-line-strong hover:text-ink md:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-b border-line bg-bg/95 px-5 py-4 backdrop-blur-xl md:hidden">
          <nav className="flex flex-col gap-3 font-mono text-sm">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="py-1.5 text-muted transition-colors hover:text-ink"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="py-1.5 text-muted transition-colors hover:text-ink"
            >
              GitHub ↗
            </a>
            <div className="pt-2 border-t border-line">
              <a
                href={`${GITHUB}/releases`}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className="inline-flex w-full items-center justify-center rounded-full border border-teal/40 bg-teal/10 px-4 py-2 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15"
              >
                Download Butin
              </a>
            </div>
          </nav>
        </div>
      )}
    </header>
  )
}
