import { useQuery } from '@tanstack/react-query'
import { createLazyRoute, Navigate } from '@tanstack/react-router'

import { DeveloperPanel } from '@/chrome'

// The Developer panel is dev-mode-only; a stale hash with dev mode off redirects to Overview.
const DeveloperView = () => {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => window.butin.settings.get() })

  if (settings && !settings.devMode) {
    return <Navigate to="/" replace />
  }

  return <DeveloperPanel />
}

export const Route = createLazyRoute('/developer')({ component: DeveloperView })
