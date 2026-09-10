import type { ReactNode } from 'react'

import { useLabels } from '../../i18n/index.js'
import { cn, Tabs, TabsList, TabsTrigger } from '../../primitives.js'
import { type CapabilityView } from '../../types.js'

export interface ServiceTab {
  capability: CapabilityView
  body: ReactNode
  // A trailing tab (e.g. Settings) floats to the right edge, set apart from the data tabs. The first
  // trailing tab gets the `ml-auto` that pushes it (and any after it) over.
  trailing?: boolean
  // Optional leading icon for the trigger (used by the Settings gear).
  icon?: ReactNode
}

// The per-service tab bar (one tab per capability) over the active tab's body. `value`/`onValueChange`
// are controlled by the host so the active tab maps to the URL. We render only the active body (not a
// TabsContent per tab) so inactive tabs never mount — that's what makes per-tab lazy loading work.
// The body wrapper is KEYED by the active capability id so switching tabs remounts a fresh body instead
// of React reusing one instance across tabs (same component type at the same position). Without the key,
// a tab's in-component state — a just-run refresh result, fetch/auto-run refs — bleeds into the next tab,
// so the highlight moves but the content below keeps showing the previous tab's data.
export const ServiceTabs = ({
  tabs,
  active,
  onSelect
}: {
  tabs: ServiceTab[]
  active: string
  onSelect: (capabilityId: string) => void
}) => {
  const t = useLabels()
  const current = tabs.find((tab) => tab.capability.id === active) ?? tabs[0]

  if (!current) {
    return null
  }

  const firstTrailingId = tabs.find((tab) => tab.trailing)?.capability.id

  return (
    <Tabs value={current.capability.id} onValueChange={onSelect}>
      <TabsList data-testid="capability-tabs" variant="line">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.capability.id}
            value={tab.capability.id}
            className={cn(tab.capability.id === firstTrailingId && 'ml-auto')}
          >
            {tab.icon}
            {t.s(tab.capability.label)}
          </TabsTrigger>
        ))}
      </TabsList>
      <div key={current.capability.id} className="pt-3">
        {current.body}
      </div>
    </Tabs>
  )
}
