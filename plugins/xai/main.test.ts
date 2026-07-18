import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  billingEmail,
  buildBillingReport,
  buildKeysReport,
  buildMembersReport,
  buildUsageReport,
  buildXaiBillingResult,
  buildXaiKeysResult,
  buildXaiMembersResult,
  buildXaiUsageResult,
  findFlightMessage,
  readFlight,
  type RawXaiApiKey,
  type RawXaiKeys,
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
  packedDoublesField,
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

// An invoice: #20 id, #21 number, #31 issue ts, #40 status, #70 line items, #110 pdf path, #120 billing period.
// A prepaid-credit invoice carries no #120 — omit `period` to cover the issue-date fallback.
const invoice = (opts: {
  number: string
  issueSeconds: number
  status: number
  period?: { year: number; month: number }
  items: Array<{ model: string; usageType: string; qty: number; cents: number }>
}): Buffer =>
  message(
    stringField(10, 'team-123'),
    stringField(20, `${opts.number}-id`),
    stringField(21, opts.number),
    messageField(31, message(varintField(1, opts.issueSeconds))),
    varintField(40, opts.status),
    ...opts.items.map((i) => messageField(70, lineItem(i.model, i.usageType, i.qty, i.cents))),
    stringField(
      110,
      `teams/team-123/billing/${opts.period?.year ?? 0}-${opts.period?.month ?? 0}-${opts.number}-id.pdf`
    ),
    ...(opts.period
      ? [
          messageField(
            120,
            messageField(10, message(varintField(1, opts.period.year), varintField(2, opts.period.month)))
          )
        ]
      : [])
  )

