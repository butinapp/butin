import type { Metadata } from 'next'

import { BrandMark } from '@/components/brand'
import { Link } from '@/components/site-link'
import { GITHUB } from '@/lib/links'
import { visibleServices } from '@/lib/services'

const SERVICE_COUNT = visibleServices.length

export const metadata: Metadata = {
  title: 'Tous vos comptes. Un seul endroit.',
  description:
    'Une application de bureau locale qui réunit la facturation, l’utilisation et les documents de tous vos services au même endroit sur votre ordinateur.',
  openGraph: {
    title: 'Butin — Vos données, chez vous.',
    description:
      'Une application de bureau locale qui réunit la facturation, l’utilisation et les documents de tous vos services au même endroit sur votre ordinateur.',
    url: 'https://butin.app/fr',
    siteName: 'Butin',
    type: 'website',
    images: [
      {
        url: '/fr/opengraph-image.png',
        width: 1200,
        height: 630,
        alt: 'Butin — Vos comptes réunis. Chez vous.'
      }
    ]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Butin — Vos données, chez vous.',
    description:
      'Une application de bureau locale qui réunit la facturation, l’utilisation et les documents de tous vos services au même endroit sur votre ordinateur.',
    images: ['/fr/opengraph-image.png']
  }
}

const stripServices = [
  'Vidéotron',
  'AWS',
  'Carnet Santé',
  'Claude',
  'GitHub',
  'Hydro-Solution',
  'Vercel',
  'Airbnb',
  'ChatGPT'
]

const Kicker = ({ children }: { children: React.ReactNode }) => (
  <p className="inline-flex items-center gap-3 font-mono text-xs uppercase tracking-[0.28em] text-teal">
    <span className="h-px w-7 bg-gradient-to-r from-teal to-transparent" />
    {children}
  </p>
)

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
          <Kicker>Local-first · Code source ouvert · sans nuage</Kicker>
        </div>
        <h1
          className="reveal mt-6 text-balance text-5xl font-bold leading-[0.97] tracking-tight md:text-7xl"
          style={{ fontFamily: 'var(--font-display)', animationDelay: '80ms' }}
        >
          Tous vos comptes.
          <br />
          <span className="text-teal-soft">Un seul endroit.</span>
        </h1>
        <p
          className="reveal mx-auto mt-7 max-w-2xl text-balance text-lg leading-relaxed text-muted"
          style={{ animationDelay: '160ms' }}
        >
          Chaque compte que vous possédez — infonuagique, abonnements, téléphonie, électricité et même votre carnet de
          santé — vit derrière sa propre connexion. Butin les rassemble tous dans un tableau de bord local sur votre
          machine, consultable sans vous reconnecter. Vos données, chez vous.
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
            Télécharger Butin
          </a>
          <Link
            href="/fr/tour"
            className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-teal/50 hover:text-teal-soft"
          >
            Faire la visite →
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
          <span className="rounded-md border border-line bg-surface/60 px-2.5 py-1">Linux (AppImage)</span>
        </div>
        <div
          className="reveal mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-wider text-muted"
          style={{ animationDelay: '320ms' }}
        >
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-teal" /> Réuni au même endroit
          </span>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-muted" /> Sans connexion préalable
          </span>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-teal" /> Téléchargé et à vous
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
          alt="Aperçu Butin — total des dépenses multi-services, graphique mensuel combiné et tableau par service."
          label="butin — Aperçu"
        />
      </div>
    </div>

    {/* services strip */}
    <div className="mt-20 border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-6 sm:flex-row sm:items-center">
        <span className="font-mono text-xs uppercase tracking-wider text-muted/70">
          Fonctionne avec vos services quotidiens
        </span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:ml-auto">
          {stripServices.map((s) => (
            <span key={s} className="font-mono text-sm text-ink/55">
              {s}
            </span>
          ))}
          <Link
            href="/fr/services"
            className="font-mono text-sm text-teal-soft/80 transition-colors hover:text-teal-soft"
          >
            +{SERVICE_COUNT - stripServices.length} autres →
          </Link>
        </div>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Le problème

