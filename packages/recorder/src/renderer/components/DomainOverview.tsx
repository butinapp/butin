import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ServiceIcon,
  Skeleton
} from '@butinapp/ui/primitives'
import { useEffect, useState } from 'react'

import type { DomainProfile } from '../../detect/types.js'

import { ConfirmDialog } from './ConfirmDialog.js'
import { CreatePluginDialog } from './CreatePluginDialog.js'
import { MergeDialog } from './MergeDialog.js'
import { ProfileCard } from './ProfileCard.js'
import { RecordingRow } from './RecordingRow.js'

type Run = {
  runId: string
  label: string
  startUrl: string
  startedAt: string
  requestCount: number
}

type Props = {
  surface: string
  partition: string
  /** The Butin app holds this profile open, so recording it is blocked. */
  blocked: boolean
  /** Called after a new recording is started here, so the shell refreshes + rechecks the lock. */
  onNewRun: () => void
  /** Called after every run under this surface is deleted, so the shell can drop the now-empty selection. */
  onDomainDeleted: () => void
  /** Called after a single recording is deleted, so the shell can refresh the domain list's run counts. */
  onRecordingChanged: () => void
}

// A split button: the primary click records again (capturing immediately), and the caret opens a menu whose
// paused option opens the window without auto-capture — so a browser-verification challenge can be cleared before
// the CDP debugger attaches. Both reuse a previous run's start URL — the one-click "do that again" for a domain.
const RecordAgainButton = ({
  startUrl,
  partition,
  blocked,
  onStarted
}: {
  startUrl: string
  partition: string
  blocked: boolean
  onStarted: () => void
}) => {
  const [busy, setBusy] = useState(false)

  const run = async (autoRecord: boolean) => {
    setBusy(true)

    try {
      await window.recorder.startRecording({ startUrl, partition, autoRecord })
      onStarted()
    } finally {
      setBusy(false)
    }
  }

  const title = blocked ? 'Quit Butin to record this profile' : `Record again from ${startUrl}`

  return (
    <div className="flex">
      <Button
        size="sm"
        variant="default"
        disabled={blocked || busy}
        title={title}
        onClick={() => void run(true)}
        className="rounded-r-none"
      >
        {busy ? 'Starting…' : 'Record again'}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="default"
            disabled={blocked || busy}
            aria-label="Record-again options"
            className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
          >
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
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => void run(true)}>Record again (start now)</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run(false)}>Record again (start paused)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// The detail header: a monogram + the surface (an identifier, so it's set in mono) + merge/delete actions.
const Header = ({
  surface,
  partition,
  runCount,
  lastStartUrl,
  blocked,
  onNewRun,
  onMerged,
  onDomainDeleted
}: {
  surface: string
  partition: string
  runCount: number
  lastStartUrl?: string
  blocked: boolean
  onNewRun: () => void
  onMerged: () => void
  onDomainDeleted: () => void
}) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex min-w-0 items-center gap-2.5">
      <ServiceIcon name={surface} size={28} className="shrink-0 border border-border" />
      <h1 className="truncate font-mono text-lg font-semibold" title={surface}>
        {surface}
      </h1>
    </div>
    <div className="flex shrink-0 items-center gap-2">
      {runCount > 0 && <CreatePluginDialog surface={surface} partition={partition} />}
      {lastStartUrl && (
        <RecordAgainButton startUrl={lastStartUrl} partition={partition} blocked={blocked} onStarted={onNewRun} />
      )}
      <MergeDialog surface={surface} onMerged={onMerged} />
      {runCount > 0 && (
        <ConfirmDialog
          title="Delete domain"
          description={
            <>
              Permanently delete all {runCount} recording{runCount === 1 ? '' : 's'} under{' '}
              <span className="font-mono">{surface}</span> for this profile? This removes the captured data from disk
              and cannot be undone.
            </>
          }
          confirmLabel="Delete domain"
          onConfirm={async () => {
            await window.recorder.deleteDomain({ surface, partition })
            onDomainDeleted()
          }}
          trigger={
            <Button size="sm" variant="outline">
              Delete…
            </Button>
          }
        />
      )}
    </div>
  </div>
)

// Loading placeholder mirroring the populated layout, so content doesn't jump in when it arrives.
const OverviewSkeleton = () => (
  <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6" aria-hidden="true">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-6 w-48" />
      </div>
      <Skeleton className="h-8 w-20" />
    </div>
    <Skeleton className="h-40 w-full rounded-xl" />
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-12 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
    </div>
  </div>
)

export const DomainOverview = ({
  surface,
  partition,
  blocked,
  onNewRun,
  onDomainDeleted,
  onRecordingChanged
}: Props) => {
  const [profile, setProfile] = useState<DomainProfile | undefined>(undefined)
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  const load = () => {
    setLoading(true)
    setError(undefined)
    void window.recorder
      .getDomain(surface, partition)
      .then((result) => {
        setProfile(result.profile)
        setRuns(result.runs)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load domain')
        setLoading(false)
      })
  }

  useEffect(() => {
    load()
  }, [surface, partition])

  // Reload after a single recording is deleted, and tell the shell so the list's run count updates.
  const handleRecordingDeleted = () => {
    onRecordingChanged()
    load()
  }

  if (loading) {
    return <OverviewSkeleton />
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    )
  }

  // Guard: profile is absent or has zero runs — surface exists in the list but no loaded run data.
  if (!profile || profile.runCount === 0) {
    return (
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        <Header
          surface={surface}
          partition={partition}
          runCount={0}
          blocked={blocked}
          onNewRun={onNewRun}
          onMerged={load}
          onDomainDeleted={onDomainDeleted}
        />
        <p className="text-sm text-muted-foreground">No runs yet for this surface.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <Header
        surface={surface}
        partition={partition}
        runCount={runs.length}
        lastStartUrl={runs[0]?.startUrl}
        blocked={blocked}
        onNewRun={onNewRun}
        onMerged={load}
        onDomainDeleted={onDomainDeleted}
      />

      {/* Conflicts banner — shown when classifiers disagree across runs. Paired with an icon so the
          warning state isn't carried by color alone. */}
      {profile.conflicts.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-destructive">
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
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            Classifier conflicts
          </p>
          <ul className="ml-[1.375rem] flex list-disc flex-col gap-0.5 pl-1">
            {profile.conflicts.map((c, i) => (
              <li key={i} className="text-xs text-destructive/90">
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ProfileCard profile={profile} />

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="font-display text-sm font-semibold">Recordings</h2>
          <Badge variant="secondary" className="font-mono">
            {runs.length}
          </Badge>
        </div>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No completed runs.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((r) => (
              <RecordingRow
                key={r.runId}
                runId={r.runId}
                label={r.label}
                startedAt={r.startedAt}
                requestCount={r.requestCount}
                onDeleted={handleRecordingDeleted}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
