import { type PluginView } from '@butinapp/ui'
import { useLabels } from '@butinapp/ui/i18n'
import { Button, Input, ServiceIcon } from '@butinapp/ui/primitives'
import { Download, Search } from 'lucide-react'
import { useState } from 'react'

import { groupByCategory } from './group-by-category.js'

// The Available tab: every not-yet-installed plugin as a compact card (monogram · name · one-line
// description · Install) in a responsive grid, grouped by category. Pure + prop-driven — the host owns the install IPC.
export const AvailableCatalog = ({
  plugins,
  onInstall
}: {
  plugins: PluginView[]
  onInstall: (id: string) => void
}) => {
  const t = useLabels()
  const [query, setQuery] = useState('')

  if (plugins.length === 0) {
    return <p className="text-muted-foreground text-sm">{t.allInstalled}</p>
  }

  const q = query.trim().toLowerCase()
  const visible = plugins.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.vendor?.toLowerCase().includes(q) ?? false) ||
      (p.description?.toLowerCase().includes(q) ?? false)
  )

  return (
    <div className="space-y-4">
      <div className="relative min-w-44">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.availableSearchPlaceholder}
          className="h-8 pl-7 text-xs"
        />
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t.noServicesMatch}</p>
      ) : (
        <div className="space-y-5">
          {groupByCategory(visible).map(([cat, rows]) => (
            <section key={cat} className="space-y-2">
              <h2 className="text-muted-foreground px-1 text-[10px] font-medium tracking-wider uppercase">
                {t.category[cat]}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {rows.map((p) => (
                  <div
                    key={p.id}
                    className="hover:border-foreground/20 hover:bg-muted/40 flex flex-col gap-2 rounded-md border p-3 transition-colors"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ServiceIcon id={p.id} icon={p.icon} name={p.name} color={p.color} size={20} />
                      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium">{p.name}</span>
                      </div>
                    </div>
                    {p.description ? (
                      <p className="text-muted-foreground line-clamp-2 text-xs">{p.description}</p>
                    ) : null}
                    <Button size="sm" variant="outline" className="mt-auto w-full" onClick={() => onInstall(p.id)}>
                      <Download /> {t.installAction}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
