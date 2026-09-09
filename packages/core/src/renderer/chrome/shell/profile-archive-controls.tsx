import { formatBytes, useLabels } from '@butinapp/ui/i18n'
import { Button, Input, Label } from '@butinapp/ui/primitives'
import { Download, Upload } from 'lucide-react'
import { useId, useState } from 'react'

import { RecoveryCodeReveal } from './recovery-code-reveal.js'

// Moving a profile between computers: the export half lives in a profile's card, the import half in the
// dialog footer (it belongs to no existing profile). Both are prop-driven — the host performs the IPC and
// feeds results back — so the panels stay testable without a main process.

export type ArchiveExportRow = {
  canceled?: boolean
  recoveryCode?: string
  fileCount?: number
  totalBytes?: number
  services?: string[]
  reHomed?: string[]
  unreadableSecrets?: string[]
  sourceEncrypted?: boolean
}

export type ArchivePreviewRow = {
  profileName: string
  appVersion: string
  packedAt: string
  fileCount: number
  totalBytes: number
  services: string[]
  reHomed: string[]
  unreadableSecrets: string[]
  sourceEncrypted: boolean
}

// Each fallible action resolves to null when it failed (the host surfaces the reason); the panel turns that
// into the inline "that passphrase doesn't open this archive" rather than a toast that outlives the dialog.
export type ProfileArchiveActions = {
  onExport: (id: string, secret: string) => Promise<ArchiveExportRow | null>
  onPickArchive: () => Promise<string | null>
  onInspect: (path: string, secret: string) => Promise<ArchivePreviewRow | null>
  onImport: (path: string, secret: string, name: string) => Promise<ArchivePreviewRow | null>
}

export type ArchiveProgressRow = { message?: string; completed: number; total: number }

const Progress = ({ progress }: { progress: ArchiveProgressRow }) => (
  <div className="flex flex-col gap-1">
    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
      <div
        className="bg-primary h-full transition-[width]"
        style={{ width: `${progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : 0}%` }}
      />
    </div>
    <p className="text-muted-foreground truncate text-xs">{progress.message}</p>
  </div>
)

// The notes an archive carries about itself: files brought back in from outside the profile, secrets the source
// machine could not read, and a source that was encrypted where the copy is not. Shown on both sides of the
// trip, because each is something the user has to act on rather than a detail to bury.
const ArchiveNotes = ({
  row
}: {
  row: Pick<ArchivePreviewRow, 'reHomed' | 'unreadableSecrets' | 'sourceEncrypted'>
}) => {
  const t = useLabels()

  return (
    <>
      {row.reHomed.length > 0 && (
        <p className="text-muted-foreground text-xs">{t.archiveReHomedNote(row.reHomed.join(', '))}</p>
      )}
      {row.unreadableSecrets.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t.archiveUnreadableNote(row.unreadableSecrets.length)}
        </p>
      )}
      {row.sourceEncrypted && <p className="text-muted-foreground text-xs">{t.archiveSourceEncryptedNote}</p>}
    </>
  )
}

// The export panel, rendered inside a profile's card. A passphrase (typed twice — there is no second chance to
// get it right, the archive is the only copy) then the recovery reveal.
export const ProfileExportPanel = ({
  profileId,
  onExport,
  progress,
  onClose
}: {
  profileId: string
  onExport: ProfileArchiveActions['onExport']
  progress?: ArchiveProgressRow
  onClose: () => void
}) => {
  const t = useLabels()
  const id = useId()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<ArchiveExportRow | null>(null)

  const run = async (): Promise<void> => {
    if (pw !== pw2) {
      setError(t.archivePassphraseMismatch)

      return
    }

    setBusy(true)
    setError(null)

    const res = await onExport(profileId, pw)

    setBusy(false)

    if (!res) {
      setError(t.fetchFailed)

      return
    }

    // A dismissed save dialog wrote nothing — close rather than reporting a success that didn't happen.
    if (res.canceled) {
      onClose()

      return
    }

    setDone(res)
  }

  if (done?.recoveryCode) {
    return (
      <RecoveryCodeReveal
        code={done.recoveryCode}
        title={t.archiveRecoveryTitle}
        blurb={t.archiveRecoveryBlurb}
        notes={
          <>
            <p className="text-muted-foreground text-xs">
              {t.archiveContents(done.services?.length ?? 0, done.fileCount ?? 0, formatBytes(done.totalBytes ?? 0))}
            </p>
            <ArchiveNotes
              row={{
                reHomed: done.reHomed ?? [],
                unreadableSecrets: done.unreadableSecrets ?? [],
                sourceEncrypted: done.sourceEncrypted ?? false
              }}
            />
          </>
        }
        onConfirm={onClose}
      />
    )
  }

  return (
    <div className="bg-card mt-1 flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">{t.archiveExportTitle}</p>
      <p className="text-muted-foreground text-xs">{t.archiveExportBlurb}</p>
      <Label htmlFor={`${id}-pw`} className="text-xs">
        {t.archivePassphrase}
      </Label>
      <Input id={`${id}-pw`} type="password" className="h-8" value={pw} onChange={(e) => setPw(e.target.value)} />
      <Label htmlFor={`${id}-pw2`} className="text-xs">
        {t.archivePassphraseConfirm}
      </Label>
      <Input id={`${id}-pw2`} type="password" className="h-8" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {error && <p className="text-destructive text-xs">{error}</p>}
      {busy && progress && <Progress progress={progress} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t.cancel}
        </Button>
        <Button size="sm" disabled={busy || pw === ''} onClick={() => void run()}>
          <Download className="size-3.5" />
          {busy ? t.archiveExporting : t.archiveExportSubmit}
        </Button>
      </div>
    </div>
  )
}

