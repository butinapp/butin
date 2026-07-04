import type { ButinPlugin } from '@butinapp/sdk'

// Runtime shape-guard: is this unknown module export a ButinPlugin descriptor? Finds the descriptor among a
// module's exports by shape (the auto-discovered registry, the demo seed), so no export-naming convention is
// imposed. Lives in its own module — free of the bundler-only `import.meta.glob` in plugins.ts — so the tsx
// seed script can import it without tripping over a Vite macro.
export const isButinPlugin = (v: unknown): v is ButinPlugin =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ButinPlugin).meta?.id === 'string' &&
  typeof (v as ButinPlugin).auth?.kind === 'string' &&
  Array.isArray((v as ButinPlugin).capabilities)
