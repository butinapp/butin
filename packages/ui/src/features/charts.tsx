import type { ReactNode } from 'react'

import { Card, CardContent } from '../components/card.js'

// Compact label/value stat tile. `value`/`sub` accept rich nodes; money should be a `$` string.
export const StatCard = ({
  label,
  value,
  sub,
  valueClass
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  valueClass?: string
}) => (
  <Card className="h-full gap-0 py-3">
    <CardContent className="px-4">
      <div className="text-muted-foreground truncate text-[11px]">{label}</div>
      <div
        className={`mt-0.5 font-mono text-lg leading-tight font-semibold break-words tabular-nums ${valueClass ?? ''}`}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
      {sub ? <div className="text-muted-foreground mt-0.5 text-[10px]">{sub}</div> : null}
    </CardContent>
  </Card>
)
