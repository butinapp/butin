import { BrandMark } from '@/components/brand'
import { Link } from '@/components/site-link'
import { GITHUB } from '@/lib/links'
import { visibleServices } from '@/lib/services'

const SERVICE_COUNT = visibleServices.length

// A cross-domain sample for the hero strip — dev tools next to a phone bill, a water heater, a health portal,
// so "not just dev tools" lands at a glance.
const stripServices = [
  'AWS',
  'Videotron',
  'GitHub',
  'Claude',
  'Vercel',
  'Carnet Santé',
  'Airbnb',
  'Hydro-Solution',
  'ChatGPT'
]

const Kicker = ({ children }: { children: React.ReactNode }) => (
  <p className="inline-flex items-center gap-3 font-mono text-xs uppercase tracking-[0.28em] text-teal">
    <span className="h-px w-7 bg-gradient-to-r from-teal to-transparent" />
    {children}
  </p>
)

// A screenshot of the real app in a window frame — the product shots throughout the page share this chrome.
const AppShot = ({ src, alt, label }: { src: string; alt: string; label: string }) => (
  <figure className="overflow-hidden rounded-xl border border-line-strong bg-[#0c0e13] shadow-2xl">
    <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
      <span className="size-3 rounded-full bg-destructive/70" />
      <span className="size-3 rounded-full bg-amber/70" />
      <span className="size-3 rounded-full bg-success/70" />
      <span className="ml-3 truncate font-mono text-xs text-muted">{label}</span>
    </div>
    <img src={src} alt={alt} width={2160} height={1350} className="w-full" loading="lazy" />
  </figure>
)

// ---------------------------------------------------------------- Hero

const Hero = () => (
  <section className="relative overflow-hidden border-b border-line">
    <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10" />
    <div
      className="pointer-events-none absolute inset-0 -z-10"
      style={{ background: 'radial-gradient(60% 40% at 50% -6%, rgba(98,212,200,0.12), transparent 60%)' }}
    />
    <div className="mx-auto w-full max-w-6xl px-5 pt-24 md:pt-28">
      <div className="mx-auto max-w-3xl text-center">
        <div className="reveal flex justify-center" style={{ animationDelay: '0ms' }}>
          <Kicker>Local-first · Open source · no cloud</Kicker>
        </div>
        <h1
          className="reveal mt-6 text-balance text-5xl font-bold leading-[0.97] tracking-tight md:text-7xl"
          style={{ fontFamily: 'var(--font-display)', animationDelay: '80ms' }}
        >
          All your accounts.
          <br />
          <span className="text-teal-soft">One place.</span>
        </h1>
        <p
          className="reveal mx-auto mt-7 max-w-2xl text-balance text-lg leading-relaxed text-muted"
          style={{ animationDelay: '160ms' }}
        >
          Every account you have — cloud bills, subscriptions, your phone and utilities, even your health record — lives
          behind its own login. Butin gathers them all into one dashboard on your own machine, readable without logging
          in. Your session, fetched headless, kept on your disk.
        </p>
        <div
          className="reveal mt-9 flex flex-wrap items-center justify-center gap-4"
          style={{ animationDelay: '240ms' }}
        >
          <a
            href={`${GITHUB}/releases`}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-teal px-6 py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.02]"
          >
            Download Butin
          </a>
          <Link
            href="/tour"
            className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-teal/50 hover:text-teal-soft"
          >
            Take the tour →
          </Link>
        </div>
        <div
          className="reveal mt-4 flex flex-wrap items-center justify-center gap-2 font-mono text-[11px] text-muted/80"
          style={{ animationDelay: '280ms' }}
        >
          <span className="rounded-md border border-line bg-surface/60 px-2.5 py-1">
            macOS (Apple Silicon &amp; Intel)
          </span>
          <span className="rounded-md border border-line bg-surface/60 px-2.5 py-1">Windows 10/11</span>
          <span className="rounded-md border border-line bg-surface/60 px-2.5 py-1">Linux (AppImage &amp; deb)</span>
        </div>
        <div
          className="reveal mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-wider text-muted"
          style={{ animationDelay: '320ms' }}
        >
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-teal" /> All in one place
          </span>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-muted" /> No login to open it
          </span>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-teal" /> Downloaded &amp; yours
          </span>
        </div>
      </div>

      <div className="reveal relative mx-auto mt-16 max-w-5xl" style={{ animationDelay: '380ms' }}>
        <div
          className="pointer-events-none absolute -inset-x-10 -top-8 bottom-0 -z-10 blur-3xl"
          style={{ background: 'radial-gradient(60% 50% at 50% 0%, rgba(98,212,200,0.14), transparent 70%)' }}
        />
        <AppShot
          src="/shots/overview.png"
          alt="Butin's Overview — cross-service spending totals, a combined monthly-spend chart, what changed, and a by-service table."
          label="butin — Overview"
        />
      </div>
    </div>

    {/* services strip */}
    <div className="mt-20 border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-6 sm:flex-row sm:items-center">
        <span className="font-mono text-xs uppercase tracking-wider text-muted/70">
          Connects to the services you already use
        </span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:ml-auto">
          {stripServices.map((s) => (
            <span key={s} className="font-mono text-sm text-ink/55">
              {s}
            </span>
          ))}
          <Link href="/services" className="font-mono text-sm text-teal-soft/80 transition-colors hover:text-teal-soft">
            +{SERVICE_COUNT - stripServices.length} more →
          </Link>
        </div>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- The problem