// The import panel, rendered under the profile list. Pick a file, prove the passphrase to see what it holds,
// then confirm — nothing is written until the confirm.
export const ProfileImportPanel = ({
  actions,
  progress,
  onClose,
  onImported
}: {
  actions: Pick<ProfileArchiveActions, 'onPickArchive' | 'onInspect' | 'onImport'>
  progress?: ArchiveProgressRow
  onClose: () => void
  onImported: (row: ArchivePreviewRow) => void
}) => {
  const t = useLabels()
  const id = useId()
  const [path, setPath] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ArchivePreviewRow | null>(null)
  const [name, setName] = useState('')

  const pick = async (): Promise<void> => {
    const chosen = await actions.onPickArchive()

    if (chosen) {
      setPath(chosen)
      setPreview(null)
      setError(null)
    }
  }

  const inspect = async (): Promise<void> => {
    if (!path) {
      return
    }

    setBusy(true)
    setError(null)

    const res = await actions.onInspect(path, pw)

    setBusy(false)

    if (res) {
      setPreview(res)
      // Seeded from the archive, then the user's to change — two profiles showing the same name are two the
      // user cannot tell apart afterwards.
      setName(res.profileName)
    } else {
      setError(t.archiveWrongPassphrase)
    }
  }

  const confirm = async (): Promise<void> => {
    if (!path) {
      return
    }

    setBusy(true)
    setError(null)

    const res = await actions.onImport(path, pw, name)

    setBusy(false)

    if (res) {
      onImported(res)
      onClose()
    } else {
      setError(t.fetchFailed)
    }
  }

  return (
    <div className="bg-card mt-2 flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">{t.archiveImportTitle}</p>
      <p className="text-muted-foreground text-xs">{t.archiveImportBlurb}</p>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void pick()} disabled={busy}>
          <Upload className="size-3.5" />
          {t.archiveChooseFile}
        </Button>
        {path && <span className="text-muted-foreground truncate text-xs">{path}</span>}
      </div>

      {path && !preview && (
        <>
          <Label htmlFor={`${id}-pw`} className="text-xs">
            {t.archivePassphrase}
          </Label>
          <Input
            id={`${id}-pw`}
            type="password"
            className="h-8"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void inspect()
              }
            }}
          />
        </>
      )}

      {preview && (
        <div className="flex flex-col gap-1 rounded-md border p-2">
          <Label htmlFor={`${id}-name`} className="text-xs">
            {t.archiveImportAs}
          </Label>
          <Input
            id={`${id}-name`}
            className="h-8"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void confirm()
              }
            }}
          />
          <p className="text-muted-foreground text-xs">
            {t.archiveContents(preview.services.length, preview.fileCount, formatBytes(preview.totalBytes))}
          </p>
          <p className="text-muted-foreground text-xs">
            {t.archivePackedAt(preview.appVersion, new Date(preview.packedAt).toLocaleDateString(t.intlLocale))}
          </p>
          <ArchiveNotes row={preview} />
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
      {busy && progress && <Progress progress={progress} />}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t.cancel}
        </Button>
        {preview ? (
          <Button size="sm" disabled={busy || name.trim() === ''} onClick={() => void confirm()}>
            {busy ? t.archiveImporting : t.archiveImportSubmit}
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !path || pw === ''} onClick={() => void inspect()}>
            {t.archiveImportSubmit}
          </Button>
        )}
      </div>
    </div>
  )
}
