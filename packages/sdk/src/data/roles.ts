import type { SemanticRole } from './dataset.js'

// What each semantic role's underlying value must be. The whole compile-time guarantee rides on this map:
// you cannot tag a string field 'money', or a number field 'label'. Null is allowed everywhere because
// services routinely omit a figure (no plan, no usage, undated invoice).
type RoleValueMap = {
  money: number | null
  count: number | null
  percent: number | null
  timestamp: string | null
  status: string | null
  category: string | null
  label: string | null
  identifier: string | null
  url: string | null
  text: string | null
}

// Drift guard: RoleValueMap must cover exactly the SemanticRole union. If a role is added to the schema
// without a value type here (or vice-versa), this stops compiling.
type RolesCovered = SemanticRole extends keyof RoleValueMap
  ? keyof RoleValueMap extends SemanticRole
    ? true
    : never
  : never
const _rolesCovered: RolesCovered = true

void _rolesCovered

// The roles a value of type V may carry. `V | null` (not a naked V) keeps the conditional non-distributive:
// a naked V would distribute over a nullable union and null — a subtype of every map entry — would match
// every role, so a string|null field could be tagged 'money'. The whole-union check rejects that; `| null`
// never widens legitimate matches since every RoleValueMap entry already allows null.
export type RolesFor<V> = { [R in SemanticRole]: V | null extends RoleValueMap[R] ? R : never }[SemanticRole]
