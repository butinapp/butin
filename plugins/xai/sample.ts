// Synthetic sample GENERATORS for the demo seed — each builds the raw a capability's `fetch` returns, purely
// from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build`
// the live collector uses. xAI serves protobuf over gRPC-web, so the raw is the DECODED message map: these
// generators synthesize the wire shape via the public encoder (the real decode path), then decode it — all
// field numbers mirror the layout the console serves. The `documents` knob scales invoice/key counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import { decodeMessage, message, messageField, stringField, varintField } from './codec.js'
import type { RawXaiBilling, RawXaiKeys } from './main.js'

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

// An invoice: #20 id · #21 number · #31 {#1 seconds} issue ts · #40 status · #70 repeated line items · #110 pdf path.
const invoice = (
  g: SampleGen,
  teamId: string,
  number: string,
  periodSeconds: number,
  status: number,
  pdfMonth: string,
  cents: number[]
): Buffer =>
  message(
    stringField(20, `${number}=`),
    stringField(21, number),
    messageField(31, message(varintField(1, periodSeconds))),
    varintField(40, status),
    ...cents.map((c, i) =>
      messageField(
        70,
        lineItem(g, 'Chat grok-4.3', i === 0 ? 'Completion text tokens' : 'Prompt text tokens', 100_000 + i * 9000, c)
      )
    ),
    stringField(110, `teams/${teamId}/billing/${pdfMonth}-${number}.pdf`)
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
      const seconds = month.startEpochSec
      const monthDate = new Date(month.startEpochMs)
      const pdfMonth = `${monthDate.getUTCFullYear()}-${monthDate.getUTCMonth() + 1}`

      return messageField(
        1,
        invoice(g, teamId, invoiceNumber(g), seconds, i === 0 ? 1 : 2, pdfMonth, [
          g.amountCents(3_000, 10_000),
          g.amountCents(1_000, 3_500)
        ])
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

  // GetSpendingLimits: `{ #1: { #2: { #1: cents }, #5: { #1: cents } } }`.
  const limitCents = g.amountCents(30_000, 80_000)
  const spendingLimitsBody = messageField(
    1,
    message(messageField(2, message(varintField(1, limitCents))), messageField(5, message(varintField(1, limitCents))))
  )

  return {
    invoices: decodeMessage(invoicesBody),
    amountToPay: decodeMessage(amountToPayBody),
    spendingLimits: decodeMessage(spendingLimitsBody),
    teamId
  }
}

// An API key: #1 masked hint · #4 name · #5 {#1 seconds} created · #8 id · #10 creator {#3 email, #5 first, #6 last}
//             · #16 repeated ACL strings.
const apiKey = (
  g: SampleGen,
  hint: string,
  name: string,
  createdSeconds: number,
  id: string,
  email: string,
  first: string,
  last: string,
  acls: string[]
): Buffer =>
  message(
    stringField(1, hint),
    stringField(4, name),
    messageField(5, message(varintField(1, createdSeconds))),
    stringField(8, id),
    messageField(10, message(stringField(3, email), stringField(5, first), stringField(6, last))),
    ...acls.map((a) => stringField(16, a))
  )

export const sampleXaiKeys = (g: SampleGen, config: SampleConfig): RawXaiKeys => {
  const keysBody = message(
    ...g.repeat(Math.min(config.documents, 36), (i) => {
      const person = g.person(i)

      return messageField(
        1,
        apiKey(
          g,
          `xai-${g.maskedKey()}`,
          g.pick(['Production', 'Staging', 'CI', 'Development']),
          g.monthsAgo(i).startEpochSec,
          g.id('key'),
          person.email,
          person.firstName,
          person.lastName,
          g.pick([['api-key:endpoint:*', 'api-key:model:*'], ['api-key:model:*'], ['api-key:model:grok-4.3']])
        )
      )
    })
  )

  return { keys: decodeMessage(keysBody) }
}
