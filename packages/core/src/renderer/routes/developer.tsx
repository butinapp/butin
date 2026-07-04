import { createRoute } from '@tanstack/react-router'

import { rootRoute } from './root.js'

export const developerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/developer'
}).lazy(() => import('./developer.lazy.js').then((m) => m.Route))
