// Pure download planning — no fs, no Electron. Resolves each file entry to an on-disk relative path
// (<category>/<filename>), de-dupes collisions within the batch, and flags entries already on disk for
// skipping. Kept pure so it's fully node-testable; the orchestrator supplies `exists`.

// Metadata subset of a downloadable file entry needed for planning (no fetch thunk).
export type PlanEntry = { id: string; title: string; category?: string; ext?: string }

export type Planned = { docId: string; relPath: string; skip: boolean }

// Replace path separators + Windows/Unix illegal characters with '-', collapse consecutive hyphens,
// collapse whitespace runs, cap length, and never return empty.
export const sanitizeFilename = (name: string): string => {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  return cleaned === '' ? 'document' : cleaned
}

export const deriveFilename = (entry: PlanEntry): string => sanitizeFilename(`${entry.title}.${entry.ext ?? 'bin'}`)

// Insert ' (n)' before the extension: 'dup.pdf' → 'dup (2).pdf'.
const withSuffix = (filename: string, n: number): string => {
  const dot = filename.lastIndexOf('.')

  return dot <= 0 ? `${filename} (${n})` : `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`
}

export const planDownloads = (entries: PlanEntry[], exists: (relPath: string) => boolean): Planned[] => {
  const used = new Set<string>()

  return entries.map((entry) => {
    const dir = entry.category ? `${sanitizeFilename(entry.category)}/` : ''
    const base = deriveFilename(entry)
    let filename = base
    let n = 2

    while (used.has(`${dir}${filename}`)) {
      filename = withSuffix(base, n++)
    }

    const relPath = `${dir}${filename}`

    used.add(relPath)

    return { docId: entry.id, relPath, skip: exists(relPath) }
  })
}
