import { Button } from '@butinapp/ui/primitives'
import { useCallback, useEffect, useState } from 'react'

import type { AppLockStatus } from '../main/app-lock.js'
import type { ProfileOption } from '../main/ipc.js'

import { DomainList } from './components/DomainList.js'
import { DomainOverview } from './components/DomainOverview.js'
import { ProfileSwitcher } from './components/ProfileSwitcher.js'

// The shell: a top-of-sidebar profile switcher scopes everything below it. Domains, recordings, and new
// recordings all belong to the selected profile's browser partition, so profiles stay truly separate. When the
// Butin app holds the selected profile open, recording it is blocked (its cookie store can't be opened twice).
export const App = () => {
  const [profiles, setProfiles] = useState<ProfileOption[]>([])
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [appLock, setAppLock] = useState<AppLockStatus>({ running: false })
  const [lockChecking, setLockChecking] = useState(false)
  const [selectedSurface, setSelectedSurface] = useState<string | undefined>(undefined)
  // Bumping this remounts the domain list + overview so they re-fetch after a recording or a delete.
  const [nonce, setNonce] = useState(0)

  const recheckLock = useCallback(() => {
    setLockChecking(true)

    return window.recorder
      .appLockStatus()
      .then(setAppLock)
      .finally(() => setLockChecking(false))
  }, [])

  useEffect(() => {
    void Promise.all([window.recorder.listProfiles(), window.recorder.getLastProfile()]).then(([list, lastId]) => {
      setProfiles(list)
      // Reopen the profile the recorder last had selected; fall back to the app's active profile, then the first.
      const remembered = list.find((p) => p.id === lastId)?.id

      setSelectedProfileId(remembered ?? list.find((p) => p.active)?.id ?? list[0]?.id ?? '')
      setProfilesLoaded(true)
    })
    void recheckLock()
  }, [recheckLock])

  // A capture window just closed and saved its run — refresh the list/overview (the new domain only lands on
  // disk now) and recheck the lock (the recorded profile's partition is free again).
  useEffect(() => {
    const off = window.recorder.onRecordingSaved(() => {
      setNonce((n) => n + 1)
      void recheckLock()
    })

    return off
  }, [recheckLock])

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId)
  const partition = selectedProfile?.partition
  // The app holds exactly its active profile's partition open — recording THAT profile would capture an empty,
  // locked session, so block it. Other profiles' sessions are free while the app runs.
  const blocked = appLock.running && appLock.activeProfileId === selectedProfileId

  const handleProfileChange = (id: string) => {
    setSelectedProfileId(id)
    setSelectedSurface(undefined)
    void window.recorder.setLastProfile(id)
    void recheckLock()
  }

  const handleNewRun = () => {
    setNonce((n) => n + 1)
    void recheckLock()
  }

  const handleDomainDeleted = () => {
    setSelectedSurface(undefined)
    setNonce((n) => n + 1)
  }

  const handleRecordingChanged = () => setNonce((n) => n + 1)

  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      <div className="flex h-full w-80 shrink-0 flex-col border-r border-border bg-sidebar">
        {profiles.length > 0 && (
          <ProfileSwitcher profiles={profiles} selectedId={selectedProfileId} onChange={handleProfileChange} />
        )}

        {blocked && selectedProfile && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-3">
            <p className="flex items-start gap-1.5 text-xs font-medium text-destructive">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="mt-px shrink-0"
              >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <span>Butin has this profile open — recording is locked.</span>
            </p>
            <p className="mt-1 pl-[1.375rem] text-xs text-destructive/90">
              Quit Butin (or switch it to another profile), then recheck.
            </p>
            <div className="mt-2 pl-[1.375rem]">
              <Button size="xs" variant="outline" onClick={() => void recheckLock()} disabled={lockChecking}>
                {lockChecking ? 'Checking…' : 'Recheck'}
              </Button>
            </div>
          </div>
        )}

        {profilesLoaded && profiles.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No Butin profiles found. Launch the Butin app once to create one.
          </p>
        ) : (
          partition != null && (
            <DomainList
              key={`${partition}-${nonce}`}
              partition={partition}
              selected={selectedSurface}
              onSelect={setSelectedSurface}
              onNewRun={handleNewRun}
              blocked={blocked}
            />
          )
        )}
      </div>

      <main className="flex flex-1 overflow-hidden">
        {selectedSurface == null || partition == null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <div className="flex max-w-xs flex-col gap-1">
              <h2 className="font-display text-base font-semibold text-foreground">No domain selected</h2>
              <p className="text-sm text-muted-foreground">
                Pick a domain on the left to inspect its detected profile, or start a new recording to capture one.
              </p>
            </div>
          </div>
        ) : (
          <DomainOverview
            key={`${selectedSurface}-${partition}-${nonce}`}
            surface={selectedSurface}
            partition={partition}
            blocked={blocked}
            onNewRun={handleNewRun}
            onDomainDeleted={handleDomainDeleted}
            onRecordingChanged={handleRecordingChanged}
          />
        )}
      </main>
    </div>
  )
}
