import { DashboardRenderer } from '@butinapp/ui/dashboard'
import { useLabels } from '@butinapp/ui/i18n'
import { Skeleton } from '@butinapp/ui/primitives'
import { useQuery } from '@tanstack/react-query'
import { createLazyRoute } from '@tanstack/react-router'

import { useTablePrefs } from '../use-table-prefs.js'

// The People page: every cached members roster merged into one access-audit table (a person's row expands
// into their per-service access). A pure cache view — refreshing happens on service pages / Management.
const PeopleView = () => {
  const t = useLabels()
  const peopleQ = useQuery({ queryKey: ['people'], queryFn: () => window.butin.reports.people() })
  const prefs = useTablePrefs('people')

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{t.navPeople}</h1>
        {peopleQ.data ? (
          <p className="text-muted-foreground text-sm">{t.peopleSummary(peopleQ.data.people, peopleQ.data.services)}</p>
        ) : null}
      </div>

      {peopleQ.isLoading ? (
        <Skeleton className="h-40" />
      ) : peopleQ.data ? (
        <DashboardRenderer
          result={peopleQ.data.result as never}
          tableState={prefs.initialState as never}
          onTableStateChange={prefs.onStateChange}
          width="full"
          search="always"
        />
      ) : (
        <p className="text-muted-foreground text-sm">{t.peopleEmpty}</p>
      )}
    </div>
  )
}

export const Route = createLazyRoute('/people')({ component: PeopleView })
