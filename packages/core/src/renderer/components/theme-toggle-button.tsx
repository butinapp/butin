import { ThemeToggle } from '@butinapp/ui/shell'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

// Top-bar quick switch: flips the RESOLVED theme so it always lands on the opposite of what's on screen, even
// when the user's saved choice is 'system'. Full light/system/dark control stays in Settings → Appearance.
// The mounted guard avoids a hydration/first-paint flash before next-themes resolves the active theme.
export const ThemeToggleButton = () => {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) {
    return <div className="size-9" />
  }

  const isDark = resolvedTheme === 'dark'

  return <ThemeToggle isDark={isDark} onToggle={() => setTheme(isDark ? 'light' : 'dark')} />
}
