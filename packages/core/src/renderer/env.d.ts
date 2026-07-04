/// <reference types="vite/client" />
import type { ButinApi } from '../shared/ipc.js'

declare global {
  interface Window {
    butin: ButinApi
  }
}

export {}
