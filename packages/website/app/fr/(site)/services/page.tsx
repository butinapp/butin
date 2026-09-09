import type { Metadata } from 'next'

import { ServiceIcon } from '@/components/service-icon'
import { Link } from '@/components/site-link'
import { GITHUB } from '@/lib/links'
import { type Service, visibleServices } from '@/lib/services'

export const metadata: Metadata = {
  title: 'Services',
  description:
    'Le catalogue des services pris en charge par Butin — infrastructure infonuagique, outils développeur, abonnements, services publics et IA.'
}

const groups: { id: Service['group']; title: string; blurb: string }[] = [
  {
    id: 'dev',
    title: 'Infrastructures infonuagiques et outils développeur',
    blurb: 'Hébergement infonuagique, bases de données, suivi d’erreurs et outillage de développement.'
  },
  {
    id: 'beyond',
    title: 'Abonnements et services du quotidien',
    blurb: 'Téléphonie, électricité, logement et dossiers personnels sans API fournisseur.'
  },
  {
    id: 'ai',
    title: 'Fournisseurs d’IA et modèles',
    blurb: 'Consommation de jetons, facturation en cours et gestion des clés d’API.'
  }
]

const frBlurbs: Record<string, string> = {
  claude: 'Facturation, analytique d’utilisation d’équipe et membres.',
  'anthropic-console': 'Dépenses de la période, utilisation par membre, clés d’API et membres.',
  chatgpt: 'Facturation d’équipe, consommation Codex et membres.',
  'openai-platform': 'Facturation par organisation, factures, clés d’API et membres.',
  groq: 'Dépenses, factures, utilisation, clés d’API et membres.',
  cerebras: 'Solde de crédits, facturation, consommation et clés d’API.',
  baseten: 'Consommation de crédits, utilisation des modèles, clés d’API et membres.',
  fireworks: 'Factures et total facturé.',
  xai: 'Limites de dépenses, utilisation des modèles et clés d’API.',
  aws: 'Dépenses Cost Explorer et utilisateurs IAM Identity Center.',
  vercel: 'Dépenses, factures et membres de l’équipe.',
  supabase: 'Dépenses projetées, utilisation des projets et membres.',
  qdrant: 'Dépenses à l’usage, membres et clés d’API.',
  clickhouse: 'Utilisation calcul et stockage, factures et membres.',
  upstash: 'Dépenses Redis, QStash et Vector, clés d’API et membres.',
  sentry: 'Dépenses d’abonnement, factures, utilisation et membres.',
  grafana: 'Facturation du forfait, utilisation de la pile et membres.',
  posthog: 'Dépenses projetées, utilisation produit et membres.',
  linear: 'Dépenses d’abonnement, factures et membres.',
  stripe: 'Vos frais de traitement détaillés par produit.',
  'github-enterprise': 'Facturation Enterprise, factures et utilisation.',
  infisical: 'Facturation par siège, utilisation et membres.',
  ngrok: 'Facturation par siège, clés d’API et membres.',
  serper: 'Crédits, facturation, utilisation et clés d’API.',
  firecrawl: 'Facturation et clés d’API.',
  depot: 'Minutes de compilation, factures et membres.',
  hookdeck: 'Facturation du forfait, utilisation et membres.',
  greptile: 'Facturation par siège, revues de code, clés d’API et membres.',
  novu: 'Facturation du forfait, utilisation des canaux et membres.',
  ably: 'Facturation du forfait et volume de messages.',
  unleash: 'Facturation par siège, clés d’API et membres.',
  dnsimple: 'Facturation des domaines, jetons d’accès et compte.',
  screenshotapi: 'Facturation du forfait et utilisation des captures.',
  'google-workspace': 'Sièges d’abonnement, facturation et utilisation.',
  hubspot: 'Facturation produit, volume de contacts et membres.',
  intercom: 'Facturation du forfait, sièges utilisés et membres.',
  'carnet-sante':
    'Dossier santé Québec complet — profil, médicaments, analyses, imagerie, rendez-vous, services et journal des accès.',
  videotron: 'Factures internet et mobile, services et PDF de factures.',
  hydrosolution: 'Facturation de location, détails des équipements et PDF de factures.',
  airbnb: 'Revenus d’hôte, transactions et documents fiscaux.',
  amazon: 'Historique des commandes et facturation par commande.',
  desjardins: 'Soldes de comptes et PDF de relevés.'
}

