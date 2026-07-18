// Synthetic sample GENERATORS for the demo seed — each builds the raw a capability's `fetch` returns, purely
// from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build`
// the live collector uses. The `documents` knob scales invoice/key counts.
//
// The raws come in the two shapes the console serves (see main.ts): for the gRPC-Web capabilities the raw is a
// DECODED protobuf map, so these generators encode the wire bytes via the public encoder and decode them back —
// exercising the real decode path, with every field number mirroring the console's layout. For `apiKeys` the
// raw is the page's flight JSON, so its generator is plain objects.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { MS_PER_DAY } from '@butinapp/sdk/util'

import { decodeMessage, message, messageField, packedDoublesField, stringField, varintField } from './codec.js'
import type { RawXaiBilling, RawXaiKeys, RawXaiMembers, RawXaiUsage } from './main.js'

// A team UUID is the URL segment the build half stitches into invoice detail links — synthesize a UUID-shaped
// id from the seed (the hex digits are deterministic, never a real id).
const teamUuid = (g: SampleGen): string => {
  const hex = (n: number): string => Array.from({ length: n }, () => g.int(0, 15).toString(16)).join('')

  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}

// A billing line item: #1 region · #2 model · #3 usageType · #4 unit price · #5 quantity · #6 cost (CENTS) · #7 source.
const lineItem = (g: SampleGen, model: string, usageType: string, qty: number, cents: number): Buffer =>
  message(
    stringField(1, g.pick(['us-east-1', 'us-west-2', 'eu-west-1'])),
    stringField(2, model),
    stringField(3, usageType),
    varintField(4, 25_000),
    varintField(5, qty),
    varintField(6, cents),
    stringField(7, 'api')
  )

// An invoice: #20 id · #21 number · #31 {#1 seconds} issue ts · #40 status · #70 repeated line items · #110 pdf
// path · #120 {#10 {#1 year, #2 month}} billing period.
const invoice = (
  g: SampleGen,
  teamId: string,
  number: string,
  issueSeconds: number,
  status: number,
  period: { year: number; month: number },
  cents: number[]
): Buffer =>
  message(
    stringField(20, `${number}=`),
    stringField(21, number),
    messageField(31, message(varintField(1, issueSeconds))),
    varintField(40, status),
    ...cents.map((c, i) =>
      messageField(
        70,
        lineItem(g, 'Chat grok-4.3', i === 0 ? 'Completion text tokens' : 'Prompt text tokens', 100_000 + i * 9000, c)
      )
    ),
    stringField(110, `teams/${teamId}/billing/${period.year}-${period.month}-${number}.pdf`),
    messageField(120, messageField(10, message(varintField(1, period.year), varintField(2, period.month))))
  )

// A 4-char-group invoice number (the console's XXXX-XXXX-XXXX layout) from the seed.
const invoiceNumber = (g: SampleGen): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'
  const group = (): string => Array.from({ length: 4 }, () => g.pick([...chars])).join('')

  return `${group()}-${group()}-${group()}`
}

export const sampleXaiBilling = (g: SampleGen, config: SampleConfig): RawXaiBilling => {
  const teamId = teamUuid(g)
  const n = Math.min(config.documents, 36)

  // The newest month is open (status 1), the rest finalized (status 2).
  const invoicesBody = message(
    ...g.repeat(n, (i) => {
      const month = g.monthsAgo(i)
      const monthDate = new Date(month.startEpochMs)

      return messageField(
        1,
        invoice(
          g,
          teamId,
          invoiceNumber(g),
          month.startEpochSec,
          i === 0 ? 1 : 2,
          { year: monthDate.getUTCFullYear(), month: monthDate.getUTCMonth() + 1 },
          [g.amountCents(3_000, 10_000), g.amountCents(1_000, 3_500)]
        )
      )
    })
  )

  // GetAmountToPay: the current unbilled period's line items, wrapped in an outer #1 message.
  const amountToPayBody = messageField(
    1,
    message(
      messageField(
        1,
        lineItem(g, 'Chat grok-4.3', 'Completion text tokens', g.int(800_000, 1_400_000), g.amountCents(1_800, 3_000))
      ),
      messageField(
        1,
        lineItem(g, 'Chat grok-4.3', 'Reasoning text tokens', g.int(150_000, 320_000), g.amountCents(1_200, 2_200))
      ),
      messageField(
        1,
        lineItem(g, 'Chat grok-3', 'Prompt text tokens', g.int(500_000, 1_000_000), g.amountCents(400, 900))
      )
    )
  )

  // GetSpendingLimits: `{ #1: { #2: { #1: cents }, #4: {}, #5: { #1: cents } } }` — #2 and #5 read equal.
  const limitCents = g.amountCents(30_000, 80_000)
  const spendingLimitsBody = messageField(
    1,
    message(messageField(2, message(varintField(1, limitCents))), messageField(5, message(varintField(1, limitCents))))
  )

  // GetBillingInfo: `{ #10: { #20: name, #30: email } }`.
  const contact = g.person(0)
  const billingInfoBody = messageField(
    10,
    message(stringField(20, `${contact.firstName} ${contact.lastName}`), stringField(30, contact.email))
  )

  return {
    invoices: decodeMessage(invoicesBody),
    amountToPay: decodeMessage(amountToPayBody),
    spendingLimits: decodeMessage(spendingLimitsBody),
    billingInfo: decodeMessage(billingInfoBody),
    teamId
  }
}

