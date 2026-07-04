import { defineConfig } from 'vitest/config'

// Config used ONLY for the merged coverage run (`pnpm test:coverage`, which passes `--config` explicitly).
// Day-to-day `pnpm test` stays a per-package turbo run (fast, cached, parallel); this drives every package
// in ONE Vitest process so v8 coverage merges into a single report instead of 45 disconnected ones.
//
// NOT named `vitest.config.ts` on purpose: that name auto-discovers, so a per-package `vitest run` would
// walk up, find this `projects` array, and resolve its paths against the wrong cwd. Keep it config-explicit.
//
// `projects` lists every package that has a test target. ui carries its own vitest.config.ts (jsdom +
// jest-dom setup) and is picked up per project; sdk/core and the plugins use the default node env.
// packages/website has no tests and is left out so the run never bails on an empty project.
export default defineConfig({
  test: {
    // `plugins/*` also globs the shared `plugins/assets.d.ts` ambient decl — negate it so only plugin dirs match.
    projects: ['packages/core', 'packages/sdk', 'packages/shapes', 'packages/ui', 'plugins/*', '!plugins/*.d.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Count every source file, not just the ones a test imports, so untested files surface as real 0% gaps.
      // Restricted to code (ts/tsx) so HTML/CSS/JSON fixtures don't land in the report (or trip the v8 parser).
      all: true,
      include: ['packages/*/src/**/*.{ts,tsx}', 'plugins/*/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/*.d.ts',
        '**/dist/**',
        '**/out/**',
        'packages/website/**',
        'examples/**',
        // --- @butinapp/core Electron boundary ---------------------------------------------------------------
        // These need a live Electron app (BrowserWindow / session / contextBridge / net.request) and are
        // covered by manual smoke + `pnpm drive`, not unit tests. Counting them as 0% would understate the
        // coverage of the logic that IS unit-tested, so they're excluded from the denominator on purpose.
        // Pure helpers that happen to live alongside them (identity, session-cookies, the tested renderer
        // hooks) are NOT excluded — they keep earning their coverage.
        'packages/core/src/main/index.ts',
        'packages/core/src/main/window*.ts',
        'packages/core/src/main/env.ts',
        'packages/core/src/preload/**',
        'packages/core/src/main/browser/browser-session.ts',
        'packages/core/src/main/browser/shared-session.ts',
        'packages/core/src/main/browser/magic-toolbar.ts',
        'packages/core/src/main/session/**',
        'packages/core/src/main/transport/electron-client.ts',
        'packages/core/src/main/export/export-bundle.ts',
        // renderer app shells (window.butin / next-themes / Electron chrome) — typecheck-only by convention.
        // Every route `.tsx` is router boilerplate; the tested `route-helpers.ts` is `.ts`, so it survives.
        'packages/core/src/renderer/main.tsx',
        'packages/core/src/renderer/router.tsx',
        'packages/core/src/renderer/routes/**/*.tsx',
        'packages/core/src/renderer/components/**',
        'packages/core/src/renderer/use-job-progress.ts',
        'packages/core/src/renderer/use-plugin-config-options.ts',
        'packages/core/src/renderer/use-titlebar.ts'
      ]
    }
  }
})
