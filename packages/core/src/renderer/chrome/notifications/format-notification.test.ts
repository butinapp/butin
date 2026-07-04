import { describe, expect, test } from 'vitest'

import { formatNotification, type NotificationLabels } from './format-notification.js'
import type { NotificationView } from './types.js'

const labels: NotificationLabels = {
  windowDod: 'day over day',
  windowWow: 'week over week',
  windowMom: 'month over month',
  facetSpend: 'spend',
  facetUsage: 'usage',
  allServices: 'All services',
  up: 'up',
  down: 'down',
  newActivity: 'started',
  fxMissingTitle: 'Missing exchange rate',
  fxMissingBody: (currency, base, service) =>
    `No ${currency}→${base} rate — ${service} is excluded. Set it in Settings.`
}
const ctx = {
  serviceName: (id?: string) => (id === 'stripe' ? 'Stripe' : id === 'claude' ? 'Claude' : (id ?? '?')),
  baseCurrency: 'USD',
  money: (n: number, ccy?: string) => `${ccy ?? 'USD'} ${n}`,
  pct: (f: number) => `${Math.round(f * 100)}%`,
  labels
}

describe('formatNotification', () => {
  test('change up', () => {
    const n: NotificationView = {
      id: 'x',
      createdAt: '',
      kind: 'change',
      severity: 'info',
      pluginId: 'stripe',
      facet: 'spend',
      window: 'mom',
      previous: 100,
      current: 130,
      pct: 0.3,
      currency: 'USD',
      read: false
    }

    expect(formatNotification(n, ctx)).toEqual({
      title: 'Stripe spend up 30% month over month',
      body: 'USD 100 → USD 130'
    })
  })

  test('new activity (no pct)', () => {
    const n: NotificationView = {
      id: 'x',
      createdAt: '',
      kind: 'change',
      severity: 'info',
      pluginId: 'stripe',
      facet: 'spend',
      window: 'wow',
      previous: 0,
      current: 50,
      currency: 'USD',
      read: false
    }

    expect(formatNotification(n, ctx).title).toBe('Stripe started spend week over week')
  })

  test('health fx-missing', () => {
    const n: NotificationView = {
      id: 'health:fx:claude',
      createdAt: '',
      kind: 'health',
      severity: 'warning',
      pluginId: 'claude',
      currency: 'CAD',
      read: false
    }
    const out = formatNotification(n, ctx)

    expect(out.title).toBe('Missing exchange rate')
    expect(out.body).toContain('CAD→USD')
    expect(out.body).toContain('Claude')
  })
})
