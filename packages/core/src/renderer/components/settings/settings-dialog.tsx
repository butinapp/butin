import { useLabels } from '@butinapp/ui/i18n'
import { cn, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@butinapp/ui/primitives'
import { Bell, Chrome, Info, HardDrive, Settings2, ShieldCheck, SlidersHorizontal, Stethoscope } from 'lucide-react'
import type { ReactNode } from 'react'

import { AboutPane } from './about-pane.js'
import { AdvancedPane } from './advanced-pane.js'
import { AlertsSettingsPane } from './alerts-pane.js'
import { BrowserSigninPane } from './browser-signin-pane.js'
import { DataPrivacyPane } from './data-privacy-pane.js'
import { GeneralPane } from './general-pane.js'
import { StoragePane } from './storage-pane.js'
import { SystemPane } from './system-pane.js'

// The settings sections, in sub-nav order. `system` carries the runtime/storage/plugin-warning info.
export const SETTINGS_SECTIONS = [
  'general',
  'alerts',
  'data',
  'browser',
  'advanced',
  'storage',
  'system',
  'about'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

const renderPane = (section: SettingsSection): ReactNode => {
  switch (section) {
    case 'general':
      return <GeneralPane />
    case 'alerts':
      return <AlertsSettingsPane />
    case 'data':
      return <DataPrivacyPane />
    case 'browser':
      return <BrowserSigninPane />
    case 'advanced':
      return <AdvancedPane />
    case 'storage':
      return <StoragePane />
    case 'system':
      return <SystemPane />
    case 'about':
      return <AboutPane />
  }
}

// Settings as a centered modal: a section sub-nav on the left, the active pane (scrollable) on the right —
// reachable from any page via the top-bar gear without losing context. Controlled by the host (open + active
// section), so a deep entry (e.g. the load-failure banner) can open it straight to a section. Settings is app
// chrome (theme picker, locale, IPC, Electron), so it lives in core, not the embeddable `@butinapp/ui`.
export const SettingsDialog = ({
  open,
  onOpenChange,
  section,
  onSectionChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
}) => {
  const t = useLabels()

  const navItems: { id: SettingsSection; label: string; icon: ReactNode }[] = [
    { id: 'general', label: t.settingsNavGeneral, icon: <SlidersHorizontal className="size-4 shrink-0" /> },
    { id: 'alerts', label: t.notifications.title, icon: <Bell className="size-4 shrink-0" /> },
    { id: 'data', label: t.sectionDataPrivacy, icon: <ShieldCheck className="size-4 shrink-0" /> },
    { id: 'browser', label: t.settingsNavBrowserSignin, icon: <Chrome className="size-4 shrink-0" /> },
    { id: 'advanced', label: t.settingsNavAdvanced, icon: <Settings2 className="size-4 shrink-0" /> },
    { id: 'storage', label: t.settingsNavStorage, icon: <HardDrive className="size-4 shrink-0" /> },
    { id: 'system', label: t.settingsNavSystem, icon: <Stethoscope className="size-4 shrink-0" /> },
    { id: 'about', label: t.sectionAbout, icon: <Info className="size-4 shrink-0" /> }
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed height (capped, viewport-relative) so switching sections scrolls the pane instead of resizing —
          and recentering — the whole dialog. */}
      <DialogContent className="h-[min(90vh,52rem)] max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t.settingsTitle}</DialogTitle>
          {/* The section sub-nav + each pane's own heading already say where you are, so the subtitle is noise;
              it stays in the accessibility tree (so the dialog keeps a description) but is hidden visually. */}
          <DialogDescription className="sr-only">{t.settingsSubtitle}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-4 sm:gap-6">
          <nav className="flex w-36 shrink-0 flex-col gap-0.5 sm:w-40">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => onSectionChange(item.id)}
                aria-current={item.id === section ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  item.id === section
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                {item.icon}
                <span className="min-w-0 leading-tight">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto pr-1">{renderPane(section)}</div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
