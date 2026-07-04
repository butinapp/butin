// @butinapp/sdk/integrations — shared mechanics for third-party providers that more than one service proxies
// to. Not part of the universal plugin contract (a plugin that doesn't touch the provider never sees these),
// so they live off the root barrel. Today: Stripe's hosted billing-portal walk + hosted-invoice PDF download.

export * from './stripe.js'
