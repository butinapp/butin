import type { Locale } from './labels.js'

// Plugin i18n. Capability reports are computed headless (no locale) and cached, then rendered where the
// locale lives — so the strings a plugin EMITS (tab labels, column headers, view/summary titles) are baked
// as their canonical language and must be translated at RENDER time (flipping language re-renders from cache,
// no re-fetch). Rather than make every plugin carry per-string keys, we translate by the canonical string
// itself against this central dictionary: known terms map to the active locale, everything else (the
// service's own DATA, and bespoke labels not in the dict) passes through verbatim.
//
// The dict is BIDIRECTIONAL for the shared vocabulary: most plugins emit English (translate under `fr`), but
// some emit French (carnet-sante's clinical terms, a bank's statements) — those translate under `en`. A
// plugin only needs its own `meta.messages` for DOMAIN terms this shared dict doesn't carry.
export type PluginMessages = Record<string, Record<string, string>>

// en→fr for the common, English-canonical vocabulary plugins + presets emit.
const EN_TO_FR: Record<string, string> = {
  // Capability tabs / sections.
  Summary: 'Résumé',
  Billing: 'Facturation',
  Usage: 'Utilisation',
  Members: 'Membres',
  Member: 'Membre',
  'API Keys': 'Clés API',
  'API keys': 'Clés API',
  Documents: 'Documents',
  Invoices: 'Factures',
  Payments: 'Paiements',
  Activity: 'Activité',
  Account: 'Compte',
  Authentication: 'Authentification',
  Overview: 'Aperçu',

  // Common column / field labels.
  Name: 'Nom',
  Email: 'Courriel',
  Role: 'Rôle',
  Status: 'Statut',
  Amount: 'Montant',
  Date: 'Date',
  Time: 'Heure',
  Month: 'Mois',
  Type: 'Type',
  Created: 'Créé',
  'Created by': 'Créé par',
  Expires: 'Expiration',
  Expiration: 'Expiration',
  Quantity: 'Quantité',
  Region: 'Région',
  Organization: 'Organisation',
  'Organization ID': "ID d'organisation",
  'Organization slug': "Identifiant d'organisation",
  Project: 'Projet',
  Cluster: 'Grappe',
  Card: 'Carte',
  'Last 4': '4 derniers',
  Plan: 'Forfait',
  Spend: 'Dépenses',
  'Spend (MTD)': 'Dépenses (cumul mois)',
  'This month': 'Ce mois-ci',
  Credits: 'Crédits',
  'Credit balance': 'Solde de crédits',
  'Prepaid balance': 'Solde prépayé',
  'Current charges': 'Frais actuels',
  'Current cycle': 'Cycle actuel',
  'Next charge': 'Prochain prélèvement',
  'On-demand spend': 'Dépenses à la demande',
  'Seats purchased': 'Sièges achetés',
  'Seats used': 'Sièges utilisés',
  'Team seats': "Sièges d'équipe",
  Seat: 'Siège',
  'Pending invites': 'Invitations en attente',
  'Open invoices': 'Factures ouvertes',
  'Payment status': 'Statut de paiement',
  'Customer since': 'Client depuis',
  Model: 'Modèle',
  Service: 'Service',
  Item: 'Article',
  Product: 'Produit',
  Username: "Nom d'utilisateur",
  Country: 'Pays',
  Address: 'Adresse',
  Location: 'Emplacement',
  Phone: 'Téléphone',
  Identifier: 'Identifiant',
  Key: 'Clé',
  'Last used': 'Dernière utilisation',
  Limit: 'Limite',
  Used: 'Utilisé',
  Unit: 'Unité',
  Period: 'Période',
  Metric: 'Métrique',
  Metrics: 'Métriques',
  Errors: 'Erreurs',
  Cost: 'Coût',
  Attachments: 'Pièces jointes',
  Share: 'Part',
  Utilization: 'Utilisation',
  Stickiness: 'Fidélité',
  Metered: 'Mesuré',
  Size: 'Taille',
  Max: 'Max',
  'Daily active': 'Actifs/jour',
  'Weekly active': 'Actifs/semaine',
  'Monthly active': 'Actifs/mois',
  'Used today': "Utilisé aujourd'hui",
  'Used last month': 'Utilisé le mois dernier',

  // AWS / cloud specifics.
  'Access key ID': "ID de clé d'accès",
  'Secret access key': "Clé d'accès secrète",
  'IAM access keys': "Clés d'accès IAM",
  'Identity Store ID': "ID du magasin d'identités",
  'Identity Center users': 'Utilisateurs Identity Center',
  'Profile name': 'Nom du profil',
  'AWS profile': 'Profil AWS',
  'Tax ID': 'Numéro fiscal',
  'Billing email': 'Courriel de facturation',
  'Billing name': 'Nom de facturation',
  'Account name': 'Nom du compte',
  'Account ID': 'ID du compte',
  'Enterprise slug': "Identifiant d'entreprise",
  'Team slug': "Identifiant d'équipe",

  // View titles.
  'Monthly spend': 'Dépenses mensuelles',
  'Monthly meterings': 'Relevés mensuels',
  'Daily spend': 'Dépenses quotidiennes',
  'Daily credits': 'Crédits quotidiens',
  'Payment method': 'Mode de paiement',
  'This month by cluster': 'Ce mois par grappe',
  'Spend by service': 'Dépenses par service',
  'Spend by model': 'Dépenses par modèle',
  'Spend by linked account': 'Dépenses par compte lié',
  'Top projects (on-demand)': 'Meilleurs projets (à la demande)',
  'Licensed items': 'Éléments sous licence'
}

// fr→en for the common French-canonical vocabulary (banking / health plugins), so they read in English
// under an English app without each shipping its own `messages`. Domain terms (DIN, RAMQ, posologie) stay
// per-plugin. Built by inverting EN_TO_FR plus a few French-first terms those plugins emit.
const FR_TO_EN: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EN_TO_FR).map(([en, fr]) => [fr, en])),
  Sommaire: 'Summary',
  Comptes: 'Accounts',
  Compte: 'Account',
  Solde: 'Balance',
  'Solde précédent': 'Previous balance',
  Factures: 'Invoices',
  Facture: 'Invoice',
  Téléphone: 'Phone',
  Adresse: 'Address',
  Naissance: 'Date of birth',
  Sexe: 'Sex',
  Échéance: 'Due date',
  'Montant dû': 'Amount due',
  'Avoir net': 'Net worth',
  Restante: 'Remaining',
  Statut: 'Status',
  Situation: 'Situation'
}

// Keyed by locale → (canonical-emitted-string → localized). `en`/`fr` only; other locales pass through.
export const globalPluginText: PluginMessages = { en: FR_TO_EN, fr: EN_TO_FR }

// Build a translator for the active locale: plugin `messages` override the global dict; unknown strings pass
// through unchanged (so a service's data + untranslated bespoke labels render verbatim). Pure — unit-tested.
export const makePluginText =
  (locale: Locale, plugin?: PluginMessages) =>
  (text: string): string => {
    const map = { ...(globalPluginText[locale] ?? {}), ...(plugin?.[locale] ?? {}) }

    return map[text] ?? text
  }
