import { useQuery } from '@tanstack/react-query'
import { createLazyRoute, useNavigate } from '@tanstack/react-router'

import { serviceTabRoute } from './service.js'
import { ServiceView } from './service/service-view.js'

// The routed service page: reads params, finds the plugin, and drives ServiceView. The beforeLoad guard
// (service.tsx) has already redirected unknown ids and the no-tab case, so plugin is present here.
const ServiceRoute = () => {
  const { serviceId, tab } = serviceTabRoute.useParams()
  const navigate = useNavigate()
  const { data: plugins = [] } = useQuery({ queryKey: ['plugins'], queryFn: () => window.butin.services.list() })
  const plugin = plugins.find((p) => p.id === serviceId)

  if (!plugin) {
    return null
  }

  return (
    <ServiceView
      key={plugin.id}
      plugin={plugin}
      activeTab={tab}
      onSelectTab={(next) => void navigate({ to: '/service/$serviceId/$tab', params: { serviceId, tab: next } })}
    />
  )
}

export const Route = createLazyRoute('/service/$serviceId/$tab')({ component: ServiceRoute })
