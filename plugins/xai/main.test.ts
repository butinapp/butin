import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  buildBillingReport,
  buildKeysReport,
  buildXaiBillingResult,
  buildXaiKeysResult,
  decodeMessage,
  deframeResponse,
  encodeVarint,
  frameMessage,
  getMessage,
  getNumber,
  getRepeatedMessages,
  getRepeatedStrings,
  getString,
  message,
  messageField,
  type ProtoMessage,
  stringField,
  varintField,
  xaiPlugin
} from './main.js'

test('xai plugin is well-formed', () => {
  expect(xaiPlugin.meta.id).toBe('xai')
  expect(typeof xaiPlugin.auth.kind).toBe('string')
  expect(xaiPlugin.capabilities.length).toBeGreaterThan(0)
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of xaiPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(resolveCurrencies(cap.sample!(), 'USD')), cap.id).toEqual([])
  }
})

test('team id is auto-captured from the dashboard URL, so the config field is an optional override', () => {
  expect(xaiPlugin.session?.captureFromUrl).toContainEqual({
    pattern: '/team/([0-9a-fA-F-]{36})',
    storeAs: 'teamId'
  })

  const teamField = xaiPlugin.config?.fields.find((f) => f.key === 'teamId')

  expect(teamField).toMatchObject({ kind: 'text' })
  expect(teamField?.required).toBeFalsy()
})

// All fixtures are SYNTHETIC, built via the encoder so the tests exercise the real decode path. Field
// numbers mirror the layout the console serves; emails / ids / key hints are invented.

// ── codec ───────────────────────────────────────────────────────────────────────────

describe('encodeVarint', () => {
  it('encodes small and multi-byte varints', () => {
    expect([...encodeVarint(1)]).toEqual([0x01])
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02])
    // 2024 as observed in the ListInvoices since-filter.
    expect([...encodeVarint(2024)]).toEqual([0xe8, 0x0f])
  })
})

describe('field encoders (exact bytes)', () => {
  it('encodes a varint field', () => {
    expect([...varintField(1, 1)]).toEqual([0x08, 0x01])
  })

  it('encodes a string field with the right tag and length prefix', () => {
    // tag = (10<<3)|2 = 0x52, len 2, 'hi'
    expect([...stringField(10, 'hi')]).toEqual([0x52, 0x02, 0x68, 0x69])
  })

  it('encodes a nested message field (tag 30 = 0xf2 0x01)', () => {
    const body = message(varintField(1, 2024), varintField(2, 5))
    const encoded = messageField(30, body)

    expect(encoded[0]).toBe(0xf2)
    expect(encoded[1]).toBe(0x01)
    expect(encoded[2]).toBe(body.length)
  })
})

describe('decodeMessage', () => {
  it('round-trips strings, varints, repeated fields and nested messages', () => {
    const buf = message(
      stringField(10, 'team-123'),
      varintField(40, 2),
      stringField(16, 'api-key:model:*'),
      stringField(16, 'api-key:endpoint:*'),
      messageField(31, message(varintField(1, 1780591985)))
    )
    const msg = decodeMessage(buf)

    expect(getString(msg, 10)).toBe('team-123')
    expect(getNumber(msg, 40)).toBe(2)
    expect(getRepeatedStrings(msg, 16)).toEqual(['api-key:model:*', 'api-key:endpoint:*'])
    expect(getNumber(getMessage(msg, 31)!, 1)).toBe(1780591985)
  })

  it('decodes repeated nested messages', () => {
    const buf = message(messageField(1, message(stringField(2, 'a'))), messageField(1, message(stringField(2, 'b'))))
    const items = getRepeatedMessages(decodeMessage(buf), 1)

    expect(items.map((m) => getString(m, 2))).toEqual(['a', 'b'])
  })

  it('returns an empty message for an empty buffer', () => {
    expect(decodeMessage(Buffer.alloc(0)).size).toBe(0)
  })

  it('throws on a length-delimited field that overruns the buffer', () => {
    // tag 10 (len), claims length 5 but only 1 byte follows.
    expect(() => decodeMessage(Buffer.from([0x52, 0x05, 0x00]))).toThrow()
  })
})

