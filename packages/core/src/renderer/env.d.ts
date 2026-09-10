/// <reference types="vite/client" />
import type { ButinApi } from '../shared/ipc.js'

declare global {
  // Global augmentation: the preload bridge is added to the ambient `Window`, which only interface merging
  // can extend — a type alias here collides with the DOM declaration instead of adding to it.
  interface Window {
    butin: ButinApi
  }
}

export {}
