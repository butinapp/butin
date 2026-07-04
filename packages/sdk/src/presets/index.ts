// @butinapp/sdk/presets — the high-altitude result builders, grouped by domain so a dotted prefix says the
// tier: `billing.summary(...)` / `billing.result(...)`, `usage.result(...)`, `keys.result(...)`,
// `members.result(...)`. `blocks.*` are the reusable sub-panels a result composes. Badge coloring is the
// renderer's job — a status column auto-tones, a category column auto-colors — so there's no tone palette
// here. The pure raw→CapabilityResult normalizers underneath stay fixture-tested in their own modules.

import { apiKeysResult } from './apikeys.js'
import { billingResult, billingSummaryResult, monthlySpend } from './billing.js'
import { creditsRecord, dailySeries, overageOf, paymentMethodRecord, subscriptionRecord } from './blocks.js'
import { membersResult } from './members.js'
import { usageResult } from './usage.js'

export const billing = { result: billingResult, summary: billingSummaryResult, monthlySpend }
export const usage = { result: usageResult }
export const keys = { result: apiKeysResult }
export const members = { result: membersResult }
export const blocks = {
  credits: creditsRecord,
  paymentMethod: paymentMethodRecord,
  subscription: subscriptionRecord,
  daily: dailySeries,
  overageOf
}

// Object namespaces can't carry types — the input/output shapes a plugin annotates against stay flat.
export type { BillingInput, BillingInvoiceInput, BillingStat, BillingSummaryInput } from './billing.js'
export type { UsageInput, UsageMetricInput } from './usage.js'
export type { ApiKeyInput, ApiKeysInput } from './apikeys.js'
export type { MemberInput, MembersInput } from './members.js'
export type { CreditsInput, PaymentMethodInput, SubscriptionInput, TrendPoint } from './blocks.js'
export type { MtdBasis } from './mtd-basis.js'
export { MtdBasisSchema, MTD_BASIS_LABELS } from './mtd-basis.js'
