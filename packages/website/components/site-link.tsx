import NextLink from 'next/link'
import type { ComponentProps } from 'react'

// `next/link` with prefetching off. Import this instead of `next/link` anywhere in this site.
//
// Next 16 prefetches a per-SEGMENT payload (`/__next.<segment>/…`) rather than one payload per route, and
// `output: 'export'` only writes that tree UNDER each already-resolved page — nothing equivalent at the root. So
// hovering a nav link from `/`, `/services` or `/tour` fetched `/__next.docs/$oc$slug.txt`, took a 307 to the
// percent-encoded form, and 404'd. Navigation still worked (Next falls back to a document load), so the only cost
// was a noisy console and two wasted round-trips per hover — but it was every hover, on every page.
//
// `experimental.clientSegmentCache: false` would be the targeted fix; it was REMOVED in 16.2.9 and is now rejected
// as an unrecognized key. So prefetching goes off instead, which costs approximately nothing here: every page is a
// static HTML file a few KB in size, served from Cloudflare's edge.
//
// Props spread last, so an individual link can still opt back in with `prefetch`.
export function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={false} {...props} />
}
