import type { ButinClient, GraphqlRequest, RequestOptions } from '@butinapp/sdk'

// The GraphQL envelope every endpoint answers with. Both halves are optional: a failed query still returns 200,
// and a partial result carries `data` alongside `errors`.
type GraphqlEnvelope<T> = { data?: T; errors?: { message?: string }[] }

// `graphql` for both transports, built on whichever `request` the client already has. It posts the operation the
// way a service's own client does — operation name beside the document — and returns `data` unwrapped, raising on
// any `errors`. Raising is the point: a GraphQL endpoint answers 200 on a failed query, so a caller that reads
// `data` blindly renders an empty tab instead of reporting the failure. The operation name rides in the message
// so a plugin can classify the failure (a service that says "not authorized" rather than answering 401).
export const graphqlOver =
  (request: <T>(opts: RequestOptions) => Promise<{ data: T }>): ButinClient['graphql'] =>
  async <T = unknown>(url: string, op: GraphqlRequest): Promise<T> => {
    const { operationName, query, variables = {}, headers, timeout, cache } = op
    const label = operationName ?? 'graphql'
    const res = await request<GraphqlEnvelope<T>>({
      url,
      method: 'POST',
      body: { operationName, variables, query },
      headers,
      timeout,
      cache
    })

    if (res.data.errors?.length) {
      throw new Error(`${label} failed: ${res.data.errors.map((e) => e.message ?? 'error').join('; ')}`)
    }

    if (!res.data.data) {
      throw new Error(`${label} returned no data`)
    }

    return res.data.data
  }
