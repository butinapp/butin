import { createFromSource } from 'fumadocs-core/search/server'

import { source } from '@/lib/source'

// Server-route search over the docs source.
export const { GET } = createFromSource(source, { language: 'english' })
