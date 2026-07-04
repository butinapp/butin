import { type Locale } from '@butinapp/ui/i18n'
import { cn } from '@butinapp/ui/primitives'

import { useLocaleSetting } from '@/components/locale-provider'

const OPTIONS: { value: Locale; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'fr', label: 'FR' }
]

// Compact EN / FR segmented picker. Drives the core locale setting.
export const LanguageToggle = () => {
  const { locale, setLocale } = useLocaleSetting()

  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={locale === value}
          onClick={() => setLocale(value)}
          className={cn(
            'flex h-7 min-w-9 items-center justify-center rounded-sm px-2 text-xs font-medium transition-colors',
            locale === value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
