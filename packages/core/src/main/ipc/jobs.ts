import type { IpcMainInvokeEvent } from 'electron'

import {
  type ExtractOutcome,
  IPC_EVENT,
  type JobOutcome,
  type JobProgressDto,
  type Result,
  type RunJobOptions
} from '../../shared/ipc.js'
import { downloadReportFiles, locateReportFiles } from '../export/documents.js'
import { runExtractAll } from '../export/extract.js'
import { pluginById } from '../plugin/plugins.js'
import { trackProfileWrite } from '../store/store.js'

import { type IpcHandlers, safeResult } from './result.js'

// Push one progress tick to the webContents that started the job, on the single job:progress channel.
const sendJobProgress = (event: IpcMainInvokeEvent, p: JobProgressDto): void => {
  event.sender.send(IPC_EVENT.jobProgress, p)
}

// Long, artifact-producing runs (a capability's downloadable files, or a whole-plugin extract) plus locating
// the files a run wrote. Each streams ticks on the shared job:progress channel and resolves with a Result.
export const jobHandlers = {
  // id → { path, sizeBytes } for a collect capability's downloadable-table files already on disk.
  locateFiles: (_event, pluginId: string, capabilityId: string) => locateReportFiles(pluginId, capabilityId),

  // Run a collect capability's downloadable-table files through the shared pool. Streams ticks on the shared
  // job:progress channel; resolves with the discriminated outcome. Never rejects across IPC.
  runJob: (event, pluginId: string, capabilityId: string, opts?: RunJobOptions): Promise<Result<JobOutcome>> =>
    safeResult<JobOutcome>(async () => {
      const plugin = pluginById(pluginId)
      const cap = plugin?.capabilities.find((c) => c.id === capabilityId)

      if (!cap) {
        throw new Error(`unknown capability: ${pluginId}/${capabilityId}`)
      }

      // A collect capability whose result has a downloadable table (a `files` view descriptor): download its
      // files through the shared pool, deriving items from the stored report (URL GET or the fetchFile hook).
      const s = await trackProfileWrite(() =>
        downloadReportFiles(pluginId, capabilityId, opts?.selection ?? 'all', { force: opts?.force }, (p) =>
          sendJobProgress(event, {
            pluginId,
            capabilityId,
            docId: p.docId,
            state: p.state,
            path: p.path,
            sizeBytes: p.sizeBytes,
            completed: p.completed,
            total: p.total
          })
        )
      )

      return { kind: 'files', total: s.total, done: s.done, skipped: s.skipped, errors: s.errors }
    }),

  // Extract everything for a plugin into one folder: stream per-capability progress, resolve with the run
  // summary. Never let a run rejection cross IPC unhandled.
  runExtractAll: (event, pluginId: string): Promise<Result<ExtractOutcome>> =>
    safeResult(() =>
      trackProfileWrite(() =>
        runExtractAll(pluginId, (p) =>
          sendJobProgress(event, {
            pluginId,
            capabilityId: p.capabilityId,
            phase: p.phase,
            message: p.message,
            completed: p.completed,
            total: p.total
          })
        )
      )
    )
} satisfies IpcHandlers['jobs']