describe('gRPC-Web framing', () => {
  it('frames a message with a 5-byte header', () => {
    const framed = frameMessage(Buffer.from([1, 2, 3, 4]))

    expect(framed[0]).toBe(0x00)
    expect(framed.readUInt32BE(1)).toBe(4)
    expect([...framed.subarray(5)]).toEqual([1, 2, 3, 4])
  })

  it('deframes a data frame plus an ok trailer', () => {
    const data = frameMessage(message(stringField(1, 'ok')))
    const trailerBody = Buffer.from('grpc-status:0\r\n', 'utf8')
    const trailerHeader = Buffer.alloc(5)

    trailerHeader.writeUInt8(0x80, 0)
    trailerHeader.writeUInt32BE(trailerBody.length, 1)
    const { message: msg, grpcStatus } = deframeResponse(Buffer.concat([data, trailerHeader, trailerBody]))

    expect(grpcStatus).toBe(0)
    expect(getString(decodeMessage(msg!), 1)).toBe('ok')
  })

  it('parses a non-zero grpc-status with message from the trailer', () => {
    const trailerBody = Buffer.from('grpc-status:7\r\ngrpc-message:permission%20denied\r\n', 'utf8')
    const header = Buffer.alloc(5)

    header.writeUInt8(0x80, 0)
    header.writeUInt32BE(trailerBody.length, 1)
    const { grpcStatus, grpcMessage } = deframeResponse(Buffer.concat([header, trailerBody]))

    expect(grpcStatus).toBe(7)
    expect(grpcMessage).toBe('permission denied')
  })
})

// ── billing fixtures ──────────────────────────────────────────────────────────────────

// A line item: #1 region, #2 model, #3 usageType, #4 unitPrice, #5 qty, #6 cents, #7 source.
const lineItem = (model: string, usageType: string, qty: number, cents: number): Buffer =>
  message(
    stringField(1, 'us-east-1'),
    stringField(2, model),
    stringField(3, usageType),
    varintField(4, 25000),
    varintField(5, qty),
    varintField(6, cents),
    stringField(7, 'api')
  )

// An invoice: #20 id, #21 number, #31 period ts, #40 status, #70 line items, #110 pdf path.
const invoice = (opts: {
  number: string
  periodSeconds: number
  status: number
  pdfMonth: string // 'YYYY-M'
  items: Array<{ model: string; usageType: string; qty: number; cents: number }>
}): Buffer =>
  message(
    stringField(10, 'team-123'),
    stringField(20, `${opts.number}-id`),
    stringField(21, opts.number),
    messageField(31, message(varintField(1, opts.periodSeconds))),
    varintField(40, opts.status),
    ...opts.items.map((i) => messageField(70, lineItem(i.model, i.usageType, i.qty, i.cents))),
    stringField(110, `teams/team-123/billing/${opts.pdfMonth}-${opts.number}-id.pdf`)
  )

const invoicesResp = (): ProtoMessage =>
  decodeMessage(
    message(
      // Current month, status 1 (open). $1.50 + $0.50 = $2.00.
      messageField(
        1,
        invoice({
          number: 'AAAA-BBBB-CCCC',
          periodSeconds: 1780591985,
          status: 1,
          pdfMonth: '2026-5',
          items: [
            { model: 'Chat grok-4.3', usageType: 'Completion text tokens', qty: 139302, cents: 150 },
            { model: 'Chat grok-3', usageType: 'Prompt text tokens', qty: 9000, cents: 50 }
          ]
        })
      ),
      // Older month, status 2 (paid). $10.00.
      messageField(
        1,
        invoice({
          number: 'DDDD-EEEE-FFFF',
          periodSeconds: 1777827509,
          status: 2,
          pdfMonth: '2026-4',
          items: [{ model: 'API grok-4.3', usageType: 'Prompt text tokens', qty: 5000000, cents: 1000 }]
        })
      )
    )
  )

// GetAmountToPay: line items wrapped in an outer message (#1), items repeated under #1 inside.
const amountToPayResp = (): ProtoMessage =>
  decodeMessage(
    messageField(
      1,
      message(
        messageField(1, lineItem('API grok-4.3', 'Cached prompt text tokens', 1235072, 24)),
        messageField(1, lineItem('API grok-4.3', 'Reasoning text tokens', 230, 76))
      )
    )
  )

