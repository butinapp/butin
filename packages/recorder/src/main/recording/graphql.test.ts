import { describe, expect, it } from 'vitest'

import { extractGraphqlOperation } from './graphql.js'

describe('extractGraphqlOperation', () => {
  it('reads an explicit operationName', () => {
    expect(extractGraphqlOperation('{"operationName":"GetUser","query":"query GetUser { me }"}')).toBe('GetUser')
  })

  it('parses the name from the query when operationName is absent', () => {
    expect(extractGraphqlOperation('{"query":"mutation AddMember($id: ID!) { add(id:$id) }"}')).toBe('AddMember')
  })

  it('joins batched operations', () => {
    expect(
      extractGraphqlOperation('[{"operationName":"A","query":"query A{x}"},{"operationName":"B","query":"query B{y}"}]')
    ).toBe('A+B')
  })

  it('returns undefined for non-GraphQL JSON', () => {
    expect(extractGraphqlOperation('{"name":"alice","email":"a@b.c"}')).toBeUndefined()
  })

  it('returns undefined for null / non-JSON / oversized bodies', () => {
    expect(extractGraphqlOperation(null)).toBeUndefined()
    expect(extractGraphqlOperation('not json "query"')).toBeUndefined()
    expect(extractGraphqlOperation(`{"query":"${'x'.repeat(100_001)}"}`)).toBeUndefined()
  })
})
