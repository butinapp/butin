import type { PluginCategory } from '@butinapp/sdk'
import { groupBy } from 'lodash-es'

// Fixed display order for management's category sections. 'other' is last and absorbs missing/unknown.
export const CATEGORY_ORDER: PluginCategory[] = [
  'finance',
  'cloud',
  'ai',
  'devtools',
  'productivity',
  'rental',
  'utilities',
  'other'
]

const KNOWN = new Set<string>(CATEGORY_ORDER)

const bucketOf = (category?: string): PluginCategory =>
  category && KNOWN.has(category) ? (category as PluginCategory) : 'other'

// Group rows by category into CATEGORY_ORDER, omitting empty categories and preserving each row's
// incoming order within its bucket. Generic over anything carrying an optional `category` string.
export const groupByCategory = <T extends { category?: string }>(rows: T[]): [PluginCategory, T[]][] => {
  const buckets = groupBy(rows, (row) => bucketOf(row.category))

  return CATEGORY_ORDER.filter((c) => buckets[c]?.length).map((c) => [c, buckets[c]!])
}