const Problem = () => {
  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-14 px-5 py-24 md:grid-cols-[1fr_0.85fr]">
      <div>
        <Kicker>The problem</Kicker>
        <h2
          className="mt-5 text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Your accounts live in <span className="text-teal-soft">separate dashboards.</span>
        </h2>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
          Spend, usage, invoices, and records are scattered across dozens of services. Many offer no public API and no
          export option, leaving you signing in one by one or copying numbers into spreadsheets. Butin connects directly
          to your accounts to pull your real data into one unified local view.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-surface/60 p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-line pb-3 font-mono text-xs">
          <span className="uppercase tracking-wider text-muted">Without Butin</span>
          <span className="text-destructive/80 font-medium">Scattered &amp; manual</span>
        </div>
        <div className="space-y-2.5 font-mono text-xs text-muted">
          <div className="flex items-center justify-between rounded-lg border border-line bg-bg/50 px-3.5 py-3">
            <span className="text-ink/80">AWS · Vercel · Cloudflare</span>
            <span className="text-muted/60">Separate consoles &amp; auth</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-line bg-bg/50 px-3.5 py-3">
            <span className="text-ink/80">Stripe · GitHub · SaaS</span>
            <span className="text-muted/60">Individual invoices &amp; receipts</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-line bg-bg/50 px-3.5 py-3">
            <span className="text-ink/80">Telecom · Utilities · Records</span>
            <span className="text-muted/60">No API, manual PDF downloads</span>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-line pt-3 font-mono text-xs">
          <span className="text-teal-soft font-medium">With Butin</span>
          <span className="text-teal font-semibold">One unified local view</span>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- How it works

const steps = [
  {
    n: '01',
    head: 'Sign in',
    title: 'Capture the session',
    body: 'A normal login window opens. You sign in by hand — password, MFA, SSO, magic link. Butin captures the session and stores it, encrypted, on your machine. It stays valid as long as the service keeps it — minutes for a bank, days for some.'
  },
  {
    n: '02',
    head: "While it's live",
    title: 'Fetch headless',
    body: 'While the session holds, Butin reads the same endpoints your browser would — quietly from Node, with no browser window left open. Refresh anytime on demand. When it expires, you simply sign back in.'
  },
  {
    n: '03',
    head: 'Keep it',
    title: 'Keep your data',
    body: "Every fetch becomes a clean dashboard — spend, usage, members, documents — normalized and saved on your disk, with history. The data is yours even after the session's gone."
  }
] as const

const HowItWorks = () => (
  <section className="relative border-y border-line">
    <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10 opacity-60" />
    <div className="mx-auto w-full max-w-6xl px-5 py-24">
      <Kicker>How it works</Kicker>
      <h2
        className="mt-5 max-w-2xl text-4xl font-bold tracking-tight md:text-5xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        You sign in once. <span className="text-teal-soft">Butin keeps every account in one place.</span>
      </h2>

      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {steps.map((s) => (
          <div
            key={s.n}
            className="group relative overflow-hidden rounded-2xl border border-teal/20 bg-gradient-to-b from-elevated to-surface p-7 transition-colors hover:border-teal/40"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted">{s.head}</span>
              <span className="font-mono text-2xl font-bold text-teal/40">{s.n}</span>
            </div>
            <h3
              className="mt-6 text-2xl font-semibold tracking-tight text-teal-soft"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {s.title}
            </h3>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">{s.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-4 rounded-2xl border border-teal/20 bg-teal/[0.04] px-6 py-5">
        <span className="text-sm leading-relaxed text-muted">
          <span className="font-semibold text-teal-soft">On-demand fetching.</span> No export wizard or background
          browser process required — opening a service queries its endpoints using your stored session. When the session
          expires, reconnect with one click.
        </span>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- See it

const Showcase = () => (
  <section className="mx-auto w-full max-w-6xl px-5 py-24">
    <Kicker>See it</Kicker>
    <h2
      className="mt-5 max-w-2xl text-4xl font-bold tracking-tight md:text-5xl"
      style={{ fontFamily: 'var(--font-display)' }}
    >
      One dashboard for <span className="text-teal-soft">everything you pay for.</span>
    </h2>
    <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
      The Overview rolls every service into one place — total spend, a combined monthly chart, what moved this month.
      Open any service for the full detail: billing, usage, members, invoices — each drawn by one generic renderer, so a
      phone bill and a cloud invoice read the same way.
    </p>

    <div className="mt-12 grid gap-6 lg:grid-cols-2">
      <div>
        <AppShot
          src="/shots/service-claude.png"
          alt="A Claude service page in Butin — Summary, Billing, Usage, and Members tabs with spend stat cards and a monthly-spend chart."
          label="butin — Claude"
        />
        <p className="mt-4 text-sm leading-relaxed text-muted">
          <span className="text-ink">Every service, the same shape.</span> Tabs for billing, usage, and members —
          normalized from whatever the service actually renders under the hood.
        </p>
      </div>
      <div>
        <AppShot
          src="/shots/service-videotron.png"
          alt="A Videotron telecom account in Butin — internet and mobile bills with a monthly-spend chart, in Canadian dollars."
          label="butin — Videotron"
        />
        <p className="mt-4 text-sm leading-relaxed text-muted">
          <span className="text-ink">Not just dev tools.</span>&nbsp;A phone bill, a water-heater rental, a bank
          statement — the same billing view, in the account&apos;s own currency, with the history the service
          doesn&apos;t keep.
        </p>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Beyond billing

const Proof = () => (
  <section className="relative border-y border-line bg-surface/30">
    <div className="mx-auto w-full max-w-6xl px-5 py-24">
      <Kicker>Beyond simple billing</Kicker>
      <h2
        className="mt-5 max-w-2xl text-4xl font-bold tracking-tight md:text-5xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Full structured records, <span className="text-teal-soft">exported locally.</span>
      </h2>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
        Butin isn&apos;t limited to billing summaries. For services with no public API — like the{' '}
        <span className="font-mono text-ink">carnet-sante</span> health portal — plugins extract complete records:
        profiles, medications, appointments, lab results, and document PDFs directly to your disk. No third-party
        servers, no intermediaries.
      </p>

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {[
          {
            k: 'No API required',
            d: 'If a browser can view it, a plugin can extract it. Butin supports services that lack a public API or restrict access behind enterprise tiers.'
          },
          {
            k: 'Complete records',
            d: 'Beyond high-level totals: usage breakdowns, member rosters, invoices, and exported documents are saved as clean local files.'
          },
          {
            k: `${SERVICE_COUNT}+ services, one model`,
            d: 'Cloud infrastructure, developer platforms, telecom, subscriptions, and AI providers — unified under one plugin contract.'
          }
        ].map((c) => (
          <div key={c.k} className="rounded-2xl border border-line bg-bg p-7">
            <h3 className="text-lg font-semibold tracking-tight">{c.k}</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">{c.d}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Local-first

const pillars = [
  { t: 'Your session', d: 'It replays the requests your own browser makes. No middleman, no shared credentials.' },
  { t: 'Your machine', d: 'Captured data lives under ~/butin, encrypted with your OS keychain. There is no server.' },
  { t: 'No custody', d: 'No account, no sync, nowhere to send your numbers. We run nothing that can read them.' },
  {
    t: 'Open source',
    d: 'The codebase is open source (Apache-2.0 & MIT). Read it, fork it, write your own plugins. Trust the architecture.'
  }
]

const LocalFirst = () => (
  <section className="relative border-b border-line">
    <div className="mx-auto w-full max-w-6xl px-5 py-24">
      <div className="grid gap-12 md:grid-cols-[0.9fr_1.1fr] md:items-center">
        <div>
          <Kicker>Your data. Your machine.</Kicker>
          <h2
            className="mt-5 text-4xl font-bold leading-tight tracking-tight md:text-5xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            The account it reads is <span className="text-teal-soft">always your own.</span>
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
            Butin only ever reads data that is already yours — in your own authenticated session, on your own hardware.
            Nothing leaves your machine, and no server takes custody of your credentials.
          </p>
          <p className="mt-6 font-mono text-sm text-teal-soft">Your data, brought home.</p>
        </div>

        <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
          {pillars.map((p) => (
            <div key={p.t} className="bg-bg p-7">
              <h3 className="text-lg font-semibold tracking-tight text-ink">{p.t}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted">{p.d}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-12 rounded-2xl border border-teal/20 bg-teal/[0.03] p-6 sm:p-8">
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-teal">
          <span className="size-2 rounded-full bg-teal" /> Security &amp; privacy architecture
        </div>
        <div className="mt-5 grid gap-6 sm:grid-cols-3">
          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              OS Keychain Encryption
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Credentials and sessions are encrypted using Electron&apos;s{' '}
              <code className="text-teal-soft">safeStorage</code>: Apple Keychain on macOS, Windows DPAPI, and Secret
              Service on Linux.
            </p>
          </div>
          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              Zero Background Daemons
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Pull-only architecture. Nothing runs in the background when the app is closed; all fetches are initiated
              by you when you open or refresh.
            </p>
          </div>
          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">Zero Telemetry</h4>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              No tracking scripts, external analytics, or phone-home pings. All retrieved data stays strictly within{' '}
              <code className="text-teal-soft">~/butin/</code> on your computer.
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- For developers

const ForDevelopers = () => (
  <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 py-24 md:grid-cols-[1fr_1.1fr]">
    <div>
      <Kicker>For developers</Kicker>
      <h2 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl" style={{ fontFamily: 'var(--font-display)' }}>
        A service is a <span className="text-teal-soft">small plugin.</span>
      </h2>
      <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
        {SERVICE_COUNT} services already ship, each a small, mostly-declarative plugin: describe how to log in and what
        to fetch, return normalized data, and one generic renderer draws the dashboard. Most plugins ship no UI at all.
      </p>
      <div className="mt-8 flex flex-wrap gap-4">
        <Link
          href="/docs/contributing"
          className="rounded-full border border-teal/40 bg-teal/10 px-6 py-3 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15"
        >
          Write a plugin →
        </Link>
        <a
          href={GITHUB}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-teal/50"
        >
          Read the source
        </a>
      </div>
    </div>

    <div className="overflow-hidden rounded-2xl border border-line bg-[#0c0e13] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="size-3 rounded-full bg-destructive/70" />
        <span className="size-3 rounded-full bg-amber/70" />
        <span className="size-3 rounded-full bg-success/70" />
        <span className="ml-3 font-mono text-xs text-muted">plugins/stripe/main.ts</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
        <code>
          <span className="text-teal-soft">export const</span> <span className="text-teal-soft">stripe</span> ={' '}
          <span className="text-teal-soft">definePlugin</span>({'({'}
          {'\n'} meta: {'{'} id: <span className="text-success">&apos;stripe&apos;</span>, name:{' '}
          <span className="text-success">&apos;Stripe&apos;</span> {'}'},{'\n'} session: {'{'} loginUrl:{' '}
          <span className="text-success">&apos;https://dashboard.stripe.com&apos;</span> {'}'},{'\n'} auth: {'{'} kind:{' '}
          <span className="text-success">&apos;cookie&apos;</span> {'}'},{'\n'} capabilities: [{'\n'}
          {'    '}
          {'{'} id: <span className="text-success">&apos;billing&apos;</span>,{'\n'}
          {'      '}collect: <span className="text-teal-soft">async</span> ({'{'} client {'}'}) {'=>'}
          {'\n'}
          {'        '}
          <span className="text-teal-soft">billing.result</span>({'{'} <span className="text-muted">/* … */</span> {'}'}
          ) {'}'}
          {'\n'} ]{'\n'}
          {'})'}
        </code>
      </pre>
    </div>
  </section>
)

// ---------------------------------------------------------------- Final CTA

const FinalCTA = () => (
  <section className="relative overflow-hidden">
    <div
      className="pointer-events-none absolute inset-0 -z-10"
      style={{ background: 'radial-gradient(60% 80% at 50% 120%, rgba(98,212,200,0.12), transparent 60%)' }}
    />
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-5 py-28 text-center">
      <div className="relative text-teal">
        <div
          className="brand-glow absolute inset-[-20%] -z-10 rounded-full blur-2xl"
          style={{ background: 'radial-gradient(circle, rgba(98,212,200,0.22), transparent 62%)' }}
        />
        <BrandMark className="size-24" title="Butin" />
      </div>
      <h2
        className="text-balance text-4xl font-bold tracking-tight md:text-6xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Their session expires. <span className="text-teal-soft">Your data doesn&apos;t.</span>
      </h2>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <a
          href={`${GITHUB}/releases`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-teal px-7 py-3.5 text-sm font-semibold text-bg transition-transform hover:scale-[1.02]"
        >
          Download Butin
        </a>
        <Link
          href="/docs"
          className="rounded-full border border-line-strong px-7 py-3.5 text-sm font-medium text-ink transition-colors hover:border-teal/50 hover:text-teal-soft"
        >
          Read the docs
        </Link>
      </div>
      <p className="font-mono text-xs uppercase tracking-wider text-muted">
        Free · Open source · macOS · Windows · Linux
      </p>
    </div>
  </section>
)

export default function HomePage() {
  return (
    <>
      <Hero />
      <Problem />
      <HowItWorks />
      <Showcase />
      <Proof />
      <LocalFirst />
      <ForDevelopers />
      <FinalCTA />
    </>
  )
}
