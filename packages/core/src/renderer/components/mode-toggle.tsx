import { cn } from '@butinapp/ui/primitives'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon }
] as const

// A compact segmented Light / System / Dark picker. `theme` is the user's choice (not the resolved
// value), so 'system' stays highlighted while following the OS.
export const ModeToggle = () => {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) {
    return <div className="h-8 w-[5.75rem]" />
  }

  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            'flex size-7 items-center justify-center rounded-sm transition-colors',
            theme === value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  )
}
