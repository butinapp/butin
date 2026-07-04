// Safe host extraction — returns an empty string for malformed or relative URLs rather than throwing.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// Common two-label public suffixes, so `example.co.uk` collapses to `example.co.uk`, not `co.uk`. A capture
// heuristic doesn't warrant the full public-suffix list — the long tail only risks a borderline mis-bucket.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'com.au',
  'com.br',
  'co.nz',
  'co.in',
  'com.cn',
  'co.za',
  'com.mx',
  'co.kr',
  'com.sg',
  'com.hk',
  'com.tr'
])

// The registrable domain (eTLD+1) of a host — every subdomain collapsed so one service is one surface:
// `unagi.amazon.ca` → `amazon.ca`, `us.app.foo.co.uk` → `foo.co.uk`. Empty/unparseable host → ''.
export const registrableDomain = (host: string): string => {
  const labels = host.toLowerCase().split('.').filter(Boolean)

  if (labels.length <= 2) {
    return labels.join('.')
  }

  const lastTwo = labels.slice(-2).join('.')

  return labels.slice(TWO_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.')
}
