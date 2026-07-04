import { describe, expect, it } from 'vitest'

import { extractStripePortalTokens, stripePdfFileUrlEndpoint } from './stripe.js'

describe('extractStripePortalTokens', () => {
  it('scrapes bps/ek/account by their stable prefixes out of the portal page markup', () => {
    const html =
      '<script>window.__stripe={"session":"bps_1ABCdef","key":"ek_live_51XyZ_secret","account":"acct_1Q2W3E"}</script>'

    expect(extractStripePortalTokens(html)).toEqual({
      bps: 'bps_1ABCdef',
      ek: 'ek_live_51XyZ_secret',
      account: 'acct_1Q2W3E'
    })
  })

  it('throws when any token is missing (expired session / changed page)', () => {
    expect(() => extractStripePortalTokens('<html>no tokens here</html>')).toThrow(/billing-portal session/)
    expect(() => extractStripePortalTokens('ek_live_only acct_1Q2W3E')).toThrow(/billing-portal session/)
  })
})

describe('stripePdfFileUrlEndpoint', () => {
  it('derives the invoicedata file-url endpoint from a hosted invoice URL', () => {
    expect(stripePdfFileUrlEndpoint('https://invoice.stripe.com/i/acct_1J1/live_YWNjd?s=ap')).toBe(
      'https://invoicedata.stripe.com/invoice_pdf_file_url/acct_1J1/live_YWNjd'
    )
  })

  it('returns null for a missing or non-Stripe URL', () => {
    expect(stripePdfFileUrlEndpoint(undefined)).toBeNull()
    expect(stripePdfFileUrlEndpoint(null)).toBeNull()
    expect(stripePdfFileUrlEndpoint('https://example.com/not-stripe')).toBeNull()
  })
})
