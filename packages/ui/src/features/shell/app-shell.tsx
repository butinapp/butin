import { Menu } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useLabels } from '../../i18n/index.js'
import { Button, Sheet, SheetContent, SheetTitle, SheetTrigger } from '../../primitives.js'

// The app frame: a slim sticky top bar over a sidebar/content body. The bar splits into a brand cell that
// sits in the sidebar column — same `w-56` width, its `border-r` continuing the sidebar divider so the
// wordmark anchors the rail rather than floating — and a content header holding the right-aligned `actions`
// slot. `sidebar` is a render prop so the same node renders inline on desktop and inside a closing Sheet on
// mobile — `onNavigate` closes the sheet after a pick. Pure + prop-driven; no IPC, no theme state.
// (SheetContent is a right-side slide-over by default; we override position to left for the nav drawer.)
//
// The header doubles as the OS title-bar drag handle when the host hides the native frame (`app-region: drag`,
// ignored in a browser); its 48px height must match the native window-controls overlay height the host sets.
// Interactive controls opt back out with `no-drag`, and `inset` reserves space on the side the native window
// controls occupy (right on Windows/Linux, left for macOS traffic lights) so the brand + actions never sit
// under them.
export const AppShell = ({
  brand,
  actions,
  sidebar,
  inset,
  children
}: {
  brand: ReactNode
  actions?: ReactNode
  sidebar: (ctx: { onNavigate: () => void }) => ReactNode
  inset?: { left?: number; right?: number }
  children: ReactNode
}) => {
  const t = useLabels()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="bg-background flex h-full flex-col overflow-hidden">
      <header className="bg-card sticky top-0 z-40 flex h-12 shrink-0 items-center border-b [-webkit-app-region:drag]">
        {inset?.left ? <div aria-hidden style={{ width: inset.left }} /> : null}
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-2 [-webkit-app-region:no-drag] md:hidden"
              aria-label={t.menuLabel}
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent className="right-auto left-0 w-56 max-w-[14rem] border-r border-l-0 p-0">
            <SheetTitle className="sr-only">{t.menuLabel}</SheetTitle>
            {sidebar({ onNavigate: () => setMenuOpen(false) })}
          </SheetContent>
        </Sheet>

        <div className="flex h-full items-center px-4 [-webkit-app-region:no-drag] md:w-56 md:shrink-0 md:border-r">
          {brand}
        </div>

        <div className="flex flex-1 items-center px-4 sm:px-6">
          <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">{actions}</div>
        </div>
        {inset?.right ? <div aria-hidden style={{ width: inset.right }} /> : null}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="hidden md:flex">{sidebar({ onNavigate: () => {} })}</div>
        <main className="flex-1 overflow-auto">
          <div className="w-full px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
