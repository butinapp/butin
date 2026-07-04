// The Picks catalog — the services Butin ships a plugin for (meta + capabilities). Status-only stubs are
// omitted. A `held` service stays in the data but is filtered out of the rendered list (e.g. finance) until
// deliberately surfaced.

export type ServiceGroup = 'dev' | 'beyond'

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
    group: 'dev'
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
    group: 'dev'
  },
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
    id: 'github-enterprise',
    name: 'GitHub Enterprise',
    vendor: 'GitHub',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Enterprise billing, invoices, and usage.',
    caps: ['Billing', 'Invoices', 'Usage'],
    color: '#1f2328',
    homepage: 'https://github.com',
    group: 'dev'
  },
  {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Subscription spend, invoices, usage, and members.',
    caps: ['Billing', 'Invoices', 'Usage', 'Members'],
    color: '#6a5fc1',
    homepage: 'https://sentry.io',
    group: 'dev'
  },
  {
    id: 'serper',
    name: 'Serper',
    vendor: 'Serper',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Credits, billing, usage, and API keys.',
    caps: ['Billing', 'Invoices', 'Usage', 'API keys'],
    color: '#4d3df7',
    homepage: 'https://serper.dev',
    group: 'dev'
  },
  {
    id: 'vercel',
    name: 'Vercel',
    vendor: 'Vercel',
    category: 'Dev tools',
    connect: 'Sign-in',
    blurb: 'Spend, invoices, and team members.',
    caps: ['Billing', 'Invoices', 'Members'],
    color: '#e5e7eb',
    homepage: 'https://vercel.com',
    group: 'dev'
  },
  {
    id: 'carnet-sante',
    name: 'Carnet Santé',
    vendor: 'RAMQ',
    category: 'Health',
    connect: 'Sign-in',
    blurb:
      'Your full Québec health record — profile, meds, labs, imaging, appointments, services, and the access journal.',
    caps: ['Profile', 'Medications', 'Labs', 'Imaging', 'Documents'],
    color: '#0a6b3b',
    homepage: 'https://www.quebec.ca/sante/carnet-sante-quebec',
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
