import { formatMoney } from '@butinapp/ui/dashboard'
import { formatRelative, useLabels } from '@butinapp/ui/i18n'
import { Button } from '@butinapp/ui/primitives'
import { AppShell, Sidebar, type SidebarTarget } from '@butinapp/ui/shell'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  Navigate,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState
} from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { activeFromPath } from './route-helpers.js'

import { formatNotification, NotificationBell } from '@/chrome'
import { BrandMark } from '@/components/brand-mark'
import { ProfileMenu } from '@/components/profile-menu'
import { SettingsDialog, type SettingsSection } from '@/components/settings/settings-dialog'
import { ThemeToggleButton } from '@/components/theme-toggle-button'
import { usePluginState } from '@/use-plugin-state'
import { titleBarInset, useTitleBarOverlaySync } from '@/use-titlebar'

// Carried in the router context so beforeLoad guards can read cached IPC data (the plugin list).
export interface RouterContext {
  queryClient: QueryClient
}

// The app chrome: top bar (brand + settings) over the sidebar; <Outlet/> swaps the routed body. Owns the
// sidebar's data (services + loaded dots) and translates its callbacks into router navigation.
const RootLayout = () => {
  const t = useLabels()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data: plugins = [] } = useQuery({ queryKey: ['plugins'], queryFn: () => window.butin.services.list() })
  const { data: tiles = [] } = useQuery({ queryKey: ['overview'], queryFn: () => window.butin.reports.overview() })
  const { data: loadFailures = [] } = useQuery({
    queryKey: ['pluginLoadFailures'],
    queryFn: () => window.butin.app.diagnostics().then((d) => d.failed)
  })
  const { connStateOf, isTesting } = usePluginState()
  const router = useRouter()
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => window.butin.settings.get() })
  const { data: fx } = useQuery({ queryKey: ['fxConfig'], queryFn: () => window.butin.settings.getFx() })
  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => window.butin.notifications.list()
  })

  // A refresh re-evaluates alerts in main and pushes this event — refetch so the bell stays live.
  useEffect(
    () => window.butin.onNotificationsChanged(() => void qc.invalidateQueries({ queryKey: ['notifications'] })),
    [qc]
  )

  const refreshNotifs = (): void => void qc.invalidateQueries({ queryKey: ['notifications'] })
  const serviceName = (id?: string): string => plugins.find((p) => p.id === id)?.name ?? id ?? ''

  // Settings is a modal reachable from any page (top-bar gear). The host owns open + active section so a deep
  // entry — the load-failure banner — can open it straight to the System section.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')

  const openSettings = (section?: SettingsSection): void => {
    if (section) {
      setSettingsSection(section)
    }

    setSettingsOpen(true)
  }

  useTitleBarOverlaySync()

  // Start page = "last visited": remember the last meaningful route, and on the initial landing restore it.
  // Overview (`/`) is the default, so it's never recorded — restoring nothing just leaves you on Overview.
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current || !settings) {
      return
    }

    restored.current = true

    if (settings.startPage === 'last' && pathname === '/') {
      const last = localStorage.getItem('butin:lastRoute')

      if (last && last !== '/') {
        router.history.push(last)
      }
    }
  }, [settings, pathname, router])

  useEffect(() => {
    if (pathname !== '/') {
      localStorage.setItem('butin:lastRoute', pathname)
    }
  }, [pathname])

  const loadedIds = new Set(tiles.filter((tile) => tile.lastRunAt).map((tile) => tile.pluginId))
  // The sidebar lists every INSTALLED service. Not-yet-installed (Available) plugins live on the Management
  // page; a paused (installed-but-disabled) service still shows here, dimmed and inert, so it's not silently
  // gone — it just can't be opened until re-enabled. The dot shows when a (non-disabled) service has cached
  // data OR is being tested right now (so a Test-all sweep is visible here too, even with no data yet).
  const services = plugins
    .filter((p) => p.installed)
    .map((p) => {
      const disabled = p.enabled === false
      const testing = !disabled && isTesting(p.id)

      return {
        id: p.id,
        name: p.name,
        color: p.color,
        icon: p.icon,
        disabled,
        dot: !disabled && (loadedIds.has(p.id) || testing) ? connStateOf(p) : undefined,
        testing
      }
    })
  const active = activeFromPath(pathname)

  const select = (target: SidebarTarget): void => {
    if (target.kind === 'service') {
      void navigate({ to: '/service/$serviceId', params: { serviceId: target.serviceId } })
    } else if (target.kind === 'management') {
      void navigate({ to: '/management' })
    } else if (target.kind === 'developer') {
      void navigate({ to: '/developer' })
    } else {
      void navigate({ to: '/' })
    }
  }

  return (
    <>
      <AppShell
        inset={titleBarInset}
        brand={
          <button
            onClick={() => {
              void navigate({ to: '/' })
              // Already on Overview but scrolled down? Navigation is a no-op, so bring the content back to the top.
              document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            className="flex items-center gap-2.5"
            aria-label={t.homeAria}
          >
            <BrandMark className="size-6 text-foreground" />
            <span className="font-display text-[15px] font-semibold tracking-tight">Butin</span>
          </button>
        }
        actions={
          <div className="flex items-center gap-1">
            <NotificationBell
              items={notifications}
              format={(n) =>
                formatNotification(n, {
                  serviceName,
                  baseCurrency: fx?.baseCurrency ?? 'USD',
                  money: (v, ccy) => formatMoney(v, ccy ?? fx?.baseCurrency ?? 'USD'),
                  pct: (f) => `${Math.round(f * 100)}%`,
                  labels: t.notifications
                })
              }
              formatTime={(iso) => {
                const at = new Date(iso)

                return Number.isNaN(at.getTime()) ? '' : formatRelative(at, new Date(), t.intlLocale)
              }}
              onMarkRead={(id) => void window.butin.notifications.markRead(id).then(refreshNotifs)}
              onMarkAll={() => void window.butin.notifications.markAllRead().then(refreshNotifs)}
              onDismiss={(id) => void window.butin.notifications.dismiss(id).then(refreshNotifs)}
              onAction={(n) =>
                n.kind === 'health'
                  ? openSettings('data')
                  : n.pluginId && n.pluginId !== '__total__'
                    ? void navigate({ to: '/service/$serviceId', params: { serviceId: n.pluginId } })
                    : void navigate({ to: '/' })
              }
              labels={{
                title: t.notifications.title,
                empty: t.notifications.empty,
                markAll: t.notifications.markAll,
                dismiss: t.notifications.dismiss,
                unread: t.notifications.unread
              }}
            />
            <ThemeToggleButton />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.navSettings}
              title={t.navSettings}
              onClick={() => openSettings()}
            >
              <Settings className="size-4" />
            </Button>
            <ProfileMenu />
          </div>
        }
        sidebar={({ onNavigate }) => (
          <Sidebar
            services={services}
            active={active}
            onSelect={select}
            onNavigate={onNavigate}
            onOpenSettings={() => openSettings()}
            showDeveloper={settings?.devMode ?? false}
          />
        )}
      >
        {loadFailures.length > 0 && (
          <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <span className="font-medium">
              {loadFailures.length} plugin{loadFailures.length > 1 ? 's' : ''} failed to load
            </span>{' '}
            and {loadFailures.length > 1 ? 'were' : 'was'} skipped —{' '}
            {loadFailures.map((f) => `${f.path} (${f.reason})`).join(', ')}{' '}
            <button onClick={() => openSettings('system')} className="font-medium underline underline-offset-2">
              View details
            </button>
          </div>
        )}
        <Outlet />
      </AppShell>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
      />
    </>
  )
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: () => <Navigate to="/" replace />
})
