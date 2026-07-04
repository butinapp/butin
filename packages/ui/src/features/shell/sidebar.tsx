import { Database, LayoutGrid, Search, Settings, Users, Wrench } from 'lucide-react'
import { useState } from 'react'

import { useLabels } from '../../i18n/index.js'
import { cn, Input, ServiceIcon } from '../../primitives.js'

import { ConnDot, type ConnState } from './conn-state.js'

// Connection-confidence dot, shown only when the service has cached data. Drawn by the shared ConnDot so
// every status surface looks identical. undefined = no dot.
export type SidebarDot = ConnState

export interface SidebarService {
  id: string
  name: string
  color?: string
  icon?: string
  dot?: SidebarDot
  // Shared in-flight probe flag (from the host's usePluginState) — pulses this rail's dot in lock-step with
  // the same service's dot on every other surface while it's being tested.
  testing?: boolean
  // Installed but switched off in Management. Still listed (so it's not silently gone) but dimmed + inert —
  // no navigation, no dot, a tooltip points back to Management to re-enable it.
  disabled?: boolean
}

// A navigation destination: the set of places the sidebar links to. A click EMITS one (core maps it onto its
// route, resolving the default tab for a service); the current selection — derived from the URL — IS one and
// drives the active highlight. One shape, one discriminant, so the two roles can never drift apart.
export type SidebarTarget =
  | { kind: 'overview' }
  | { kind: 'people' }
  | { kind: 'management' }
  | { kind: 'developer' }
  | { kind: 'service'; serviceId: string }

// The current selection. Same destinations as a click target — aliased (not redefined) so it reads as intent
// at call sites without a parallel union to maintain.
export type SidebarActive = SidebarTarget

const rowClass = (active: boolean): string =>
  cn(
    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
    active
      ? 'bg-secondary text-secondary-foreground'
      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
  )

// The fixed left rail: Management link, then a searchable service list with Overview pinned first. Each
// service shows its brand-color icon and a connection-confidence dot (when it has data). Pure +
// prop-driven; the host owns navigation. `onNavigate` lets a mobile sheet close itself after a pick.
export const Sidebar = ({
  services,
  active,
  onSelect,
  onNavigate,
  onOpenSettings,
  showManagement = true,
  showPeople = false,
  showDeveloper = true
}: {
  services: SidebarService[]
  active: SidebarActive
  onSelect: (target: SidebarTarget) => void
  onNavigate?: () => void
  // Opens the Settings modal. Settings is a dialog, not a route, so it's an action (never an active row), pinned
  // in the system section so it's reachable from the rail. Absent in an offline embed (the viewer has no settings).
  onOpenSettings?: () => void
  // The Management link is app chrome (connection health + actions). An offline embed (the viewer) has
  // nothing to manage, so it hides it.
  showManagement?: boolean
  // The People page (cross-service access audit) is app chrome backed by IPC — hosts that have it opt in;
  // an offline embed leaves it hidden.
  showPeople?: boolean
  // The Developer link (Logs · Cookie Jar · Tools) is a dev-mode/power-user surface — the host gates it on
  // its dev-mode setting, and an offline embed (the viewer) hides it.
  showDeveloper?: boolean
}) => {
  const t = useLabels()
  const [query, setQuery] = useState('')
  const filtered = services.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))

  const go = (target: SidebarTarget): void => {
    onSelect(target)
    onNavigate?.()
  }

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex w-56 shrink-0 flex-col gap-3 border-r p-3">
      <div className="space-y-2">
        <div className="text-muted-foreground px-2 text-[10px] font-medium tracking-wider uppercase">
          {t.servicesHeading}
        </div>
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <button className={rowClass(active.kind === 'overview')} onClick={() => go({ kind: 'overview' })}>
          <LayoutGrid className="size-4 shrink-0" />
          {t.navOverview}
        </button>

        {filtered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">{t.noServicesMatch}</p>
        ) : (
          filtered.map((s) => {
            const isActive = active.kind === 'service' && active.serviceId === s.id

            if (s.disabled) {
              return (
                <div
                  key={s.id}
                  title={t.sidebarDisabledHint}
                  aria-disabled
                  className={cn(rowClass(false), 'cursor-not-allowed opacity-40 hover:bg-transparent')}
                >
                  <ServiceIcon id={s.id} icon={s.icon} name={s.name} color={s.color} size={16} />
                  <span className="truncate">{s.name}</span>
                </div>
              )
            }

            return (
              <button
                key={s.id}
                className={rowClass(isActive)}
                onClick={() => go({ kind: 'service', serviceId: s.id })}
              >
                <ServiceIcon id={s.id} icon={s.icon} name={s.name} color={s.color} size={16} />
                <span className="truncate">{s.name}</span>
                {s.dot ? (
                  <ConnDot state={s.dot} testing={s.testing} className="ml-auto size-1.5 shrink-0" title={s.dot} />
                ) : null}
              </button>
            )
          })
        )}
      </div>

      {showManagement || showPeople || showDeveloper || onOpenSettings ? (
        <div className="space-y-0.5 border-t pt-2">
          <div className="text-muted-foreground px-2 pb-1 text-[10px] font-medium tracking-wider uppercase">
            {t.systemHeading}
          </div>
          {showManagement ? (
            <button className={rowClass(active.kind === 'management')} onClick={() => go({ kind: 'management' })}>
              <Database className="size-4 shrink-0" />
              {t.navManagement}
            </button>
          ) : null}
          {showPeople ? (
            <button className={rowClass(active.kind === 'people')} onClick={() => go({ kind: 'people' })}>
              <Users className="size-4 shrink-0" />
              {t.navPeople}
            </button>
          ) : null}
          {showDeveloper ? (
            <button className={rowClass(active.kind === 'developer')} onClick={() => go({ kind: 'developer' })}>
              <Wrench className="size-4 shrink-0" />
              {t.navDeveloper}
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              className={rowClass(false)}
              onClick={() => {
                onOpenSettings()
                onNavigate?.()
              }}
            >
              <Settings className="size-4 shrink-0" />
              {t.navSettings}
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}
