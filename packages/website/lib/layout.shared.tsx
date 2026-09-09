import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

import { BrandMark, Wordmark } from '@/components/brand'
import { GITHUB } from '@/lib/links'

// Shared Fumadocs chrome (the /docs nav). Brand mark + wordmark; links back to the marketing site.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <BrandMark className="size-6" />
          <Wordmark className="text-base" />
        </span>
      ),
      url: '/'
    },
    links: [
      { text: 'Services', url: '/services' },
      { text: 'Tour', url: '/tour' },
      { text: 'Français', url: '/fr/docs' }
    ],
    githubUrl: GITHUB
  }
}

export function baseOptionsFr(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <BrandMark className="size-6" />
          <Wordmark className="text-base" />
        </span>
      ),
      url: '/fr'
    },
    links: [
      { text: 'Services', url: '/fr/services' },
      { text: 'Visite', url: '/fr/tour' },
      { text: 'English', url: '/docs' }
    ],
    githubUrl: GITHUB
  }
}