// GetSpendingLimits: `{ #1: { #2: { #1: cents }, #5: { #1: cents } } }`.
const spendingLimitsResp = (): ProtoMessage =>
  decodeMessage(
    messageField(
      1,
      message(messageField(2, message(varintField(1, 100000))), messageField(5, message(varintField(1, 100000))))
    )
  )

describe('buildBillingReport', () => {
  it('normalizes invoices: totals from line items (cents→$), month from PDF path, status enum', () => {
    const r = buildBillingReport(invoicesResp(), amountToPayResp(), spendingLimitsResp(), 'team-123')

    expect(r.invoices).toHaveLength(2)

    const [latest, older] = r.invoices

    // Sorted by billing month desc → May before April.
    expect(latest!.date).toBe('2026-05-01')
    expect(latest!.number).toBe('AAAA-BBBB-CCCC')
    expect(latest!.status).toBe('open')
    expect(latest!.amount).toBeCloseTo(2.0)
    expect(latest!.lineItemCount).toBe(2)
    expect(latest!.hostedUrl).toBe('https://console.x.ai/team/team-123/settings/billing/invoices/AAAA-BBBB-CCCC-id')

    expect(older!.date).toBe('2026-04-01')
    expect(older!.status).toBe('paid')
    expect(older!.amount).toBeCloseTo(10.0)
  })

  it('sums totalBilled across invoices', () => {
    const r = buildBillingReport(invoicesResp(), amountToPayResp(), spendingLimitsResp(), 'team-123')

    expect(r.totalBilled).toBeCloseTo(12.0)
  })

  it('computes the current period accrued cost and top models from GetAmountToPay', () => {
    const r = buildBillingReport(invoicesResp(), amountToPayResp(), spendingLimitsResp(), 'team-123')

    expect(r.currentPeriodAccrued).toBeCloseTo(1.0) // $0.24 + $0.76
    expect(r.topCurrentModels[0]).toEqual({ label: 'API grok-4.3 · Reasoning text tokens', cost: expect.closeTo(0.76) })
    expect(r.topCurrentModels).toHaveLength(2)
  })

  it('reads the spending limit (cents→$)', () => {
    const r = buildBillingReport(invoicesResp(), amountToPayResp(), spendingLimitsResp(), 'team-123')

    expect(r.spendingLimit).toBeCloseTo(1000.0)
  })

  it('handles empty responses', () => {
    const empty = decodeMessage(Buffer.alloc(0))
    const r = buildBillingReport(empty, empty, empty, 'team-123')

    expect(r.invoices).toEqual([])
    expect(r.totalBilled).toBe(0)
    expect(r.currentPeriodAccrued).toBe(0)
    expect(r.topCurrentModels).toEqual([])
    expect(r.spendingLimit).toBeUndefined()
  })
})

describe('buildXaiBillingResult', () => {
  it('produces a valid CapabilityResult with the spend.mtd summary, spending limit and top-models table', () => {
    const result = buildXaiBillingResult(
      buildBillingReport(invoicesResp(), amountToPayResp(), spendingLimitsResp(), 'team-123')
    )

    expect(validateCapabilityResult(resolveCurrencies(result, 'USD'))).toEqual([])

    // spend.mtd summary = current-period accrued.
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.basis).toBe('accrued')
    expect(result.summaries?.[0]?.value).toBeCloseTo(1.0)

    // Spending limit folded onto the account record.
    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')

    if (account?.shape === 'record') {
      expect(account.value.spendingLimit).toBeCloseTo(1000.0)
    }

    // Top-models breakdown table is present.
    const topModels = result.datasets.find((d) => d.id === 'topModels')

    expect(topModels?.shape).toBe('table')

    if (topModels?.shape === 'table') {
      expect(topModels.rows).toHaveLength(2)
    }
  })

  it('omits the spending-limit stat and top-models table when neither is present', () => {
    const empty = decodeMessage(Buffer.alloc(0))
    const result = buildXaiBillingResult(buildBillingReport(empty, empty, empty, 'team-123'))

    expect(validateCapabilityResult(resolveCurrencies(result, 'USD'))).toEqual([])
    expect(result.datasets.find((d) => d.id === 'topModels')).toBeUndefined()
    const account = result.datasets.find((d) => d.id === 'account')

    if (account?.shape === 'record') {
      expect(account.value.spendingLimit).toBeUndefined()
    }
  })
})

