import { readConfig, updatePluginEntry } from '../store/config-file.js'

// The per-plugin documents output-folder override. Stored on the plugin entry as a sibling to
// `config` (a plain path, not a secret, not a schema field). Undefined → core uses the default
// (~/butin/<plugin>/documents/, resolved in store.ts).
export const getDocumentsOutputDir = (pluginId: string): string | undefined => {
  const dir = readConfig().plugins[pluginId]?.documentsOutputDir

  return typeof dir === 'string' && dir !== '' ? dir : undefined
}

export const setDocumentsOutputDir = (pluginId: string, dir: string): void => {
  updatePluginEntry(pluginId, (entry) => {
    entry.documentsOutputDir = dir
  })
}
