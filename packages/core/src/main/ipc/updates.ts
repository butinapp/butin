import { checkForUpdate, installUpdate, updateState } from '../update/updater.js'

import type { IpcHandlers } from './result.js'

export const updateHandlers = {
  state: () => updateState(),

  check: () => {
    checkForUpdate()
  },

  install: () => {
    installUpdate()
  }
} satisfies IpcHandlers['updates']
