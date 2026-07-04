import { useLabels } from '@butinapp/ui/i18n'
import { useQuery } from '@tanstack/react-query'

import type { DiagnosticsDto } from '../../../shared/ipc.js'

import { SettingsCell, SettingsGroup } from './parts.js'

import { BrandMark } from '@/components/brand-mark'

// About: app identity + version. Shares the diagnostics snapshot with the System pane (one cached query).
export const AboutPane = () => {
  const t = useLabels()
  const { data } = useQuery<DiagnosticsDto>({
    queryKey: ['diagnostics'],
    queryFn: () => window.butin.app.diagnostics()
  })

  return (
    <SettingsGroup>
      <SettingsCell>
        <div className="flex flex-col items-center gap-3 py-5 text-center">
          {/* The animated hub; a motion-sensitive viewer gets the static mark instead. */}
          <BrandMark animated className="text-foreground size-28 motion-reduce:hidden" />
          <BrandMark className="text-foreground hidden size-28 motion-reduce:block" />
          <div className="space-y-0.5">
            <div className="font-display text-lg font-semibold">Butin{data ? ` ${data.appVersion}` : ''}</div>
            <p className="text-muted-foreground text-xs">{t.tagline}</p>
          </div>
        </div>
      </SettingsCell>
    </SettingsGroup>
  )
}
