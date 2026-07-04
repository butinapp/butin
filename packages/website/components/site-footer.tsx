import Link from 'next/link'

import { BrandMark, Wordmark } from './brand'

import { GITHUB } from '@/lib/links'

const columns: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/', label: 'Overview' },
      { href: '/services', label: 'Services' },
      { href: '/tour', label: 'Tour' },
      { href: `${GITHUB}/releases`, label: 'Download', external: true }
    ]
  },
  {
    title: 'Docs',
    links: [
      { href: '/docs', label: 'Getting started' },
      { href: '/docs/connecting-a-service', label: 'Connect a service' },
      { href: '/docs/how-it-works', label: 'How it works' },
      { href: '/docs/contributing', label: 'Write a plugin' }
    ]
  },
  {
    title: 'Open source',
    links: [
      { href: GITHUB, label: 'Star on GitHub', external: true },
      { href: `${GITHUB}/blob/master/LICENSE`, label: 'MIT License', external: true },
      { href: `${GITHUB}/issues`, label: 'Issues', external: true }
    ]
  }
]

export const SiteFooter = () => (
  <footer className="mt-24 border-t border-line">
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)]">
      <div className="max-w-xs">
        <Link href="/" className="flex items-center gap-2.5">
          <BrandMark className="size-7" />
          <Wordmark className="text-lg" />
        </Link>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          The data your services keep behind their own dashboards — fetched with your own login, kept on your machine.
        </p>
        <p className="mt-4 font-mono text-xs text-teal-soft">Your data, brought home.</p>
      </div>

      {columns.map((col) => (
        <div key={col.title}>
          <h3 className="font-mono text-xs uppercase tracking-wider text-muted">{col.title}</h3>
          <ul className="mt-4 space-y-2.5 text-sm">
            {col.links.map((link) =>
              link.external ? (
                <li key={link.label}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink/80 transition-colors hover:text-teal-soft"
                  >
                    {link.label}
                  </a>
                </li>
              ) : (
                <li key={link.label}>
                  <Link href={link.href} className="text-ink/80 transition-colors hover:text-teal-soft">
                    {link.label}
                  </Link>
                </li>
              )
            )}
          </ul>
        </div>
      ))}
    </div>

    <div className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-6 font-mono text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>© {new Date().getFullYear()} Butin · MIT · local-first</span>
        <span>Your data, brought home.</span>
      </div>
    </div>
  </footer>
)
