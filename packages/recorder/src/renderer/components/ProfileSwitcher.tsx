import { Label, Select, ServiceIcon } from '@butinapp/ui/primitives'

import type { ProfileOption } from '../../main/ipc.js'

interface Props {
  profiles: ProfileOption[]
  /** The recorder's currently selected profile id (independent of which one the app has open). */
  selectedId: string
  onChange: (id: string) => void
}

// The top-of-sidebar profile selector: everything below it (domains, recordings, new recordings) is scoped to
// the chosen profile, so each profile's captures stay separate. A profile the Butin app currently holds open is
// annotated so you know recording it is blocked.
export const ProfileSwitcher = ({ profiles, selectedId, onChange }: Props) => {
  const selected = profiles.find((p) => p.id === selectedId)

  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
      <Label htmlFor="rec-profile-switch" className="text-xs font-medium text-muted-foreground">
        Profile
      </Label>
      <div className="flex items-center gap-2">
        {selected && <ServiceIcon name={selected.name} size={24} className="shrink-0 border border-border" />}
        <div className="min-w-0 flex-1">
          <Select
            id="rec-profile-switch"
            value={selectedId}
            onValueChange={onChange}
            options={profiles.map((p) => ({ value: p.id, label: p.active ? `${p.name} · open in Butin` : p.name }))}
          />
        </div>
      </div>
    </div>
  )
}
