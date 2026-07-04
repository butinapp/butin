# Contributing to Butin

Thanks for your interest in Butin. This guide covers how to set up the repo, the quality gate every
change must pass, and how to add a plugin.

## The trust model — read this first

A Butin plugin runs **inside your authenticated session, with your real cookies and tokens**. A
hostile plugin could exfiltrate your Google / bank / vendor sessions. Because of that:

- **First-party plugins live in this repo (`plugins/*`), are bundled into the app, and are reviewed
  by the maintainer.** This is the intended path for new plugins today.
- **Runtime loading of untrusted third-party plugins is deliberately not supported yet.** It needs a
  real trust boundary (signing/review, per-plugin permissions, sandboxing) and stays deferred until
  that exists. Do not wire up loading of unreviewed plugins.

Never commit captured data, live session cookies, or real account identifiers. Fixtures must be
synthetic or redacted.

## Setup

Butin is a pnpm workspace. Node `>=20` (the repo pins `22.15.0` via `.nvmrc`).

```bash
pnpm install        # if Electron won't launch, run `node node_modules/electron/install.js` once
pnpm dev            # run the Electron app (electron-vite, watches main)
pnpm test           # vitest across the workspace
```

## The quality gate

Every PR must pass:

```bash
pnpm check          # oxfmt --check + oxlint + tsc --noEmit across all packages
pnpm test           # all unit tests
```

`pnpm fix` runs the formatter + lint autofix. Run it after any codegen.

CI runs `pnpm check` and `pnpm test` on every push and pull request.

## Conventions

- **TypeScript, ESM.** Relative imports use `.js` specifiers even from `.ts` files
  (`import { x } from './y.js'`).
- **Arrow functions** over `function` declarations. **Named exports only** (no default exports).
- **Formatting (oxfmt):** no semicolons, single quotes, no trailing commas, LF, import-sort. Code and
  comments wrap at 150 columns — do not hard-wrap at 70/80.
- **Comments only when the _why_ is non-obvious.** Don't restate the type, the name, or what the code
  plainly does.
- **strict TS,** `verbatimModuleSyntax` on — use `import type` for type-only imports.
- **Building UI?** Match the visual/UX language in [`DESIGN.md`](DESIGN.md) (color, type, monograms,
  data-density, states); import primitives and `cn` from `@butinapp/ui`, not a local copy.

## Adding a plugin

See [`PLUGINS.md`](PLUGINS.md) for the plugin model and governance, and [`CLAUDE.md`](CLAUDE.md) for
the full architecture (the transport × auth × render taxonomy) and a step-by-step walkthrough. The
short version:

1. Read [`CLAUDE.md`](CLAUDE.md) (the engine taxonomy + the data-view contract) and skim an existing
   plugin with the closest auth/render shape to find the pattern to follow.
2. Scaffold with `pnpm new-plugin <id> [--name "..."] [--vendor "..."]`, which stamps `plugins/<id>/`
   (a minimal valid `main.ts` + `main.test.ts`). Plugins are folders in the single `@butinapp/plugins`
   package — no per-plugin `package.json`/`tsconfig` and no `pnpm install`. Flesh out `main.ts`; keep the
   pure `build*()` transforms exported and fixture-tested — that's where the real coverage lives.
3. **No registration step** — `packages/core/src/main/plugin/plugins.ts` auto-discovers every
   `plugins/*/main.ts` via `import.meta.glob`. There's nothing to add to `plugins.ts`,
   `bundledWorkspace`, or any `package.json`/`tsconfig` (a unique dep goes in `plugins/package.json`).
4. `pnpm install` (once, to register the new workspace member), then `pnpm check` and `pnpm test`.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Make sure `pnpm check` and `pnpm test` are green before opening.
- Describe what changed and why. If it adds or changes a plugin, note which service and which auth
  path it exercises.

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
