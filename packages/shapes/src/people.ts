import { type CapabilityResult, capabilityResult, table, type TableDataset } from '@butinapp/sdk/data'

// Cross-service People rollup: merge every service's member roster into one access audit — who has access to
// what, under which role. Pure (no IO), so both core (over its cached reports) and the embed viewer (over a
// published snapshot) build the same result from the same data.

// One service's contribution to the People rollup: the rows of its cached `members` dataset plus when that
// report was fetched.
export type ServiceMembers = {
  pluginId: string
  serviceName: string
  asOf?: string
  rows: Record<string, unknown>[]
}

export type PersonRow = { personId: string; name: string | null; email: string | null; services: number }
export type AccessRow = { personId: string; service: string; role: string | null; asOf: string | null }
export type MergedPeople = { people: PersonRow[]; access: AccessRow[] }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// The most common non-null name a person appears under; first-seen wins a tie so the pick is stable.
const majorityName = (names: string[]): string | null => {
  let best: string | null = null
  let bestCount = 0
  const counts = new Map<string, number>()

  for (const name of names) {
    const count = (counts.get(name) ?? 0) + 1

    counts.set(name, count)

    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }

  return best
}

// Merge every service's member roster into people. Rows sharing a case-insensitive email are one person;
// a row without an email stays its own entry (keyed by service + row id) so name-only rows never falsely
// merge. Access rows carry the raw per-service role plus the report's fetch time.
export const mergePeople = (inputs: ServiceMembers[]): MergedPeople => {
  type Acc = { personId: string; email: string | null; names: string[]; pluginIds: Set<string>; access: AccessRow[] }

  const byId = new Map<string, Acc>()

  for (const svc of inputs) {
    svc.rows.forEach((row, index) => {
      const email = str(row.email)
      const name = str(row.name)

      // A row with neither a name nor an email identifies nobody (a service/placeholder account some rosters
      // carry) — drop it rather than showing a blank "— / —" person in the audit.
      if (!email && !name) {
        return
      }

      const rowId = str(row.id) ?? String(index)
      const personId = email ? email.trim().toLowerCase() : `${svc.pluginId}:${rowId}`
      let acc = byId.get(personId)

      if (!acc) {
        acc = { personId, email, names: [], pluginIds: new Set(), access: [] }
        byId.set(personId, acc)
      }

      if (name) {
        acc.names.push(name)
      }

      acc.pluginIds.add(svc.pluginId)
      acc.access.push({ personId, service: svc.serviceName, role: str(row.role), asOf: svc.asOf ?? null })
    })
  }

  const accs = [...byId.values()]
  const people = accs.map((a) => ({
    personId: a.personId,
    name: majorityName(a.names),
    email: a.email,
    services: a.pluginIds.size
  }))
  const label = (p: PersonRow): string => p.name ?? p.email ?? p.personId

  people.sort((x, y) => y.services - x.services || label(x).localeCompare(label(y)))

  const access = accs.flatMap((a) => a.access)

  access.sort((x, y) => x.service.localeCompare(y.service))

  return { people, access }
}

// The standard roster the members.result preset emits: a table with id 'members' that declares an email
// column. The email-column requirement excludes members-shaped usage breakdowns that reuse the id with
// different fields (per-member spend tables carry no email).
export const membersDataset = (result: CapabilityResult | null): TableDataset | null =>
  result?.datasets.find(
    (d): d is TableDataset => d.shape === 'table' && d.id === 'members' && d.columns.some((c) => c.key === 'email')
  ) ?? null

// One capability's cached result, tagged with its id + fetch time. The `members` capability is the roster of
// record; among the rest, the first result carrying a members dataset wins.
export type ServiceCapResult = { id: string; result: CapabilityResult | null; asOf?: string }

// Pick a service's roster from its capability results: prefer the `members` capability, else the first result
// carrying a members dataset. Returns null when the service reports no roster. The winning capability's fetch
// time becomes the contribution's `asOf`.
export const serviceMembersFrom = (source: {
  pluginId: string
  serviceName: string
  caps: ServiceCapResult[]
}): ServiceMembers | null => {
  const ordered = [...source.caps].sort((a, b) => Number(b.id === 'members') - Number(a.id === 'members'))

  for (const cap of ordered) {
    const ds = membersDataset(cap.result)

    if (ds) {
      return { pluginId: source.pluginId, serviceName: source.serviceName, asOf: cap.asOf, rows: ds.rows }
    }
  }

  return null
}

// Shape the merged rollup into the one renderable result the People page draws: a people table whose rows
// expand into that person's per-service access, joined on the hidden personId.
export const buildPeopleResult = (merged: MergedPeople): CapabilityResult => {
  const people = table<PersonRow>({
    id: 'people',
    columns: [
      { key: 'name', role: 'label', label: 'Name' },
      { key: 'email', role: 'identifier', label: 'Email' },
      { key: 'services', role: 'count', label: 'Services' },
      { key: 'personId', role: 'identifier', hidden: true }
    ],
    rows: merged.people,
    key: 'personId'
  })

  const access = table<AccessRow>({
    id: 'access',
    columns: [
      { key: 'service', role: 'label', label: 'Service' },
      { key: 'role', role: 'category', label: 'Role' },
      { key: 'asOf', role: 'timestamp', label: 'As of' },
      { key: 'personId', role: 'identifier', hidden: true }
    ],
    rows: merged.access
  })

  return capabilityResult({ sections: [people.table({ title: 'People', detail: { rows: access, on: 'personId' } })] })
}

// Assemble the People payload from every service's roster contributions: merge, shape, and count. Returns null
// when no service reports a roster.
export const buildPeopleData = (
  inputs: ServiceMembers[]
): { result: CapabilityResult; people: number; services: number } | null => {
  if (inputs.length === 0) {
    return null
  }

  const merged = mergePeople(inputs)

  return { result: buildPeopleResult(merged), people: merged.people.length, services: inputs.length }
}
