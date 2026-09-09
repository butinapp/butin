import { createFromSource } from 'fumadocs-core/search/server'

import { source } from '@/lib/source'

// The search index, exported at build time instead of served on demand. `staticGET` renders the whole Orama index
// into one response; the client downloads it once and queries it in the browser, which is what makes search work on
// a host that runs no server.
//
// The route is `/static.json` rather than fumadocs' documented `/api/search` on purpose: under `output: 'export'` a
// route emits a file at its own path, and `/api/search` would land as `out/api/search` with no extension for the
// asset server to derive a content-type from. `.json` in the route name is the content-type.
export const revalidate = false
export const { staticGET: GET } = createFromSource(source)
