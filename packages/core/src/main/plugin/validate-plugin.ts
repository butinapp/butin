import type { ButinPlugin } from '@butinapp/sdk'

import type { PluginDiagnosticDto } from '../../shared/ipc.js'

// Structural sanity checks on a loaded descriptor — beyond the shape guard in plugins.ts (which only proves
// it IS a plugin). These are non-fatal: the plugin still loads, but the problems surface on the Diagnostics
// page so a subtle misconfig (two tabs with the same id → React key collision / wrong tab) is visible
// instead of mysterious. Returns one message per problem; [] = clean.
export const validatePlugin = (plugin: ButinPlugin): string[] => {
  const problems: string[] = []

  if (plugin.capabilities.length === 0) {
    problems.push('has no capabilities (nothing to show)')
  }

  const ids = plugin.capabilities.map((c) => c.id)
  const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]

  if (dupIds.length > 0) {
    problems.push(`duplicate capability id(s): ${dupIds.join(', ')}`)
  }

  if (!plugin.meta.name?.trim()) {
    problems.push('missing meta.name')
  }

  if (typeof plugin.probe !== 'function') {
    problems.push('missing a probe (a connection test must be one cheap authed request, not a capability fetch)')
  }

  return problems
}

// The transport the client will actually use: requiresBrowserEngine is the readable alias that forces electron,
// otherwise the declared engine, defaulting to node — so the Diagnostics page shows what really runs.
const resolveEngine = (plugin: ButinPlugin): 'node' | 'electron' =>
  plugin.transport?.requiresBrowserEngine ? 'electron' : (plugin.transport?.engine ?? 'node')

// Build the per-plugin diagnostics rows from the live registry. Cross-plugin duplicate meta.id is detected
// here (pluginById returns the first match, so a dupe silently shadows) and folded into each clashing row's
// warnings. Pure over its input → fixture-tested.
export const buildPluginDiagnostics = (plugins: ButinPlugin[]): PluginDiagnosticDto[] => {
  const idCounts = new Map<string, number>()

  for (const p of plugins) {
    idCounts.set(p.meta.id, (idCounts.get(p.meta.id) ?? 0) + 1)
  }

  return plugins.map((p) => {
    const warnings = validatePlugin(p)

    if ((idCounts.get(p.meta.id) ?? 0) > 1) {
      warnings.push(`duplicate plugin id "${p.meta.id}" — only the first is reachable`)
    }

    return {
      id: p.meta.id,
      name: p.meta.name,
      authKind: p.auth.kind,
      transport: resolveEngine(p),
      sessionless: p.auth.kind === 'external',
      capabilities: p.capabilities.length,
      warnings
    }
  })
}
