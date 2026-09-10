import { Input, Label, Switch } from '@butinapp/ui/primitives'
import type { ReactNode } from 'react'

import type { AlertConfigView, AlertFacet, AlertWindow } from './types.js'

export type AlertsPaneLabels = {
  changeTitle: string
  healthTitle: string
  fxMissing: string
  hint: string
  windows: Record<AlertWindow, string>
  facets: Record<AlertFacet, string>
}

const WINDOWS: AlertWindow[] = ['dod', 'wow', 'mom']
const FACETS: AlertFacet[] = ['spend', 'usage']

// A percent-change alert threshold. Below 1 is "off" (the field clears); above 1000% (an 11× jump) is past any
// useful alert and almost always a fat-finger, so it clamps rather than storing nonsense like 23234%.
const MAX_THRESHOLD = 1000

export const AlertsPane = ({
  config,
  onChange,
  labels
}: {
  config: AlertConfigView
  onChange: (next: AlertConfigView) => void
  labels: AlertsPaneLabels
}) => {
  const setThreshold = (window: AlertWindow, facet: AlertFacet, raw: string): void => {
    const next: AlertConfigView = { ...config, change: { ...config.change, [window]: { ...config.change[window] } } }
    const value = Number(raw)

    if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
      delete next.change[window][facet]
    } else {
      next.change[window][facet] = Math.min(value, MAX_THRESHOLD)
    }

    onChange(next)
  }

  return (
    <div className="space-y-5">
      <Group title={labels.changeTitle}>
        <div className="space-y-2 px-3.5 py-3">
          <p className="text-muted-foreground text-xs">{labels.hint}</p>
          <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-4 gap-y-2 pt-1">
            <span />
            {FACETS.map((f) => (
              <span key={f} className="text-muted-foreground text-xs">
                {labels.facets[f]}
              </span>
            ))}
            {WINDOWS.map((w) => (
              <GridRow key={w} label={labels.windows[w]}>
                {FACETS.map((f) => (
                  <div key={f} className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      max={MAX_THRESHOLD}
                      inputMode="numeric"
                      aria-label={`${labels.windows[w]} ${labels.facets[f]}`}
                      value={config.change[w][f] ?? ''}
                      onChange={(e) => setThreshold(w, f, e.target.value)}
                      className="w-20"
                    />
                    <span className="text-muted-foreground text-xs">%</span>
                  </div>
                ))}
              </GridRow>
            ))}
          </div>
        </div>
      </Group>

      <Group title={labels.healthTitle}>
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <Label htmlFor="fx-missing" className="text-sm font-medium">
            {labels.fxMissing}
          </Label>
          <Switch
            id="fx-missing"
            checked={config.health.fxMissing}
            onCheckedChange={(checked) => onChange({ ...config, health: { ...config.health, fxMissing: checked } })}
          />
        </div>
      </Group>
    </div>
  )
}

// A bordered, divided settings group — an uppercase heading over a card — matching the app's settings panes.
const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="space-y-1.5">
    <h3 className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">{title}</h3>
    <div className="divide-border/60 bg-card divide-y overflow-hidden rounded-lg border">{children}</div>
  </div>
)

const GridRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <span className="text-sm">{label}</span>
    {children}
  </>
)
