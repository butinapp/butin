import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'

import { baseOptionsFr } from '@/lib/layout.shared'
import { sourceFr } from '@/lib/source'

export default function FrenchDocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={sourceFr.getPageTree()} {...baseOptionsFr()}>
      {children}
    </DocsLayout>
  )
}
