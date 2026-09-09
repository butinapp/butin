import type { Metadata } from 'next'

import { Link } from '@/components/site-link'

export const metadata: Metadata = {
  title: 'Visite',
  description: 'Une visite interactive rapide de Butin — ce qu’il fait et comment l’utiliser.'
}

export default function FrenchTourPage() {
  return (
    <div className="fixed inset-0 bg-black">
      <iframe src="/onboarding-fr.html" title="Butin — visite interactive" className="h-full w-full border-0" />
      <Link
        href="/fr"
        style={{ position: 'fixed', top: 20, right: 24, zIndex: 50 }}
        className="rounded-full border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-xs text-white/70 backdrop-blur transition-colors hover:text-white"
      >
        ← retour au site
      </Link>
    </div>
  )
}
