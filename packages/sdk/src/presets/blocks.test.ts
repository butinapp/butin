import { describe, expect, it } from 'vitest'

import { capabilityResult } from '../data/builders.js'
import { validateCapabilityResult } from '../data/result.js'

import { creditsRecord, dailySeries, overageOf, paymentMethodRecord, subscriptionRecord } from './blocks.js'

describe('overageOf', () => {
  it('returns max(0, total - base) rounded to cents', () => {
    expect(overageOf(130, 100)).toBe(30)
    expect(overageOf(130.555, 100)).toBe(30.56)
  })

  it('clamps a base above the total to 0', () => {
    expect(overageOf(80, 100)).toBe(0)
  })

  it('returns null when either side is unknown', () => {
    expect(overageOf(null, 100)).toBeNull()
    expect(overageOf(130, null)).toBeNull()
    expect(overageOf(130, undefined)).toBeNull()
  })
})

describe('dailySeries', () => {
  it('builds a money timeseries when rows carry cost', () => {
    const { dataset, view } = dailySeries('daily', [
      { date: '2026-06-01', cost: 1.5 },
      { date: '2026-06-02', cost: 2 }
    ])

    expect(dataset.shape).toBe('table')
    const cols = dataset.shape === 'table' ? dataset.columns : []

    expect(cols.find((c) => c.key === 'cost')?.role).toBe('money')
    expect(view).toEqual({
      type: 'timeseries',
      dataset: 'daily',
      x: 'date',
      y: 'cost',
      granularity: 'daily',
      title: 'Daily cost'
    })
  })

  it('keys on date so each day accumulates as its own row', () => {
    const { dataset } = dailySeries('daily', [{ date: '2026-06-01', cost: 1 }])

    expect(dataset.shape === 'table' && dataset.key).toBe('date')
  })

  it('builds a count timeseries when rows carry only value', () => {
    const { dataset, view } = dailySeries('daily', [{ date: '2026-06-01', value: 10 }])
    const cols = dataset.shape === 'table' ? dataset.columns : []

    expect(cols.find((c) => c.key === 'value')?.role).toBe('count')
    expect(view.type === 'timeseries' && view.y).toBe('value')
  })

  it('passes validateCapabilityResult composed into a result', () => {
    const { dataset, view } = dailySeries('daily', [{ date: '2026-06-01', cost: 1 }], { currency: 'USD' })

    expect(validateCapabilityResult({ datasets: [dataset], views: [view] })).toEqual([])
  })

  it('composes cleanly as a ViewSpec section', () => {
    const block = dailySeries('daily', [{ date: '2026-06-01', cost: 1 }], { currency: 'USD' })

    expect(validateCapabilityResult(capabilityResult({ sections: [block] }))).toEqual([])
  })
})

describe('creditsRecord', () => {
  it('skips omitted fields and tags money roles', () => {
    const { dataset } = creditsRecord({ balance: 50, granted: 100, currency: 'USD' })
    const fields = dataset.shape === 'record' ? dataset.fields : []

    expect(fields.map((f) => f.key)).toEqual(['balance', 'granted'])
    expect(fields.every((f) => f.role === 'money' && f.currency === 'USD')).toBe(true)
    expect(dataset.shape === 'record' && dataset.value).toEqual({ balance: 50, granted: 100 })
  })

  it('orders netSpend → used → balance → granted', () => {
    const { dataset } = creditsRecord({ granted: 1, balance: 2, used: 3, netSpend: 4 })
    const fields = dataset.shape === 'record' ? dataset.fields : []

    expect(fields.map((f) => f.key)).toEqual(['netSpend', 'used', 'balance', 'granted'])
  })

  it('composes cleanly as a ViewSpec section', () => {
    const block = creditsRecord({ balance: 50, granted: 100, currency: 'USD' })

    expect(validateCapabilityResult(capabilityResult({ sections: [block] }))).toEqual([])
  })
})

describe('paymentMethodRecord', () => {
  it('includes title only when provided', () => {
    const withTitle = paymentMethodRecord({ brand: 'visa', last4: '4242', title: 'Acme' })
    const without = paymentMethodRecord({ brand: 'visa', last4: '4242' })

    const keys = (d: typeof withTitle.dataset) => (d.shape === 'record' ? d.fields.map((f) => f.key) : [])

    expect(keys(withTitle.dataset)).toEqual(['brand', 'last4', 'title'])
    expect(keys(without.dataset)).toEqual(['brand', 'last4'])
  })

  it('composes cleanly as a ViewSpec section', () => {
    const block = paymentMethodRecord({ brand: 'visa', last4: '4242' })

    expect(validateCapabilityResult(capabilityResult({ sections: [block] }))).toEqual([])
  })
})

describe('subscriptionRecord', () => {
  it('builds a keyvalue with only the provided fields, collapsing the period', () => {
    const { dataset, view } = subscriptionRecord({
      plan: 'Pro',
      status: 'active',
      seats: 5,
      unitPrice: 20,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      currency: 'USD'
    })

    expect(view).toEqual({ type: 'keyvalue', dataset: 'subscription', title: 'Subscription' })
    const fields = dataset.shape === 'record' ? dataset.fields : []

    expect(fields.map((f) => f.key)).toEqual(['plan', 'status', 'seats', 'unitPrice', 'period'])
    expect(fields.find((f) => f.key === 'unitPrice')).toMatchObject({ role: 'money', currency: 'USD' })
    expect(dataset.shape === 'record' && dataset.value.period).toBe('2026-06-01 → 2026-06-30')
  })

  it('skips absent fields (no em-dash rows)', () => {
    const { dataset } = subscriptionRecord({ plan: 'Free' })
    const fields = dataset.shape === 'record' ? dataset.fields : []

    expect(fields.map((f) => f.key)).toEqual(['plan'])
  })

  it('passes validateCapabilityResult composed into a result', () => {
    const { dataset, view } = subscriptionRecord({ plan: 'Pro', seats: 3 })

    expect(validateCapabilityResult({ datasets: [dataset], views: [view] })).toEqual([])
  })

  it('composes cleanly as a ViewSpec section', () => {
    const block = subscriptionRecord({ plan: 'Pro', seats: 3 })

    expect(validateCapabilityResult(capabilityResult({ sections: [block] }))).toEqual([])
  })
})
