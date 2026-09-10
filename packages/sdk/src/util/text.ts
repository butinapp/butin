import { upperFirst, words } from '../libs.js'

// Title-case a machine value for display, lowercasing each word's tail so SCREAMING_SNAKE and acronyms read as
// Title Case (`team_tier_1` → 'Team Tier 1', `monthlyCredit` → 'Monthly Credit', `UNCOLLECTIBLE` → 'Uncollectible').
// Built on lodash word-splitting (camelCase + snake/kebab/space boundaries); empty/whitespace → ''.
export const startCase = (value: string): string =>
  words(value)
    .map((w) => upperFirst(w.toLowerCase()))
    .join(' ')

// Collapse every run of whitespace to one space and trim — the normalizer an HTML scrape needs on any text it
// pulls out of a cell, where markup indentation and newlines ride along with the value.
export const squish = (value?: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim()

// A person's display name from its parts, skipping the ones the service didn't send. Empty when it sent neither
// — a caller that wants `null` for "no name" writes `fullName(a, b) || null`.
export const fullName = (first?: string | null, last?: string | null): string =>
  [first, last]
    .map((p) => squish(p))
    .filter(Boolean)
    .join(' ')

// Pull the first signed decimal out of a formatted currency string (`$1,204.55` → 1204.55, `—` → 0). Commas
// are stripped before matching. Empty/missing/unparseable → 0.
export const parseDollarAmount = (formatted?: string): number => {
  if (!formatted) {
    return 0
  }

  const match = formatted.replace(/,/g, '').match(/-?\d+(\.\d+)?/)

  return match ? parseFloat(match[0]) : 0
}