// ── apiKeys fixtures ──────────────────────────────────────────────────────────────────

// A key: #1 hint, #4 name, #5 created ts, #8 id, #10 creator, #16 ACLs (repeated).
const apiKey = (opts: {
  hint: string
  name: string
  createdSeconds: number
  id: string
  email: string
  first: string
  last: string
  acls: string[]
}): Buffer =>
  message(
    stringField(1, opts.hint),
    stringField(3, 'creator-uuid'),
    stringField(4, opts.name),
    messageField(5, message(varintField(1, opts.createdSeconds))),
    stringField(6, 'team-123'),
    stringField(8, opts.id),
    messageField(
      10,
      message(
        stringField(1, 'creator-uuid'),
        stringField(3, opts.email),
        stringField(5, opts.first),
        stringField(6, opts.last)
      )
    ),
    ...opts.acls.map((a) => stringField(16, a))
  )

const keysResp = (): ProtoMessage =>
  decodeMessage(
    message(
      messageField(
        1,
        apiKey({
          hint: 'xai-…aaaa',
          name: 'Production',
          createdSeconds: 1759434591, // 2025-10-02
          id: 'key-1',
          email: 'alice@example.com',
          first: 'Alice',
          last: 'Anderson',
          acls: ['api-key:endpoint:*', 'api-key:model:*']
        })
      ),
      messageField(
        1,
        apiKey({
          hint: 'xai-…bbbb',
          name: 'Staging',
          createdSeconds: 1776795214, // 2026-04-21
          id: 'key-2',
          email: 'bob@example.com',
          first: 'Bob',
          last: 'Brown',
          acls: ['api-key:model:*']
        })
      )
    )
  )

describe('buildKeysReport', () => {
  it('parses keys: hint, name, creator email/name, created date, ACLs (sorted by created desc)', () => {
    const r = buildKeysReport(keysResp())

    expect(r.totalKeys).toBe(2)

    const [first, second] = r.keys

    // Sorted by created desc → Staging (2026-04) before Production (2025-10).
    expect(first!.name).toBe('Staging')
    expect(first!.keyHint).toBe('xai-…bbbb')
    expect(first!.id).toBe('key-2')
    expect(first!.created).toBe('2026-04-21')
    expect(first!.creatorEmail).toBe('bob@example.com')
    expect(first!.creatorName).toBe('Bob Brown')
    expect(first!.acls).toEqual(['api-key:model:*'])

    expect(second!.name).toBe('Production')
    expect(second!.created).toBe('2025-10-02')
    expect(second!.acls).toEqual(['api-key:endpoint:*', 'api-key:model:*'])
  })

  it('handles an empty response', () => {
    const r = buildKeysReport(decodeMessage(Buffer.alloc(0)))

    expect(r.keys).toEqual([])
    expect(r.totalKeys).toBe(0)
  })
})

describe('buildXaiKeysResult', () => {
  it('produces a valid CapabilityResult with masked hints and a key-details table', () => {
    const result = buildXaiKeysResult(buildKeysReport(keysResp()))

    expect(validateCapabilityResult(result)).toEqual([])

    const keys = result.datasets.find((d) => d.id === 'keys')

    expect(keys?.shape).toBe('table')

    if (keys?.shape === 'table') {
      // Masked hint is what surfaces — never a full secret.
      expect(keys.rows[0]!.masked).toBe('xai-…bbbb')
    }

    const details = result.datasets.find((d) => d.id === 'keyDetails')

    expect(details?.shape).toBe('table')

    if (details?.shape === 'table') {
      expect(details.rows[0]!.creator).toBe('Bob Brown')
      expect(details.rows[0]!.acls).toBe('api-key:model:*')
    }
  })

  it('produces a valid (empty) result for no keys', () => {
    const result = buildXaiKeysResult(buildKeysReport(decodeMessage(Buffer.alloc(0))))

    expect(validateCapabilityResult(result)).toEqual([])
  })
})
