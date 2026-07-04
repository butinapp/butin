import type { Metadata } from 'next'
import Link from 'next/link'

import { ServiceIcon } from '@/components/service-icon'
import { type Service, visibleServices } from '@/lib/services'

export const metadata: Metadata = {
  title: 'Services',
  description:
    'The services Butin can read — a growing catalog of plugins across AI, cloud, developer tools, and beyond. Each fetches your own data with your own login.'
}

const groups: { id: Service['group']; title: string; blurb: string }[] = [
  {
    id: 'dev',
    title: 'Developer & cloud tools',
    blurb: 'The stack an indie dev actually pays for — AI, cloud, monitoring, infra.'
  },
  {
    id: 'beyond',
    title: 'Beyond dev tools',
    blurb: 'No API? No export? No problem. The long tail Butin reaches that finance tools never could.'
  }
]

const ServiceCard = ({ service }: { service: Service }) => (
  <a
    href={service.homepage}
    target="_blank"
    rel="noreferrer"
    className="group flex flex-col rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-line-strong"
  >
    <div className="flex items-center gap-3">
      <ServiceIcon service={service} />
      <div className="min-w-0">
        <div className="truncate font-semibold tracking-tight">{service.name}</div>
        <div className="truncate font-mono text-xs text-muted">{service.vendor}</div>
      </div>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted/70">{service.category}</span>
    </div>

    <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{service.blurb}</p>

    <div className="mt-4 flex flex-wrap gap-1.5">
      {service.caps.map((c) => (
        <span key={c} className="rounded-md border border-line bg-bg/60 px-2 py-0.5 font-mono text-[11px] text-ink/70">
          {c}
        </span>
      ))}
    </div>

    <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
        <span
          className={`size-1.5 rounded-full ${service.connect === 'API key' ? 'bg-amber' : 'bg-teal'}`}
          style={{ boxShadow: `0 0 7px ${service.connect === 'API key' ? 'var(--color-amber)' : 'var(--color-teal)'}` }}
        />
        {service.connect === 'API key' ? 'Connect with a key' : 'Connect with your login'}
      </span>
      <span className="font-mono text-[11px] text-muted/60 transition-colors group-hover:text-teal-soft">↗</span>
    </div>
  </a>
)

export default function ServicesPage() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-28">
      <p className="inline-flex items-center gap-3 font-mono text-xs uppercase tracking-[0.28em] text-teal">
        <span className="h-px w-7 bg-gradient-to-r from-teal to-transparent" />
        The catalog
      </p>
      <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-6xl" style={{ fontFamily: 'var(--font-display)' }}>
        A plugin for every <span className="text-teal-soft">service.</span>
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">
        Each plugin teaches Butin to fetch one service with your own login — no API required. The list grows with every
        contribution, and you can{' '}
        <Link href="/docs/contributing" className="text-teal-soft underline-offset-4 hover:underline">
          write your own
        </Link>
        .
      </p>
      <p className="mt-3 font-mono text-xs text-muted">{visibleServices.length} services and counting</p>

      {groups.map((group) => {
        const items = visibleServices.filter((s) => s.group === group.id)

        if (items.length === 0) {
          return null
        }

        return (
          <div key={group.id} className="mt-16">
            <h2 className="text-2xl font-semibold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              {group.title}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted">{group.blurb}</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((s) => (
                <ServiceCard key={s.id} service={s} />
              ))}
            </div>
          </div>
        )
      })}

      <div className="mt-20 flex flex-col items-start gap-4 rounded-2xl border border-teal/20 bg-teal/[0.04] p-8 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Missing a service?</h2>
          <p className="mt-1.5 text-sm text-muted">
            A plugin is small and mostly declarative. If a browser can see it, you can fetch it.
          </p>
        </div>
        <Link
          href="/docs/contributing"
          className="rounded-full border border-teal/40 bg-teal/10 px-5 py-2.5 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15 sm:ml-auto"
        >
          Write a plugin →
        </Link>
      </div>
    </section>
  )
}
