// The catalog of services Butin ships a plugin for (meta + capabilities), seeded from the real
// `../../plugins/*` plugin metas. A `held` service stays in the data but is filtered out of the rendered
// list (e.g. finance) until deliberately surfaced. Re-sync when the plugin roster changes.

export type ServiceGroup = 'dev' | 'beyond' | 'ai'

export interface Service {
  id: string
  name: string
  vendor: string
  category: string
  connect: 'Sign-in' | 'API key'
  blurb: string
  caps: string[]
  color: string
  homepage: string
  group: ServiceGroup
  held?: boolean
}

export const services: Service[] = [
  // ---- AI & inference ----
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Billing, team usage analytics, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#d97757',
    homepage: 'https://claude.ai',
    group: 'ai'
  },
  {
    id: 'anthropic-console',
    name: 'Anthropic Console',
    vendor: 'Anthropic',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Open-period spend, per-member usage, API keys, and members.',
    caps: ['Billing', 'Usage', 'API keys', 'Members'],
    color: '#d97757',
    homepage: 'https://console.anthropic.com',
    group: 'ai'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    vendor: 'OpenAI',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Team billing, Codex usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#10a37f',
    homepage: 'https://chatgpt.com',
    group: 'ai'
  },
  {
    id: 'openai-platform',
    name: 'OpenAI Platform',
    vendor: 'OpenAI',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Per-org billing, invoices, API keys, and members.',
    caps: ['Billing', 'API keys', 'Members'],
    color: '#10a37f',
    homepage: 'https://platform.openai.com',
    group: 'ai'
  },
  {
    id: 'groq',
    name: 'Groq',
    vendor: 'Groq',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Spend, invoices, usage, API keys, and members.',
    caps: ['Billing', 'Usage', 'API keys', 'Members'],
    color: '#f55036',
    homepage: 'https://groq.com',
    group: 'ai'
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    vendor: 'Cerebras',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Credit balance, billing, usage, and API keys.',
    caps: ['Billing', 'Usage', 'API keys', 'Members'],
    color: '#f55036',
    homepage: 'https://cloud.cerebras.ai',
    group: 'ai'
  },
  {
    id: 'baseten',
    name: 'Baseten',
    vendor: 'Baseten',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Credit spend, model usage, API keys, and members.',
    caps: ['Billing', 'Usage', 'API keys', 'Members'],
    color: '#6c5ce7',
    homepage: 'https://baseten.co',
    group: 'ai'
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    vendor: 'Fireworks AI',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Invoices and total billed.',
    caps: ['Billing'],
    color: '#5019c5',
    homepage: 'https://fireworks.ai',
    group: 'ai'
  },
  {
    id: 'xai',
    name: 'xAI',
    vendor: 'xAI',
    category: 'AI',
    connect: 'Sign-in',
    blurb: 'Spending limits, model usage, and API keys.',
    caps: ['Billing', 'API keys'],
    color: '#1a1a1a',
    homepage: 'https://x.ai',
    group: 'ai'
  },

  // ---- Developer & cloud tools ----
  {
    id: 'aws',
    name: 'AWS',
    vendor: 'Amazon Web Services',
    category: 'Cloud',
    connect: 'API key',
    blurb: 'Cost Explorer spend and IAM Identity Center users.',
    caps: ['Billing', 'Members'],
    color: '#ff9900',
    homepage: 'https://aws.amazon.com',
    group: 'dev'
  },
  {
    id: 'vercel',
    name: 'Vercel',
    vendor: 'Vercel',
    category: 'Cloud',
    connect: 'Sign-in',
    blurb: 'Spend, invoices, and team members.',
    caps: ['Billing', 'Members'],
    color: '#e5e7eb',
    homepage: 'https://vercel.com',
    group: 'dev'
  },
  {
    id: 'supabase',
    name: 'Supabase',
    vendor: 'Supabase',
    category: 'Cloud',
    connect: 'Sign-in',
    blurb: 'Projected spend, project usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#3ecf8e',
    homepage: 'https://supabase.com',
    group: 'dev'
  },
  {
    id: 'qdrant',
    name: 'Qdrant Cloud',
    vendor: 'Qdrant',
    category: 'Cloud',
    connect: 'Sign-in',
    blurb: 'Metered spend, members, and API keys.',
    caps: ['Billing', 'Members', 'API keys'],
    color: '#d6204a',
    homepage: 'https://qdrant.tech',
    group: 'dev'
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    vendor: 'ClickHouse',
    category: 'Cloud',
    connect: 'Sign-in',
    blurb: 'Compute & storage usage, invoices, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#faff69',
    homepage: 'https://clickhouse.com',
    group: 'dev'
  },
  {
    id: 'upstash',
    name: 'Upstash',
    vendor: 'Upstash',
    category: 'Cloud',
    connect: 'Sign-in',
    blurb: 'Redis, QStash & Vector spend, API keys, and members.',
    caps: ['Billing', 'API keys', 'Members'],
    color: '#00e9a3',
    homepage: 'https://upstash.com',
    group: 'dev'
  },
  {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Subscription spend, invoices, usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#6a5fc1',
    homepage: 'https://sentry.io',
    group: 'dev'
  },
  {
    id: 'grafana',
    name: 'Grafana',
    vendor: 'Grafana Labs',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Plan billing, stack usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#f46800',
    homepage: 'https://grafana.com',
    group: 'dev'
  },
  {
    id: 'posthog',
    name: 'PostHog',
    vendor: 'PostHog',
    category: 'Analytics',
    connect: 'Sign-in',
    blurb: 'Projected spend, product usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#f54e00',
    homepage: 'https://posthog.com',
    group: 'dev'
  },
  {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Subscription spend, invoices, and members.',
    caps: ['Billing', 'Members'],
    color: '#5e6ad2',
    homepage: 'https://linear.app',
    group: 'dev'
  },
  {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    category: 'Payments',
    connect: 'Sign-in',
    blurb: 'Your processing fees, broken down by product.',
    caps: ['Fees'],
    color: '#635bff',
    homepage: 'https://stripe.com',
    group: 'dev'
  },
  {
    id: 'github-enterprise',
    name: 'GitHub Enterprise',
    vendor: 'GitHub',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Enterprise billing, invoices, and usage.',
    caps: ['Billing', 'Usage'],
    color: '#1f2328',
    homepage: 'https://github.com',
    group: 'dev'
  },
  {
    id: 'infisical',
    name: 'Infisical',
    vendor: 'Infisical',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Seat billing, usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#ebeef7',
    homepage: 'https://infisical.com',
    group: 'dev'
  },
  {
    id: 'ngrok',
    name: 'ngrok',
    vendor: 'ngrok',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Seat billing, API keys, and members.',
    caps: ['Billing', 'API keys', 'Members'],
    color: '#1f1e24',
    homepage: 'https://ngrok.com',
    group: 'dev'
  },
  {
    id: 'serper',
    name: 'Serper',
    vendor: 'Serper',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Credits, billing, usage, and API keys.',
    caps: ['Billing', 'Usage', 'API keys'],
    color: '#8ac7f0',
    homepage: 'https://serper.dev',
    group: 'dev'
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    vendor: 'Firecrawl',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Billing and API keys.',
    caps: ['Billing', 'API keys'],
    color: '#fb6c0a',
    homepage: 'https://firecrawl.dev',
    group: 'dev'
  },
  {
    id: 'depot',
    name: 'Depot',
    vendor: 'Depot',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Build-minute usage, invoices, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#9d5cff',
    homepage: 'https://depot.dev',
    group: 'dev'
  },
  {
    id: 'hookdeck',
    name: 'Hookdeck',
    vendor: 'Hookdeck',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Plan billing, usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#004dff',
    homepage: 'https://hookdeck.com',
    group: 'dev'
  },
  {
    id: 'greptile',
    name: 'Greptile',
    vendor: 'Greptile',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Seat billing, review usage, API keys, and members.',
    caps: ['Billing', 'Usage', 'API keys', 'Members'],
    color: '#0e7c5a',
    homepage: 'https://greptile.com',
    group: 'dev'
  },
  {
    id: 'novu',
    name: 'Novu',
    vendor: 'Novu',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Plan billing, channel usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#0f62fe',
    homepage: 'https://novu.co',
    group: 'dev'
  },
  {
    id: 'ably',
    name: 'Ably',
    vendor: 'Ably',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Plan billing and message usage.',
    caps: ['Billing', 'Usage'],
    color: '#ff5416',
    homepage: 'https://ably.com',
    group: 'dev'
  },
  {
    id: 'unleash',
    name: 'Unleash',
    vendor: 'Unleash',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Seat billing, API keys, and members.',
    caps: ['Billing', 'API keys', 'Members'],
    color: '#1a4049',
    homepage: 'https://www.getunleash.io',
    group: 'dev'
  },
  {
    id: 'dnsimple',
    name: 'DNSimple',
    vendor: 'DNSimple',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Domain billing, access tokens, and account.',
    caps: ['Billing', 'Members', 'Access tokens'],
    color: '#3f88c5',
    homepage: 'https://dnsimple.com',
    group: 'dev'
  },
  {
    id: 'screenshotapi',
    name: 'Screenshot API',
    vendor: 'ScreenshotAPI',
    category: 'Dev tools',
    connect: 'API key',
    blurb: 'Plan billing and screenshot usage.',
    caps: ['Billing', 'Usage'],
    color: '#10b981',
    homepage: 'https://screenshotapi.net',
    group: 'dev'
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    vendor: 'Google',
    category: 'Productivity',
    connect: 'Sign-in',
    blurb: 'Subscription seats, billing, and usage.',
    caps: ['Billing', 'Usage'],
    color: '#1a73e8',
    homepage: 'https://workspace.google.com',
    group: 'dev'
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    vendor: 'HubSpot',
    category: 'CRM',
    connect: 'Sign-in',
    blurb: 'Product billing, contact usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#ff7a59',
    homepage: 'https://www.hubspot.com',
    group: 'dev'
  },
  {
    id: 'intercom',
    name: 'Intercom',
    vendor: 'Intercom',
    category: 'Support',
    connect: 'Sign-in',
    blurb: 'Plan billing, seat usage, and members.',
    caps: ['Billing', 'Usage', 'Members'],
    color: '#1f8ded',
    homepage: 'https://www.intercom.com',
    group: 'dev'
  },

  // ---- Beyond dev tools ----
  {
    id: 'carnet-sante',
    name: 'Carnet Santé',
    vendor: 'RAMQ',
    category: 'Health',
    connect: 'Sign-in',
    blurb:
      'Your full Québec health record — profile, meds, labs, imaging, appointments, services, and the access journal.',
    caps: ['Profile', 'Medications', 'Labs', 'Imaging', 'Documents'],
    color: '#003da5',
    homepage: 'https://www.quebec.ca/sante/carnet-sante-quebec',
    group: 'beyond'
  },
  {
    id: 'videotron',
    name: 'Videotron',
    vendor: 'Vidéotron',
    category: 'Telecom',
    connect: 'Sign-in',
    blurb: 'Internet & mobile bills, services, and invoice PDFs.',
    caps: ['Billing', 'Mobile', 'Services', 'Invoices'],
    color: '#ffe512',
    homepage: 'https://www.videotron.com',
    group: 'beyond'
  },
  {
    id: 'hydrosolution',
    name: 'Hydro-Solution',
    vendor: 'Hydro-Solution',
    category: 'Utilities',
    connect: 'Sign-in',
    blurb: 'Rental billing, equipment details, and bill PDFs.',
    caps: ['Billing', 'Equipment', 'Invoices'],
    color: '#0098d8',
    homepage: 'https://www.hydrosolution.com',
    group: 'beyond'
  },
  {
    id: 'airbnb',
    name: 'Airbnb',
    vendor: 'Airbnb',
    category: 'Rental',
    connect: 'Sign-in',
    blurb: 'Host payout earnings, transactions, and tax documents.',
    caps: ['Transactions', 'Tax documents'],
    color: '#ff5a5f',
    homepage: 'https://www.airbnb.com',
    group: 'beyond'
  },
  {
    id: 'amazon',
    name: 'Amazon',
    vendor: 'Amazon',
    category: 'Shopping',
    connect: 'Sign-in',
    blurb: 'Order history and per-order billing.',
    caps: ['Orders', 'Billing'],
    color: '#ff9900',
    homepage: 'https://www.amazon.com',
    group: 'beyond'
  },
  {
    id: 'desjardins',
    name: 'Desjardins',
    vendor: 'Desjardins',
    category: 'Finance',
    connect: 'Sign-in',
    blurb: 'Account balances and statement PDFs.',
    caps: ['Accounts', 'Statements'],
    color: '#00874e',
    homepage: 'https://www.desjardins.com',
    group: 'beyond',
    held: true
  }
]

export const visibleServices = services.filter((s) => !s.held)
