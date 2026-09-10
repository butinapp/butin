import { capabilityResult, table } from '../data/builders.js'
import type { CapabilityResult } from '../data/result.js'

// One person in the user-management domain.
export type MemberInput = {
  id: string
  name?: string
  email?: string
  role?: string
}

export type MembersInput = {
  members: MemberInput[]
}

// id rides along as a row field (not a column) so members accumulate stably even when name/email change.
type MemberRow = {
  id: string
  name: string | null
  email: string | null
  role: string | null
}

// The members preset: who has access. One table (name / email / role). No summary.
export const membersResult = (input: MembersInput): CapabilityResult => {
  const members = table<MemberRow>({
    id: 'members',
    columns: [
      { key: 'name', role: 'label', label: 'Name' },
      { key: 'email', role: 'identifier', label: 'Email' },
      { key: 'role', role: 'category', label: 'Role' }
    ],
    rows: input.members.map((m) => ({ id: m.id, name: m.name ?? null, email: m.email ?? null, role: m.role ?? null })),
    key: 'id',
    // A roster is the COMPLETE set of who has access: someone the service stops returning has lost it, and must
    // stop counting as active rather than lingering as the last role they held.
    retention: 'snapshot'
  })

  return capabilityResult({ sections: [members.table({ title: 'Members' })] })
}