const frCaps: Record<string, string> = {
  Billing: 'Facturation',
  Usage: 'Utilisation',
  Members: 'Membres',
  'API keys': 'Clés d’API',
  Fees: 'Frais',
  'Access tokens': 'Jetons d’accès',
  Profile: 'Profil',
  Medications: 'Médicaments',
  Labs: 'Analyses',
  Imaging: 'Imagerie',
  Documents: 'Documents',
  Mobile: 'Mobile',
  Services: 'Services',
  Invoices: 'Factures',
  Equipment: 'Équipement',
  Transactions: 'Transactions',
  'Tax documents': 'Documents fiscaux',
  Orders: 'Commandes',
  Accounts: 'Comptes',
  Statements: 'Relevés'
}

const frCategories: Record<string, string> = {
  AI: 'IA',
  Cloud: 'Infonuagique',
  'Dev tools': 'Outils dev',
  Analytics: 'Analytique',
  Payments: 'Paiements',
  Productivity: 'Productivité',
  CRM: 'CRM',
  Support: 'Assistance',
  Health: 'Santé',
  Telecom: 'Télécoms',
  Utilities: 'Services publics',
  Rental: 'Location',
  Shopping: 'Achats',
  Finance: 'Finances'
}

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
      <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted/70">
        {frCategories[service.category] || service.category}
      </span>
    </div>

    <p className="mt-4 flex-1 text-sm leading-relaxed text-muted">{frBlurbs[service.id] || service.blurb}</p>

    <div className="mt-4 flex flex-wrap gap-1.5">
      {service.caps.map((c) => (
        <span key={c} className="rounded-md border border-line bg-bg/60 px-2 py-0.5 font-mono text-[11px] text-ink/70">
          {frCaps[c] || c}
        </span>
      ))}
    </div>

    <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
      <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
        <span
          className={`size-1.5 rounded-full ${service.connect === 'API key' ? 'bg-amber' : 'bg-teal'}`}
          style={{ boxShadow: `0 0 7px ${service.connect === 'API key' ? 'var(--color-amber)' : 'var(--color-teal)'}` }}
        />
        {service.connect === 'API key' ? 'Connexion par clé' : 'Connexion par navigateur'}
      </span>
      <span className="font-mono text-[11px] text-muted/60 transition-colors group-hover:text-teal-soft">↗</span>
    </div>
  </a>
)

export default function FrenchServicesPage() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-28">
      <p className="inline-flex items-center gap-3 font-mono text-xs uppercase tracking-[0.28em] text-teal">
        <span className="h-px w-7 bg-gradient-to-r from-teal to-transparent" />
        Le catalogue
      </p>
      <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-6xl" style={{ fontFamily: 'var(--font-display)' }}>
        Un plugin pour chaque <span className="text-teal-soft">service.</span>
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">
        Chaque plugin permet à Butin de récupérer un service directement avec votre propre connexion — sans API requise.
        Le catalogue s’enrichit à chaque mise à jour, et vous pouvez{' '}
        <Link href="/docs/contributing" className="text-teal-soft underline-offset-4 hover:underline">
          créer le vôtre
        </Link>
        .
      </p>
      <p className="mt-3 font-mono text-xs text-muted">{visibleServices.length} services pris en charge</p>

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

      <div className="mt-20 flex flex-col items-start gap-5 rounded-2xl border border-teal/20 bg-teal/[0.04] p-8 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Un service manque à l’appel ?</h2>
          <p className="mt-1.5 text-sm text-muted">
            Demandez un plugin sur GitHub, ou créez le vôtre en moins de 50 lignes de code déclaratif.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <a
            href={`${GITHUB}/issues/new?title=Plugin+request:+[Service+Name]`}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-line-strong px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-teal/50 hover:text-teal-soft"
          >
            Demander un plugin ↗
          </a>
          <Link
            href="/docs/contributing"
            className="rounded-full border border-teal/40 bg-teal/10 px-4 py-2 text-sm font-medium text-teal-soft transition-colors hover:bg-teal/15"
          >
            Créer un plugin →
          </Link>
        </div>
      </div>
    </section>
  )
}
