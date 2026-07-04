import { useLabels } from '@butinapp/ui/i18n'

import { Row, SelectField, SettingsGroup, useAppSettings } from './parts.js'

import { LanguageToggle } from '@/components/language-toggle'
import { ModeToggle } from '@/components/mode-toggle'

// General: where the app opens, the interface language and theme, plus how money and dates are displayed.
// Dates render in the machine's local zone.
export const GeneralPane = () => {
  const t = useLabels()
  const { settings, patch } = useAppSettings()

  return (
    <div className="space-y-5">
      <SettingsGroup>
        <SelectField
          label={t.startPageLabel}
          hint={t.startPageHint}
          value={settings?.startPage ?? 'overview'}
          onValueChange={(v) => patch({ startPage: v as 'overview' | 'last' })}
          options={[
            { value: 'overview', label: t.startPageOverview },
            { value: 'last', label: t.startPageLast }
          ]}
        />
        <Row title={t.sectionLanguage} hint={t.languageHint} control={<LanguageToggle />} />
        <Row title={t.themeLabel} hint={t.themeHint} control={<ModeToggle />} />
      </SettingsGroup>

      <SettingsGroup title={t.sectionFormatting}>
        <SelectField
          label={t.currencyFormatLabel}
          hint={t.currencyFormatHint}
          value={settings?.currencyStyle ?? 'match'}
          onValueChange={(v) => patch({ currencyStyle: v as 'match' | 'us' | 'fr' | 'eu' })}
          options={[
            { value: 'match', label: 'Match app language' },
            { value: 'us', label: 'US ($1,234.50)' },
            { value: 'fr', label: 'French (1 234,50 $)' },
            { value: 'eu', label: 'European (1.234,56 €)' }
          ]}
        />
        <SelectField
          label={t.dateFormatLabel}
          hint={t.dateFormatHint}
          value={settings?.dateFormat ?? 'locale'}
          onValueChange={(v) => patch({ dateFormat: v as 'locale' | 'iso' | 'us' | 'eu' })}
          options={[
            { value: 'locale', label: 'Locale default' },
            { value: 'iso', label: 'ISO 8601 (2026-06-14 15:42)' },
            { value: 'us', label: 'US (Jun 14, 2026, 3:42 PM)' },
            { value: 'eu', label: 'European (14 Jun 2026, 15:42)' }
          ]}
        />
      </SettingsGroup>
    </div>
  )
}
