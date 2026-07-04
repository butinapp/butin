import { createRoute } from '@tanstack/react-router'

import { rootRoute } from './root.js'

export const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/people'
}).lazy(() => import('./people.lazy.js').then((m) => m.Route))
