import { useLabels } from '@butinapp/ui/i18n'
import { Button, Input, Label, Switch } from '@butinapp/ui/primitives'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import type { FxConfigDto } from '../../../shared/ipc.js'

import { Row, SelectField, SettingsCell, SettingsGroup, useAppSettings } from './parts.js'

// A common base-currency menu; any currency a connected service reports in is added on top so it's always
// selectable even if it's not in this list.
const COMMON_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'CHF', 'AUD', 'JPY']

// Idle-lock options (minutes); 0 = never idle-lock.
const IDLE_LOCK_MINUTES = [5, 15, 30, 60]

// Data & Privacy: the currency rollup + FX rates, the requests the app makes on its own (exchange rates, the
// launch update check), and encrypted-profile auto-lock. The on-disk folders and the data-wipe actions live in
// the Storage pane.
export const DataPrivacyPane = () => {
  const t = useLabels()
  const qc = useQueryClient()
  const { settings, patch } = useAppSettings()

  // Currency settings. The stored config seeds an editable draft; the rate rows are one per foreign currency
  // any connected service reports in (from the overview tiles), so the user only fills rates they actually need.
  const { data: fx } = useQuery({ queryKey: ['fxConfig'], queryFn: () => window.butin.settings.getFx() })
  const { data: tiles = [] } = useQuery({ queryKey: ['overview'], queryFn: () => window.butin.reports.overview() })
  const [fxDraft, setFxDraft] = useState<FxConfigDto | null>(null)
  const fxModel = fxDraft ?? fx ?? { baseCurrency: 'USD', rates: {} }

  const inUseCurrencies = [...new Set(tiles.map((tile) => tile.currency).filter((c): c is string => Boolean(c)))]
  const foreignCurrencies = [...new Set([...inUseCurrencies, ...Object.keys(fxModel.rates)])]
    .filter((c) => c !== fxModel.baseCurrency)
    .sort()
  const baseOptions = [...new Set([...COMMON_CURRENCIES, ...inUseCurrencies, fxModel.baseCurrency])].sort()

  const saveFx = (): void => {
    void window.butin.settings
      .setFx({ baseCurrency: fxModel.baseCurrency, rates: fxModel.rates, source: 'manual' })
      .then(() => {
        setFxDraft(null)
        void qc.invalidateQueries({ queryKey: ['fxConfig'] })
        void qc.invalidateQueries({ queryKey: ['overview'] })
      })
      .catch(() => toast.error(t.settingsSaveFailed))
  }

  return (
    <div className="space-y-5">
      <SettingsGroup title={t.sectionCurrency}>
        <SelectField
          label={t.baseCurrencyLabel}
          hint={t.baseCurrencyHint}
          value={fxModel.baseCurrency}
          onValueChange={(v) => setFxDraft({ ...fxModel, baseCurrency: v })}
          options={baseOptions.map((c) => ({ value: c, label: c }))}
        />

        <Row
          title={t.fetchRatesLabel}
          hint={t.fetchRatesHint}
          control={
            <Switch
              checked={settings?.fetchExchangeRates ?? false}
              onCheckedChange={(v) => patch({ fetchExchangeRates: v })}
              aria-label={t.fetchRatesLabel}
            />
          }
        />

        <SettingsCell>
          <Label>{t.exchangeRatesLabel}</Label>
          <p className="text-muted-foreground text-xs">{t.exchangeRatesHint}</p>
          {foreignCurrencies.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">{t.exchangeRatesEmpty}</p>
          ) : (
            <div className="space-y-2 pt-1">
              {foreignCurrencies.map((c) => (
                <div key={c} className="flex items-center gap-3">
                  <span className="text-muted-foreground w-28 font-mono text-xs">
                    1 {c} = ? {fxModel.baseCurrency}
                  </span>
                  <Input
                    type="number"
                    step="0.0001"
                    min="0"
                    className="max-w-40"
                    aria-label={`${c} to ${fxModel.baseCurrency} rate`}
                    value={fxModel.rates[c] ?? ''}
                    onChange={(e) => {
                      const n = Number.parseFloat(e.target.value)
                      const rates = { ...fxModel.rates }

                      if (Number.isFinite(n) && n > 0) {
                        rates[c] = n
                      } else {
                        delete rates[c]
                      }

                      setFxDraft({ ...fxModel, rates })
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          <Button size="sm" onClick={saveFx} disabled={fxDraft === null}>
            {t.saveRates}
          </Button>
        </SettingsCell>
      </SettingsGroup>

      <SettingsGroup title={t.sectionUpdates}>
        <Row
          title={t.autoUpdateLabel}
          hint={t.autoUpdateHint}
          control={
            <Switch
              checked={settings?.autoUpdate ?? true}
              onCheckedChange={(v) => patch({ autoUpdate: v })}
              aria-label={t.autoUpdateLabel}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t.sectionSecurity}>
        <SelectField
          label={t.idleLockLabel}
          hint={t.idleLockHint}
          value={String(settings?.idleLockMinutes ?? 15)}
          onValueChange={(v) => patch({ idleLockMinutes: Number(v) })}
          options={[
            { value: '0', label: t.idleLockOff },
            ...IDLE_LOCK_MINUTES.map((m) => ({ value: String(m), label: `${m} min` }))
          ]}
        />
        <Row
          title={t.lockOnSleepLabel}
          hint={t.lockOnSleepHint}
          control={
            <Switch
              checked={settings?.lockOnSleep ?? true}
              onCheckedChange={(v) => patch({ lockOnSleep: v })}
              aria-label={t.lockOnSleepLabel}
            />
          }
        />
      </SettingsGroup>
    </div>
  )
}