const invoicesResp = (): ProtoMessage =>
  decodeMessage(
    message(
      // Current month, status 1 (open). $1.50 + $0.50 = $2.00.
      messageField(
        1,
        invoice({
          number: 'AAAA-BBBB-CCCC',
          // The issue date lands in the month AFTER the period it bills — the period is what dates the invoice.
          issueSeconds: 1780591985,
          status: 1,
          period: { year: 2026, month: 5 },
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
          issueSeconds: 1777827509,
          status: 2,
          period: { year: 2026, month: 4 },
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

  it('dates a prepaid-credit invoice (no billing period) from its issue date', () => {
    const resp = decodeMessage(
      messageField(
        1,
        invoice({
          number: 'GGGG-HHHH-IIII',
          issueSeconds: 1759427723, // 2025-10-02
          status: 2,
          items: [{ model: 'Prepaid credits', usageType: 'Credit purchase', qty: 1, cents: 10000 }]
        })
      )
    )
    const r = buildBillingReport(resp, amountToPayResp(), spendingLimitsResp(), 'team-123')

    expect(r.invoices[0]!.date).toBe('2025-10-01')
    expect(r.invoices[0]!.amount).toBeCloseTo(100)
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

// The keys as the page's flight carries them: JSON by field name, int64 as a `$n` BigInt token, creator by id.
const rawKey = (opts: {
  hint: string
  name: string
  createdSeconds: number
  id: string
  userId: string
  acls: string[]
  disabled?: boolean
}): RawXaiApiKey => ({
  redactedApiKey: opts.hint,
  name: opts.name,
  userId: opts.userId,
  apiKeyId: opts.id,
  disabled: opts.disabled ?? false,
  aclStrings: opts.acls,
  createTime: { seconds: `$n${opts.createdSeconds}` }
})

const keysRaw = (): RawXaiKeys => ({
  keys: [
    rawKey({
      hint: 'xai-…aaaa',
      name: 'Production',
      createdSeconds: 1759434591, // 2025-10-02
      id: 'key-1',
      userId: 'u-1',
      acls: ['api-key:endpoint:*', 'api-key:model:*']
    }),
    rawKey({
      hint: 'xai-…bbbb',
      name: 'Staging',
      createdSeconds: 1776795214, // 2026-04-21
      id: 'key-2',
      userId: 'u-2',
      acls: ['api-key:model:*'],
      disabled: true
    })
  ],
  members: [
    { id: 'u-1', name: 'Ada Lovelace', email: 'ada@example.invalid' },
    { id: 'u-2', name: 'Grace Hopper', email: 'grace@example.invalid' }
  ]
})

describe('buildKeysReport', () => {
  it('parses keys and resolves the creator id against the roster (sorted by created desc)', () => {
    const r = buildKeysReport(keysRaw())

    expect(r.totalKeys).toBe(2)

    const [first, second] = r.keys

    // Sorted by created desc → Staging (2026-04) before Production (2025-10).
    expect(first!.name).toBe('Staging')
    expect(first!.keyHint).toBe('xai-…bbbb')
    expect(first!.id).toBe('key-2')
    expect(first!.created).toBe('2026-04-21')
    expect(first!.creatorEmail).toBe('grace@example.invalid')
    expect(first!.creatorName).toBe('Grace Hopper')
    expect(first!.acls).toEqual(['api-key:model:*'])
    expect(first!.disabled).toBe(true)

    expect(second!.name).toBe('Production')
    expect(second!.created).toBe('2025-10-02')
    expect(second!.creatorName).toBe('Ada Lovelace')
    expect(second!.acls).toEqual(['api-key:endpoint:*', 'api-key:model:*'])
  })

  it('keeps a key whose creator has left the team, with no creator resolved', () => {
    const raw = keysRaw()
    const r = buildKeysReport({ keys: raw.keys, members: [] })

    expect(r.totalKeys).toBe(2)
    expect(r.keys[0]!.creatorName).toBeUndefined()
    expect(r.keys[0]!.creatorEmail).toBeUndefined()
  })

  it('tolerates a key the page rendered with fields missing', () => {
    const r = buildKeysReport({ keys: [{}], members: [] })

    expect(r.keys[0]).toMatchObject({ id: '', name: '(unnamed)', keyHint: '', acls: [], disabled: false })
    expect(r.keys[0]!.created).toBeUndefined()
  })

  it('handles an empty response', () => {
    const r = buildKeysReport({ keys: [], members: [] })

    expect(r.keys).toEqual([])
    expect(r.totalKeys).toBe(0)
  })
})

describe('buildXaiKeysResult', () => {
  it('produces a valid CapabilityResult with masked hints and a key-details table', () => {
    const result = buildXaiKeysResult(buildKeysReport(keysRaw()))

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
      expect(details.rows[0]!.creator).toBe('Grace Hopper')
      expect(details.rows[0]!.acls).toBe('api-key:model:*')
      // Keyed on the console key id so each key's creator/scope history accumulates in the ledger.
      expect(details.key).toBe('id')
      expect(details.rows[0]!.id).toBe('key-2')
    }
  })

  it('produces a valid (empty) result for no keys', () => {
    const result = buildXaiKeysResult(buildKeysReport({ keys: [], members: [] }))

    expect(validateCapabilityResult(result)).toEqual([])
  })
})

// The usage analytics buckets: `{ #1: { #2: repeated { #1: {#1 seconds}, #2: packed doubles } } }`. The doubles
// are positional per the metrics requested (usd · items · units) and are already DOLLARS, not cents.
const usageResp = (buckets: Array<{ seconds: number; values: number[] }>): ProtoMessage =>
  decodeMessage(
    messageField(
      1,
      message(
        ...buckets.map((b) =>
          messageField(2, message(messageField(1, message(varintField(1, b.seconds))), packedDoublesField(2, b.values)))
        )
      )
    )
  )

describe('buildUsageReport', () => {
  it('reads packed doubles positionally as dollars, sorts by day, and totals each metric', () => {
    // 2026-07-02 and 2026-07-03, delivered newest-first to prove the sort.
    const r = buildUsageReport(
      usageResp([
        { seconds: 1783036800, values: [1.4834, 161, 163890] },
        { seconds: 1782950400, values: [0.22732635, 40, 12000] }
      ])
    )

    expect(r.days.map((d) => d.date)).toEqual(['2026-07-02', '2026-07-03'])
    expect(r.days[0]!.cost).toBeCloseTo(0.23)
    expect(r.days[0]!.requests).toBe(40)
    expect(r.days[1]!.units).toBe(163890)
    expect(r.totalCost).toBeCloseTo(1.71)
    expect(r.totalRequests).toBe(201)
    expect(r.totalUnits).toBe(175890)
  })

  it('defaults a bucket that carries fewer doubles than metrics requested', () => {
    const r = buildUsageReport(usageResp([{ seconds: 1782950400, values: [0.5] }]))

    expect(r.days[0]).toEqual({ date: '2026-07-02', cost: 0.5, requests: 0, units: 0 })
  })

  it('produces a valid result, with the daily trend as the summary spark', () => {
    const result = buildXaiUsageResult(buildUsageReport(usageResp([{ seconds: 1782950400, values: [0.5, 10, 100] }])))

    expect(validateCapabilityResult(resolveCurrencies(result, 'USD'))).toEqual([])
    // Usage spend is per-service context, never summed into the cross-service spend total.
    expect(result.summaries?.[0]?.section).toBe('other')
  })

  it('produces a valid (empty) result for a team with no usage', () => {
    expect(
      validateCapabilityResult(resolveCurrencies(buildXaiUsageResult(buildUsageReport(usageResp([]))), 'USD'))
    ).toEqual([])
  })
})

// ListSubscriptionAssignments: `{ #1: repeated { #1: PublicUser } }` — one response per seat product.
const assignmentsResp = (people: Array<{ id: string; email: string; first: string; last: string }>): ProtoMessage =>
  decodeMessage(
    message(
      ...people.map((p) =>
        messageField(
          1,
          messageField(
            1,
            message(stringField(1, p.id), stringField(3, p.email), stringField(5, p.first), stringField(6, p.last))
          )
        )
      )
    )
  )

const ada = { id: 'u-1', email: 'ada@example.invalid', first: 'Ada', last: 'Lovelace' }
const grace = { id: 'u-2', email: 'grace@example.invalid', first: 'Grace', last: 'Hopper' }

describe('buildMembersReport', () => {
  it('unions people across seat products by user id, so a two-seat holder is one row', () => {
    const r = buildMembersReport([assignmentsResp([grace, ada]), assignmentsResp([ada])])

    expect(r).toEqual([
      { id: 'u-1', name: 'Ada Lovelace', email: 'ada@example.invalid' },
      { id: 'u-2', name: 'Grace Hopper', email: 'grace@example.invalid' }
    ])
  })

  it('keeps a person whose name is absent, falling back to the email for ordering', () => {
    const nameless = decodeMessage(
      messageField(1, messageField(1, message(stringField(1, 'u-3'), stringField(3, 'zz@example.invalid'))))
    )
    const r = buildMembersReport([nameless])

    expect(r).toEqual([{ id: 'u-3', name: undefined, email: 'zz@example.invalid' }])
  })

  it('produces a valid result carrying the email column the cross-service roster joins on', () => {
    const result = buildXaiMembersResult(buildMembersReport([assignmentsResp([ada, grace])]))

    expect(validateCapabilityResult(result)).toEqual([])

    const members = result.datasets.find((d) => d.id === 'members')

    // The cross-service People roster only merges a `members` table that declares an email column.
    expect(members?.shape === 'table' && members.columns.some((c) => c.key === 'email')).toBe(true)
  })

  it('produces a valid (empty) result for a team with no seats', () => {
    expect(validateCapabilityResult(buildXaiMembersResult(buildMembersReport([])))).toEqual([])
  })
})

describe('billingEmail', () => {
  it('reads the billing contact out of GetBillingInfo', () => {
    const resp = decodeMessage(
      messageField(10, message(stringField(20, 'Ada'), stringField(30, 'ada@example.invalid')))
    )

    expect(billingEmail(resp)).toBe('ada@example.invalid')
  })

  it('is undefined when the contact is absent or blank', () => {
    expect(billingEmail(decodeMessage(Buffer.alloc(0)))).toBeUndefined()
    expect(billingEmail(decodeMessage(messageField(10, message(stringField(30, '')))))).toBeUndefined()
  })
})

// The page's RSC flight: Next.js streams it as a run of self.__next_f.push([1,"<js string literal>"]) calls,
// each literal a JSON-escaped fragment of one long string. A message can straddle two pushes.
const pageWith = (...fragments: string[]): string =>
  fragments.map((f) => `<script>self.__next_f.push([1,${JSON.stringify(f)}])</script>`).join('\n')

describe('readFlight / findFlightMessage', () => {
  it('reassembles the flight across pushes and parses a message that straddles two of them', () => {
    const half = '{"$typeName":"auth_mgmt.ListApiKeysResponse","apiKeys":[{"$typeName":"prod_auth.ApiKey",'
    const rest = '"redactedApiKey":"xai-…aaaa","name":"Production"}]}'
    const found = findFlightMessage<{ apiKeys: RawXaiApiKey[] }>(
      readFlight(pageWith(half, rest)),
      'auth_mgmt.ListApiKeysResponse'
    )

    expect(found?.apiKeys[0]?.redactedApiKey).toBe('xai-…aaaa')
  })

  it('is not fooled by a brace or a quote inside a string value', () => {
    const flight = readFlight(pageWith('{"$typeName":"x.Y","name":"a{\\"}b","tail":1}'))

    expect(findFlightMessage<{ name: string; tail: number }>(flight, 'x.Y')).toEqual({
      $typeName: 'x.Y',
      name: 'a{"}b',
      tail: 1
    })
  })

  it('returns undefined for a page that carries no flight, or no such message', () => {
    expect(readFlight('<html><body>signed out</body></html>')).toBe('')
    expect(findFlightMessage(readFlight(pageWith('{"$typeName":"x.Y"}')), 'x.Z')).toBeUndefined()
  })

  it('ignores a push whose payload is not a well-formed string literal', () => {
    expect(readFlight('<script>self.__next_f.push([1,notAString])</script>')).toBe('')
  })
})
