import type { RequestOptions } from '@butinapp/sdk'
import { expect, test, vi } from 'vitest'

import { graphqlOver } from './graphql.js'

const answering = (envelope: unknown) => vi.fn(async () => ({ data: envelope }))

test('posts the operation the way a service client does and returns the payload unwrapped', async () => {
  const request = answering({ data: { viewer: { id: '1' } } })
  const graphql = graphqlOver(request as unknown as <T>(o: RequestOptions) => Promise<{ data: T }>)

  await expect(
    graphql('https://api.test/graphql', {
      operationName: 'Viewer',
      query: 'query Viewer { viewer { id } }',
      variables: { first: 1 },
      headers: { 'x-client': 'panel' }
    })
  ).resolves.toEqual({ viewer: { id: '1' } })

  expect(request).toHaveBeenCalledWith({
    url: 'https://api.test/graphql',
    method: 'POST',
    body: { operationName: 'Viewer', variables: { first: 1 }, query: 'query Viewer { viewer { id } }' },
    headers: { 'x-client': 'panel' },
    timeout: undefined,
    cache: undefined
  })
})

test('raises on a GraphQL error, naming the operation — a failed query still answers 200', async () => {
  const graphql = graphqlOver(
    answering({ errors: [{ message: 'not authorized' }, {}] }) as unknown as <T>(
      o: RequestOptions
    ) => Promise<{ data: T }>
  )

  await expect(graphql('https://api.test/graphql', { operationName: 'Viewer', query: 'q' })).rejects.toThrow(
    'Viewer failed: not authorized; error'
  )
})

test('raises when the envelope carries no data, falling back to a generic label', async () => {
  const graphql = graphqlOver(answering({}) as unknown as <T>(o: RequestOptions) => Promise<{ data: T }>)

  await expect(graphql('https://api.test/graphql', { query: 'q' })).rejects.toThrow('graphql returned no data')
})
