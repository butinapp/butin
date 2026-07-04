import type { QueryClient } from '@tanstack/react-query'
import { createRoute, redirect } from '@tanstack/react-router'

import { rootRoute } from './root.js'
import { firstTabFor, SETTINGS_TAB_ID } from './route-helpers.js'

const ensurePlugins = (queryClient: QueryClient) =>
  queryClient.ensureQueryData({ queryKey: ['plugins'], queryFn: () => window.butin.services.list() })

// /service/$serviceId with no tab → redirect to the plugin's first capability (or home if the id is unknown).
export const serviceIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/service/$serviceId',
  beforeLoad: async ({ context, params }) => {
    const plugins = await ensurePlugins(context.queryClient)
    const plugin = plugins.find((p) => p.id === params.serviceId)

    if (!plugin) {
      throw redirect({ to: '/' })
    }

    throw redirect({
      to: '/service/$serviceId/$tab',
      params: {
        serviceId: params.serviceId,
        // A disabled plugin has no working data tab — land on Settings, where the Enable toggle is.
        tab: plugin.enabled === false ? SETTINGS_TAB_ID : firstTabFor(plugin)
      }
    })
  }
})

// /service/$serviceId/$tab → the service page. Guard only redirects unknown ids; the page renders the rest.
export const serviceTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/service/$serviceId/$tab',
  beforeLoad: async ({ context, params }) => {
    const plugins = await ensurePlugins(context.queryClient)
    const plugin = plugins.find((p) => p.id === params.serviceId)

    if (!plugin) {
      throw redirect({ to: '/' })
    }

    // A disabled plugin has no working data link: any tab other than Settings redirects to Settings,
    // where the Enable toggle lives. Closes the deep-link / stale-tab-after-reload leak.
    if (plugin.enabled === false && params.tab !== SETTINGS_TAB_ID) {
      throw redirect({
        to: '/service/$serviceId/$tab',
        params: { serviceId: params.serviceId, tab: SETTINGS_TAB_ID }
      })
    }
  }
}).lazy(() => import('./service.lazy.js').then((m) => m.Route))
