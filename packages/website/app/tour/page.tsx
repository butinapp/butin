import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Tour',
  description: 'A quick interactive tour of Butin — what it does and how to use it.'
}

// Full-bleed route (outside the marketing chrome) that serves the standalone onboarding deck verbatim.
// The deck is a self-contained HTML doc with its own styles + keyboard/scroll navigation, so an iframe is
// the clean reuse. The deck lives at public/onboarding.html.
export default function TourPage() {
  return (
    <div className="fixed inset-0 bg-black">
      <iframe src="/onboarding.html" title="Butin — interactive tour" className="h-full w-full border-0" />
      <Link
        href="/"
        style={{ position: 'fixed', top: 20, right: 24, zIndex: 50 }}
        className="rounded-full border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-xs text-white/70 backdrop-blur transition-colors hover:text-white"
      >
        ← back to site
      </Link>
    </div>
  )
}
