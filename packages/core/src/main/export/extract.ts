import { join } from 'node:path'

import { buildContext, requirePlugin } from '../plugin/plugin-context.js'
import { writeBytes } from '../store/secure-fs.js'
import { dataRootDir, resolveExtractsDir } from '../store/store.js'
import { wrapClearOnAuthError } from '../transport/client.js'

import { downloadResultFilesInto, planResultFiles } from './documents.js'
import {
  buildExportPayload,
  buildIndexDoc,
  buildIndexHtml,
  datasetToCsv,
  type HtmlSection,
  type IndexSection,
  isCapabilityResult,
  resultToHtml,
  resultToMarkdown
} from './extract-serialize.js'

// Per-step progress for an extract run, streamed to the renderer. `phase` is the capability id (or
// 'writing'); inner counts advance during a documents download.
export type ExtractProgress = {
  phase: string
  capabilityId?: string
  message?: string
  completed?: number
  total?: number
}

export type ExtractSummary = {
  outDir: string
  capabilities: { id: string; ok: boolean; note?: string }[]
  tabCount: number // collect capabilities serialized
  fileCount: number // documents downloaded
  warnings: string[]
}

// ISO timestamp made filesystem-safe (':' → '-'), trimmed to the second. Sorts chronologically. Names each
// "Save everything" run folder.
export const runSubdir = (now: Date): string =>
  now
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '')

// Is this error one the plugin treats as a dead session? Keys off `err.status` against clearOnStatuses.
const isAuthError = (err: unknown, clearOn: number[]): boolean => {
  const status = (err as { status?: number }).status

  return Boolean(status && clearOn.includes(status))
}

// "Save everything" for one provider into ~/butin/<plugin>/extracts/<ISO-run>/: each collect → data/*.json
// (a clean, documented export envelope) (+ data/*.csv per table); any `files`-declared table →
// files/<category>/…; a generic index.md (LLM/browse) AND a self-contained, human-browsable index.html (the
// browser entry point). One auth context (spa-bearer mints once, cached). Per-capability errors are tolerated
// so the run always finishes — EXCEPT a dead-session status, which short-circuits and re-prompts login.
export const runExtractAll = async (
  pluginId: string,
  onProgress: (p: ExtractProgress) => void
): Promise<ExtractSummary> => {
  const plugin = requirePlugin(pluginId)
  const startedAt = new Date()
  const outDir = join(resolveExtractsDir(pluginId), runSubdir(startedAt))
  const dataDir = join(outDir, 'data')
  const generatedAt = startedAt.toISOString()

  // Every extract file is written through secure-fs against the profile data root: sealed on an encrypted
  // profile (the run folder lives inside the profile, so a raw plaintext write would leak), plaintext on an
  // OFF one (byte-identical to a direct write). A browsable plaintext extract for an encrypted profile is
  // opened via the app rather than from disk (a documented follow-up); the sealing here is intentional.
  const writeText = (path: string, text: string): Promise<void> =>
    writeBytes(dataRootDir(), path, Buffer.from(text, 'utf8'))

  const ctx = buildContext(plugin, 'extract')
  const clearOn = plugin.auth.clearOnStatuses ?? [401]
  const sections: IndexSection[] = []
  const htmlSections: HtmlSection[] = []
  const capabilities: ExtractSummary['capabilities'] = []
  const warnings: string[] = []
  let tabCount = 0
  let fileCount = 0

  // One wrap so a 401 from a direct collect() clears creds. The documents download arm wraps itself
  // internally; its re-thrown auth error is detected in the per-capability catch.
  const walk = wrapClearOnAuthError(plugin, ctx.creds, async () => {
    for (const cap of plugin.capabilities) {
      onProgress({ phase: cap.id, capabilityId: cap.id })

      try {
        const data = await cap.collect(ctx)
        const payload = buildExportPayload(data, {
          service: plugin.meta.name,
          capability: cap.id,
          label: cap.label,
          generatedAt
        })

        await writeText(join(dataDir, `${cap.id}.json`), JSON.stringify(payload, null, 2))

        if (isCapabilityResult(data)) {
          const tables = data.datasets.filter((d) => d.shape === 'table')

          for (const ds of tables) {
            const name = tables.length > 1 ? `${cap.id}.${ds.id}.csv` : `${cap.id}.csv`

            await writeText(join(dataDir, name), datasetToCsv(ds))
          }

          sections.push({ label: cap.label, markdown: resultToMarkdown(data) || '_(no data)_' })
          // index.html links each downloadable row to the file the download step writes (same plan → same path).
          htmlSections.push({
            label: cap.label,
            html: resultToHtml(data, planResultFiles(cap, data, plugin.transport?.download))
          })

          // If the result's table view declares `files` (invoice/statement PDFs etc.), download them all
          // into files/ alongside the serialized data — one tab can be both data AND its source documents.
          const fileSummary = await downloadResultFilesInto(
            cap,
            data,
            ctx,
            join(outDir, 'files'),
            (p) => onProgress({ phase: cap.id, capabilityId: cap.id, completed: p.completed, total: p.total }),
            plugin.transport?.download
          )

          fileCount += fileSummary.done
          warnings.push(...fileSummary.errors.map((e) => `${cap.id}/${e.docId}: ${e.error}`))
        } else {
          sections.push({ label: cap.label, markdown: `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` })
        }

        tabCount++
        capabilities.push({ id: cap.id, ok: true })
      } catch (err) {
        // A dead session aborts the whole run so the UI can re-prompt Magic Login (rethrow → the wrap
        // clears creds). Any other failure is recorded and the walk continues.
        if (isAuthError(err, clearOn)) {
          throw err
        }

        const note = (err as Error).message

        sections.push({ label: cap.label, markdown: `_extraction failed: ${note}_` })
        capabilities.push({ id: cap.id, ok: false, note })
        warnings.push(`${cap.id}: ${note}`)
      }
    }
  })

  await walk()

  onProgress({ phase: 'writing', message: 'index.md' })
  await writeText(
    join(outDir, 'index.md'),
    buildIndexDoc({ pluginName: plugin.meta.name, runAt: generatedAt, sections, fileCount, exportFolders: [] })
  )

  if (htmlSections.length > 0) {
    await writeText(
      join(outDir, 'index.html'),
      buildIndexHtml({ pluginName: plugin.meta.name, runAt: generatedAt, sections: htmlSections })
    )
  }

  console.log(`[butin:extract] ${pluginId}: ${tabCount} tabs, ${fileCount} files → ${outDir}`)

  return { outDir, capabilities, tabCount, fileCount, warnings }
}
