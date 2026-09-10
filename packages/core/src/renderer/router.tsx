import type { QueryClient } from '@tanstack/react-query'
import { createHashHistory, createRouter } from '@tanstack/react-router'

import { developerRoute } from './routes/developer.js'
import { managementRoute } from './routes/management.js'
import { overviewRoute } from './routes/overview.js'
import { peopleRoute } from './routes/people.js'
import { rootRoute } from './routes/root.js'
import { serviceIndexRoute, serviceTabRoute } from './routes/service.js'

const routeTree = rootRoute.addChildren([
  overviewRoute,
  peopleRoute,
  managementRoute,
  developerRoute,
  serviceIndexRoute,
  serviceTabRoute
])

// Hash history is mandatory under Electron's file:// — it keeps reload + back/forward working.
export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, history: createHashHistory(), context: { queryClient }, defaultPreload: false })

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  // Module augmentation: TanStack reads the router type off its own `Register`, which only interface merging
  // can extend — a type alias here collides with the library's declaration instead of adding to it.
  interface Register {
    router: AppRouter
  }
}
