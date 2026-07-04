import { createRoute } from '@tanstack/react-router'

import { rootRoute } from './root.js'

export const managementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/management'
}).lazy(() => import('./management.lazy.js').then((m) => m.Route))