// AnalyzeBillingItems: `{ #1: { #2: repeated { #1: {#1 seconds}, #2: packed doubles } } }`. The packed doubles
// are positional per the metrics requested — cost (DOLLARS, not cents), requests, units. An intrinsic daily
// series renders from one snapshot, so it needs a full window of points to read as real.
export const sampleXaiUsage = (g: SampleGen, config: SampleConfig): RawXaiUsage => {
  const days = Math.max(config.days, 30)
  // The buckets are contiguous and oldest-first — one per day across the window, counted back from the seed's
  // reference midnight (`day(0)` is the reference itself, so the run stays deterministic).
  const midnight = g.day(0).epochMs
  const buckets = g.repeat(days, (i) => {
    const requests = g.int(40, 900)

    return messageField(
      2,
      message(
        messageField(1, message(varintField(1, Math.floor((midnight - (days - 1 - i) * MS_PER_DAY) / 1000)))),
        packedDoublesField(2, [g.amountCents(5, 900) / 100, requests, requests * g.int(600, 2_400)])
      )
    )
  })

  return { usage: decodeMessage(messageField(1, message(...buckets))) }
}

// ListSubscriptionAssignments: `{ #1: repeated { #1: PublicUser } }`, one response per seat product. The same
// person holds a seat in both, so the build half's union-by-user-id is exercised.
export const sampleXaiMembers = (g: SampleGen, config: SampleConfig): RawXaiMembers => {
  const roster = (count: number): ReturnType<typeof decodeMessage> =>
    decodeMessage(
      message(
        ...g.repeat(count, (i) => {
          const person = g.person(i)

          return messageField(
            1,
            messageField(
              1,
              message(
                stringField(1, person.id),
                stringField(3, person.email),
                stringField(5, person.firstName),
                stringField(6, person.lastName)
              )
            )
          )
        })
      )
    )

  return { assignments: [roster(config.users), roster(Math.max(1, Math.floor(config.users / 2)))] }
}

// The API keys as the team page's RSC flight carries them: plain JSON keyed by field name, with each int64 as
// a `$n`-prefixed BigInt token. The creator is a bare `userId`, so the roster the build half joins against is
// drawn from the SAME shared cast — a key resolves to a real name in the demo.
export const sampleXaiKeys = (g: SampleGen, config: SampleConfig): RawXaiKeys => {
  const people = g.people(config.users)

  return {
    keys: g.repeat(Math.min(config.documents, 36), (i) => {
      const person = people[i % people.length]!

      return {
        redactedApiKey: `xai-${g.maskedKey()}`,
        name: g.pick(['Production', 'Staging', 'CI', 'Development']),
        userId: person.id,
        apiKeyId: g.id('key'),
        disabled: g.bool(0.15),
        aclStrings: g.pick([
          ['api-key:endpoint:*', 'api-key:model:*'],
          ['api-key:model:*'],
          ['api-key:model:grok-4.3']
        ]),
        createTime: { seconds: `$n${g.monthsAgo(i).startEpochSec}` }
      }
    }),
    members: people.map((p) => ({ id: p.id, name: p.name, email: p.email }))
  }
}
