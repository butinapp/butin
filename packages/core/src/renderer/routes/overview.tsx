import { createRoute } from '@tanstack/react-router'

import { rootRoute } from './root.js'

export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/'
}).lazy(() => import('./overview.lazy.js').then((m) => m.Route))
