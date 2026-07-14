import tailwind from '@tailwindcss/postcss'
// Compile the self-contained embed stylesheet: run Tailwind over src/build.css (component source + brand
// tokens), then scope every rule under `.butin`. `buildButinCss()` returns the scoped CSS; run as a script it
// writes dist/butin.css — the drop-in an external host imports.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

import { scopeCss } from './scope-css.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const input = resolve(root, 'src/build.css')

export const buildButinCss = async () => {
  const compiled = await postcss([tailwind()]).process(readFileSync(input, 'utf8'), { from: input })

  return scopeCss(compiled.css)
}

// Written only when invoked directly (the build step), not when imported by the test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(resolve(root, 'dist/butin.css'), await buildButinCss())
}
