'use client'

import { useDocsSearch } from 'fumadocs-core/search/client'
import { oramaStaticClient } from 'fumadocs-core/search/client/orama-static'
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps
} from 'fumadocs-ui/components/dialog/search'

// Fumadocs' own DefaultSearchDialog, with one import changed: `fetchClient` (which asks a search route about each
// keystroke) becomes `oramaStaticClient` (which downloads the whole index once and queries it in the browser). There
// is no `type: 'static'` switch on RootProvider in 16.10.2 — replacing the dialog is the supported extension point,
// so this file exists to change a single line and must be re-diffed against the shipped component on a fumadocs bump.
//
// `from` must match the route path in app/static.json/route.ts.
const client = oramaStaticClient({ from: '/static.json' })

export default function StaticSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({ client })

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  )
}
