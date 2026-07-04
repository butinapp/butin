import { upperFirst, words } from '../libs.js'

// Title-case a machine value for display, lowercasing each word's tail so SCREAMING_SNAKE and acronyms read as
// Title Case (`team_tier_1` → 'Team Tier 1', `monthlyCredit` → 'Monthly Credit', `UNCOLLECTIBLE` → 'Uncollectible').
// Built on lodash word-splitting (camelCase + snake/kebab/space boundaries); empty/whitespace → ''.
export const startCase = (value: string): string =>
  words(value)
    .map((w) => upperFirst(w.toLowerCase()))
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