const Problem = () => (
  <section className="mx-auto grid w-full max-w-6xl items-center gap-14 px-5 py-24 md:grid-cols-[1fr_0.85fr]">
    <div>
      <Kicker>Le constat</Kicker>
      <h2 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl" style={{ fontFamily: 'var(--font-display)' }}>
        Vos comptes vivent dans des <span className="text-teal-soft">portails dispersés.</span>
      </h2>
      <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
        Dépenses, consommation, factures et historiques sont éparpillés sur des dizaines de plateformes. Beaucoup
        n&apos;offrent aucune API ni exportation, vous forçant à vous connecter une à une ou à recopier des chiffres
        dans un chiffrier. Butin rapatrie vos vraies données directement dans une vue locale unifiée.
      </p>
    </div>

    <div className="space-y-4 rounded-2xl border border-line bg-surface/60 p-6 shadow-xl">
      <div className="flex items-center justify-between border-b border-line pb-3 font-mono text-xs">
        <span className="uppercase tracking-wider text-muted">Sans Butin</span>
        <span className="font-medium text-destructive/80">Éparpillé et manuel</span>
      </div>
      <div className="space-y-2.5 font-mono text-xs text-muted">
        <div className="flex items-center justify-between rounded-lg border border-line bg-bg/50 px-3.5 py-3">
          <span className="text-ink/80">AWS · Vercel · Cloudflare</span>
          <span className="text-muted/60">Consoles et connexions séparées</span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-line bg-bg/50 px-3.5 py-3">
          <span className="text-ink/80">Stripe · GitHub · SaaS</span>
          <span className="text-muted/60">Factures individuelles à chercher</span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-line bg-bg/50 px-3.5 py-3">
          <span className="text-ink/80">Télécoms · Énergie · Santé</span>
          <span className="text-muted/60">Aucune API, téléchargements manuels</span>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-line pt-3 font-mono text-xs">
        <span className="font-medium text-teal-soft">Avec Butin</span>
        <span className="font-semibold text-teal">Un tableau de bord local unique</span>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Comment ça marche

const steps = [
  {
    n: '01',
    head: 'Connexion',
    title: 'Capturez la session',
    body: 'Une fenêtre de connexion normale s’ouvre. Vous vous connectez à la main — mot de passe, A2F, SSO ou lien par courriel. Butin sauvegarde la session chiffrée sur votre machine.'
  },
  {
    n: '02',
    head: 'En session active',
    title: 'Récupération en arrière-plan',
    body: 'Tant que la session est valide, Butin interroge les mêmes données que votre navigateur — en arrière-plan depuis Node, sans fenêtre ouverte. Actualisez à la demande.'
  },
  {
    n: '03',
    head: 'Rapatriez',
    title: 'Gardez vos données',
    body: 'Chaque récupération devient un tableau de bord clair — dépenses, consommation, membres, documents — normalisé et conservé sur votre disque avec son historique.'
  }
] as const

const HowItWorks = () => (
  <section className="relative border-y border-line">
    <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10 opacity-60" />
    <div className="mx-auto w-full max-w-6xl px-5 py-24">
      <Kicker>Fonctionnement</Kicker>
      <h2
        className="mt-5 max-w-2xl text-4xl font-bold tracking-tight md:text-5xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Vous vous connectez une fois. <span className="text-teal-soft">Butin réunit tout au même endroit.</span>
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
          <span className="font-semibold text-teal-soft">Récupération à la demande.</span> Pas d’exportation complexe ni
          de navigateur à surveiller — ouvrir un service interroge directement ses points d’accès avec votre session
          sécurisée.
        </span>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Démonstration

const Showcase = () => (
  <section className="mx-auto w-full max-w-6xl px-5 py-24">
    <Kicker>Démonstration</Kicker>
    <h2
      className="mt-5 max-w-2xl text-4xl font-bold tracking-tight md:text-5xl"
      style={{ fontFamily: 'var(--font-display)' }}
    >
      Un tableau de bord pour <span className="text-teal-soft">tout ce que vous payez.</span>
    </h2>
    <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
      L’Aperçu réunit chaque service : dépenses totales, graphique mensuel combiné et variations récentes. Ouvrez
      n’importe quel service pour le détail complet : facturation, utilisation, membres et documents PDF.
    </p>

    <div className="mt-12 grid gap-6 lg:grid-cols-2">
      <div>
        <AppShot
          src="/shots/service-claude.png"
          alt="Page de service Claude dans Butin — onglets Sommaire, Facturation, Utilisation et Membres."
          label="butin — Claude"
        />
        <p className="mt-4 text-sm leading-relaxed text-muted">
          <span className="text-ink">Chaque service, la même structure.</span> Des onglets clairs pour la facturation et
          l’utilisation, normalisés quelle que soit l’interface d’origine.
        </p>
      </div>
      <div>
        <AppShot
          src="/shots/service-videotron.png"
          alt="Compte télécom Vidéotron dans Butin — factures internet et mobile avec graphique en dollars canadiens."
          label="butin — Vidéotron"
        />
        <p className="mt-4 text-sm leading-relaxed text-muted">
          <span className="text-ink">Pas seulement les outils de développement.</span> Une facture mobile, une location
          de chauffe-eau, un relevé de compte — dans la devise d’origine, avec l’historique que le service ne garde pas.
        </p>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Au-delà de la facturation

const Proof = () => (
  <section className="relative border-y border-line bg-surface/30">
    <div className="mx-auto w-full max-w-6xl px-5 py-24">
      <Kicker>Au-delà de la simple facturation</Kicker>
      <h2
        className="mt-5 max-w-2xl text-4xl font-bold tracking-tight md:text-5xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Des dossiers structurés complets, <span className="text-teal-soft">exportés localement.</span>
      </h2>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
        Butin ne s’arrête pas aux chiffres de facturation. Pour des portails gouvernementaux sans API comme le{' '}
        <span className="font-mono text-ink">carnet-sante</span> québécois, le plugin extrait le dossier complet :
        profil, médicaments, rendez-vous, résultats d’analyses et rapports d’imagerie directement sur votre disque.
        Aucun serveur intermédiaire.
      </p>

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {[
          {
            k: 'Aucune API requise',
            d: 'Si votre navigateur peut l’afficher, un plugin peut l’extraire. Butin couvre les services sans API publique ou réservés aux forfaits d’entreprise.'
          },
          {
            k: 'Dossiers intégraux',
            d: 'Au-delà des totaux mensuels : historique de consommation, répertoires d’équipe, factures et fichiers PDF archivés dans des formats ouverts.'
          },
          {
            k: `${SERVICE_COUNT}+ services supportés`,
            d: 'Infrastructures infonuagiques, services télécoms, abonnements numériques et services publics, sous un contrat de plugin unique.'
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
  { t: 'Votre session', d: 'Rejoue les requêtes exactes que ferait votre propre navigateur. Aucun intermédiaire.' },
  { t: 'Votre machine', d: 'Vos données résident sous ~/butin, chiffrées avec le trousseau de votre système.' },
  {
    t: 'Aucune garde',
    d: 'Aucun compte externe, aucune synchronisation sur nos serveurs. Rien ne transite chez nous.'
  },
  {
    t: 'Code source ouvert',
    d: 'Le moteur est ouvert (Apache-2.0 et MIT). Inspectez le code, créez vos propres plugins, auditez l’architecture.'
  }
]

const LocalFirst = () => (
  <section className="relative border-b border-line">
    <div className="mx-auto w-full max-w-6xl px-5 py-24">
      <div className="grid gap-12 md:grid-cols-[0.9fr_1.1fr] md:items-center">
        <div>
          <Kicker>Vos données. Votre machine.</Kicker>
          <h2
            className="mt-5 text-4xl font-bold leading-tight tracking-tight md:text-5xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Le compte consulté est <span className="text-teal-soft">toujours le vôtre.</span>
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
            Butin n’accède qu’aux données qui vous appartiennent déjà — dans votre propre session authentifiée, sur
            votre matériel. Rien ne quitte votre ordinateur.
          </p>
          <p className="mt-6 font-mono text-sm text-teal-soft">Vos données, chez vous.</p>
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
          <span className="size-2 rounded-full bg-teal" /> Architecture de sécurité et confidentialité
        </div>
        <div className="mt-5 grid gap-6 sm:grid-cols-3">
          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              Chiffrement par trousseau système
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Identifiants et sessions scellés avec <code className="text-teal-soft">safeStorage</code> d&apos;Electron
              : Apple Keychain sur macOS, DPAPI sous Windows, et Secret Service sous Linux.
            </p>
          </div>
          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              Aucun démon d’arrière-plan
            </h4>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Architecture sur demande. Aucun processus caché ne s&apos;exécute lorsque l&apos;application est fermée ;
              les requêtes n&apos;ont lieu que lors de vos actualisations.
            </p>
          </div>
          <div>
            <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">Zéro télémétrie</h4>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Aucun script de traçage, aucune analyse externe. La seule requête que Butin fait de lui-même est une
              vérification de sa prochaine version, une fois par lancement : il demande à GitHub la dernière version, en
              transmettant votre adresse IP et la version de l’application, rien d’autre. Un réglage la désactive.
              Toutes vos données restent strictement confinées dans <code className="text-teal-soft">~/butin/</code> sur
              votre disque.
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
)

// ---------------------------------------------------------------- Pour les développeurs

const ForDevelopers = () => (
  <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 py-24 md:grid-cols-[1fr_1.1fr]">
    <div>
      <Kicker>Pour les développeurs</Kicker>
      <h2 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl" style={{ fontFamily: 'var(--font-display)' }}>
        Un service est un <span className="text-teal-soft">simple plugin.</span>
      </h2>
      <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
        {SERVICE_COUNT} services sont déjà inclus, chacun sous la forme d’un plugin compact et déclaratif : décrivez la
        connexion et les points à récupérer, et un moteur générique s’occupe du rendu.
      </p>
      <div className="mt-8 flex flex-wrap gap-4">
        <Link
          href="/docs/contributing"
          className="rounded-full border border-teal/40 bg-teal/10 px-6 py-3 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15"
        >
          Créer un plugin →
        </Link>
        <a
          href={GITHUB}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-teal/50"
        >
          Voir le code source
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
        Leur session expire. <span className="text-teal-soft">Pas vos données.</span>
      </h2>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <a
          href={`${GITHUB}/releases`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-teal px-7 py-3.5 text-sm font-semibold text-bg transition-transform hover:scale-[1.02]"
        >
          Télécharger Butin
        </a>
        <Link
          href="/docs"
          className="rounded-full border border-line-strong px-7 py-3.5 text-sm font-medium text-ink transition-colors hover:border-teal/50 hover:text-teal-soft"
        >
          Consulter la doc
        </Link>
      </div>
      <p className="font-mono text-xs uppercase tracking-wider text-muted">
        Gratuit · Code source ouvert · macOS · Windows · Linux
      </p>
    </div>
  </section>
)

export default function FrenchHomePage() {
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
