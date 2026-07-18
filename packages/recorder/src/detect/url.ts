import { getDomain } from 'tldts'

// Safe host extraction — returns an empty string for malformed or relative URLs rather than throwing.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// The registrable domain (eTLD+1) of a host — every subdomain collapsed so one service is one surface:
// `unagi.amazon.ca` → `amazon.ca`, `us.app.foo.co.uk` → `foo.co.uk`. The eTLD is resolved against the full
// Public Suffix List (tldts), so multi-label suffixes across the whole long tail collapse correctly —
// `services.hydro.qc.ca` → `hydro.qc.ca`, not the `qc.ca` suffix itself. Empty/unparseable host → ''.
export const registrableDomain = (host: string): string => getDomain(host.toLowerCase()) ?? ''
