import { registrableDomain } from '../../detect/url.js'

const titleCase = (s: string): string =>
  s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

// Derive a plugin identity from a recorded surface. The brand is the registrable domain's first label —
// `unagi.amazon.ca` → amazon, `us.app.unleash-hosted.com` → unleash-hosted, serper.dev → serper. A surface
// already collapsed to its registrable domain (or a bare merge alias) feeds through unchanged. Non-alphanumerics
// collapse so the id is always valid kebab-case.
export const suggestIdentity = (surface: string): { id: string; name: string; vendor: string } => {
  const brand = registrableDomain(surface).split('.')[0] || surface.toLowerCase()
  const id = brand.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'service'
  const name = titleCase(id)

  return { id, name, vendor: name }
}
