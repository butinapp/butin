import Link from 'next/link'

import { BrandMark } from '@/components/brand'

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-5 text-center">
      <BrandMark className="mb-6 size-16 text-muted/60" />
      <p className="font-mono text-xs uppercase tracking-[0.24em] text-teal">404 · Not Found</p>
      <h1
        className="mt-3 text-3xl font-bold tracking-tight text-ink md:text-4xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Page not found
      </h1>
      <p className="mt-3 max-w-md text-sm text-muted">The page you are looking for doesn&apos;t exist or has moved.</p>
      <div className="mt-8 flex items-center gap-4">
        <Link
          href="/"
          className="rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-bg transition-transform hover:scale-[1.02]"
        >
          Back to home
        </Link>
        <Link
          href="/docs"
          className="rounded-full border border-line-strong px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-teal/50 hover:text-teal-soft"
        >
          View docs
        </Link>
      </div>
    </div>
  )
}
