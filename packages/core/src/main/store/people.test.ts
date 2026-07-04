import { validateCapabilityResult } from '@butinapp/sdk/data'
import { describe, expect, test } from 'vitest'

import { buildPeopleResult, mergePeople, type ServiceMembers } from './people.js'

const svc = (
  pluginId: string,
  serviceName: string,
  rows: Record<string, unknown>[],
  asOf?: string
): ServiceMembers => ({
  pluginId,
  serviceName,
  asOf,
  rows
})

describe('mergePeople', () => {
  test('merges rows sharing an email case-insensitively across services', () => {
    const { people, access } = mergePeople([
      svc(
        'sentry',
        'Sentry',
        [{ id: 'u1', name: 'Yann Allard', email: 'Yann@Example.com', role: 'admin' }],
        '2026-07-01T10:00:00Z'
      ),
      svc(
        'grafana',
        'Grafana',
        [{ id: 'g9', name: 'Yann A.', email: 'yann@example.com', role: 'editor' }],
        '2026-07-02T10:00:00Z'
      )
    ])

    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({ personId: 'yann@example.com', email: 'Yann@Example.com', services: 2 })
    expect(access.filter((a) => a.personId === 'yann@example.com')).toHaveLength(2)
    expect(access.find((a) => a.service === 'Sentry')).toMatchObject({ role: 'admin', asOf: '2026-07-01T10:00:00Z' })
  })

  test('rows without an email never merge, even with identical names', () => {
    const { people } = mergePeople([
      svc('sentry', 'Sentry', [{ id: 'a', name: 'John Smith' }]),
      svc('linear', 'Linear', [{ id: 'b', name: 'John Smith' }])
    ])

    expect(people).toHaveLength(2)
    expect(people.map((p) => p.personId).sort()).toEqual(['linear:b', 'sentry:a'])
    expect(people.every((p) => p.services === 1)).toBe(true)
  })

  test('a duplicate email within one service keeps both access rows under one person', () => {
    const { people, access } = mergePeople([
      svc('hubspot', 'HubSpot', [
        { id: 'h1', name: 'Jane Doe', email: 'jane@example.com', role: 'admin' },
        { id: 'h2', name: 'Jane Doe', email: 'jane@example.com', role: 'viewer' }
      ])
    ])

    expect(people).toHaveLength(1)
    expect(people[0].services).toBe(1)
    expect(access).toHaveLength(2)
  })

  test('display name is the most common non-null name; first-seen breaks ties', () => {
    const { people } = mergePeople([
      svc('a', 'A', [{ id: '1', name: 'Franck L.', email: 'f@x.co' }]),
      svc('b', 'B', [{ id: '2', name: 'Franck LeBlanc', email: 'f@x.co' }]),
      svc('c', 'C', [{ id: '3', name: 'Franck LeBlanc', email: 'f@x.co' }]),
      svc('d', 'D', [{ id: '4', email: 'f@x.co' }])
    ])

    expect(people[0].name).toBe('Franck LeBlanc')

    const tied = mergePeople([
      svc('a', 'A', [{ id: '1', name: 'FL', email: 'f@x.co' }]),
      svc('b', 'B', [{ id: '2', name: 'Franck', email: 'f@x.co' }])
    ])

    expect(tied.people[0].name).toBe('FL')
  })

  test('people sort by service count desc, then display label asc; access sorts by service asc', () => {
    const { people, access } = mergePeople([
      svc('a', 'Zeta', [
        { id: '1', name: 'Solo', email: 'solo@x.co' },
        { id: '2', name: 'Both', email: 'both@x.co' }
      ]),
      svc('b', 'Alpha', [{ id: '3', name: 'Both', email: 'both@x.co' }])
    ])

    expect(people.map((p) => p.name)).toEqual(['Both', 'Solo'])
    expect(access.filter((a) => a.personId === 'both@x.co').map((a) => a.service)).toEqual(['Alpha', 'Zeta'])
  })

  test('drops rows that identify nobody (no name and no email)', () => {
    const { people, access } = mergePeople([
      svc('linear', 'Linear', [
        { id: 'x', name: 'Cursor', email: 'afd5064f@oauthapp.linear.app', role: 'app' },
        { id: 'y' },
        { id: 'z', role: 'member' }
      ])
    ])

    expect(people).toHaveLength(1)
    expect(people[0].name).toBe('Cursor')
    expect(access).toHaveLength(1)
  })

  test('empty input yields empty output', () => {
    expect(mergePeople([])).toEqual({ people: [], access: [] })
  })
})

describe('buildPeopleResult', () => {
  test('emits a contract-valid result with the access child wired as row detail on personId', () => {
    const merged = mergePeople([
      svc(
        'sentry',
        'Sentry',
        [{ id: 'u1', name: 'Yann', email: 'yann@example.com', role: 'admin' }],
        '2026-07-01T10:00:00Z'
      )
    ])
    const result = buildPeopleResult(merged)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.map((d) => d.id).sort()).toEqual(['access', 'people'])

    const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'people') as
      | { detail?: { dataset: string; on: string } }
      | undefined

    expect(view?.detail).toEqual({ dataset: 'access', on: 'personId' })
  })
})
