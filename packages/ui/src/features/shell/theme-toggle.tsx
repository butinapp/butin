import { Moon, Sun } from 'lucide-react'

import { useLabels } from '../../i18n/index.js'
import { Button } from '../../primitives.js'

// A compact light/dark switch for the top bar. Pure + prop-driven — the host owns theme state (@butinapp/ui
// ships no theme state); this renders the current mode and emits a toggle, showing the icon of the mode it
// switches TO. The label falls back to the i18n contract so an embed needn't pass one.
export const ThemeToggle = ({ isDark, onToggle, label }: { isDark: boolean; onToggle: () => void; label?: string }) => {
  const t = useLabels()
  const text = label ?? t.themeToggle

  return (
    <Button variant="ghost" size="icon" onClick={onToggle} aria-label={text} title={text}>
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
