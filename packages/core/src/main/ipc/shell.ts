import { shell } from 'electron'

import { isRevealable } from './files.js'
import type { IpcHandlers } from './result.js'

// OS-shell integration on non-file targets: hand the OS a path to highlight or a URL to open. File/folder
// I/O (resolve, save, export, reveal a known service folder) is the files domain; these act on a raw path
// the user picked or a service URL.
export const shellHandlers = {
  // Reveal a written file in the OS file manager, highlighting it (the export "Reveal in folder" action).
  // Only a path this process wrote or owns — the last export, the profile tree, the app's own user data.
  revealPath: (_event, path: string) => {
    if (isRevealable(path)) {
      shell.showItemInFolder(path)
    }
  },

  // Open an external URL (a service's dashboard) in the OS default browser. Only http(s) — never let a
  // renderer-supplied string reach the shell as a file:// or custom-scheme link.
  openExternal: async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
    }
  }
} satisfies IpcHandlers['shell']
