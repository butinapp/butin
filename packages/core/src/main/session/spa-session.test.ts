import { beforeEach, describe, expect, it } from 'vitest'

import { clearSpaBearer, getCachedBearer, looksLikeLoginRedirect, setCachedBearer } from './spa-session.js'

describe('spa-session bearer cache', () => {
  beforeEach(() => {
    clearSpaBearer('carnet-sante')
    clearSpaBearer('other')
  })

  it('returns undefined before anything is cached', () => {
    expect(getCachedBearer('carnet-sante')).toBeUndefined()
  })

  it('caches and reads back per plugin', () => {
    setCachedBearer('carnet-sante', 'Bearer abc')
    setCachedBearer('other', 'Bearer xyz')

    expect(getCachedBearer('carnet-sante')).toBe('Bearer abc')
    expect(getCachedBearer('other')).toBe('Bearer xyz')
  })

  it('clear drops only that plugin', () => {
    setCachedBearer('carnet-sante', 'Bearer abc')
    setCachedBearer('other', 'Bearer xyz')
    clearSpaBearer('carnet-sante')

    expect(getCachedBearer('carnet-sante')).toBeUndefined()
    expect(getCachedBearer('other')).toBe('Bearer xyz')
  })
})

describe('looksLikeLoginRedirect', () => {
  const boot = 'https://supabase.com/dashboard'

  it('ignores the initial load of the boot URL (loginUrl === bootUrl)', () => {
    expect(looksLikeLoginRedirect(boot, boot)).toBe(false)
    expect(looksLikeLoginRedirect('https://supabase.com/dashboard/project/abc', boot)).toBe(false)
  })

  it('flags a redirect to a different origin (the identity provider)', () => {
    expect(looksLikeLoginRedirect('https://login.clickhouse.cloud/', 'https://console.clickhouse.cloud/')).toBe(true)
    expect(looksLikeLoginRedirect('https://auth0.example.com/authorize', boot)).toBe(true)
  })

  it('flags a same-origin sign-in route', () => {
    expect(looksLikeLoginRedirect('https://supabase.com/dashboard/sign-in', boot)).toBe(true)
    expect(looksLikeLoginRedirect('https://supabase.com/login', boot)).toBe(true)
    expect(looksLikeLoginRedirect('https://supabase.com/auth/callback', boot)).toBe(true)
  })

  it('does not flag a same-origin app path that merely contains the substring', () => {
    expect(looksLikeLoginRedirect('https://supabase.com/dashboard/authors', boot)).toBe(false)
    expect(looksLikeLoginRedirect('https://supabase.com/dashboard/signing-keys', boot)).toBe(false)
  })

  it('does not flag an apex↔www canonicalization on the same site', () => {
    expect(looksLikeLoginRedirect('https://www.carnetsante.gouv.qc.ca/accueil', 'https://carnetsante.gouv.qc.ca')).toBe(
      false
    )
    expect(looksLikeLoginRedirect('https://supabase.com/dashboard', 'https://www.supabase.com/dashboard')).toBe(false)
  })

  it('returns false on an unparseable URL', () => {
    expect(looksLikeLoginRedirect('not a url', boot)).toBe(false)
  })
})
