import { describe, expect, test } from 'vitest'

import type { NotificationDraft, NotificationDto } from '../../shared/ipc.js'

import { mergeNotifications } from './merge.js'

const change = (id: string): NotificationDraft => ({ id, kind: 'change', severity: 'info', pluginId: 'stripe' })
const health = (id: string): NotificationDraft => ({
  id,
  kind: 'health',
  severity: 'warning',
  pluginId: 'claude',
  currency: 'CAD'
})
const stored = (d: NotificationDraft, over: Partial<NotificationDto> = {}): NotificationDto => ({
  ...d,
  createdAt: '2026-06-10T00:00:00Z',
  read: false,
  ...over
})

describe('mergeNotifications', () => {
  test('a change with a new id is added unread; an existing id is not duplicated and keeps its read state', () => {
    const existing = [stored(change('change:stripe:spend:mom:2026-05'), { read: true })]
    const fresh = [change('change:stripe:spend:mom:2026-05'), change('change:stripe:spend:mom:2026-06')]
    const out = mergeNotifications(existing, fresh, '2026-06-16T00:00:00Z')

    expect(out.map((n) => n.id)).toEqual(['change:stripe:spend:mom:2026-06', 'change:stripe:spend:mom:2026-05'])
    expect(out.find((n) => n.id.endsWith('2026-05'))!.read).toBe(true)
    expect(out.find((n) => n.id.endsWith('2026-06'))!.createdAt).toBe('2026-06-16T00:00:00Z')
  })

  test('a health notice auto-resolves when absent from fresh; persists (with read state) when still present', () => {
    const existing = [stored(health('health:fx:claude'), { read: true }), stored(health('health:fx:vercel'))]
    const out = mergeNotifications(existing, [health('health:fx:claude')], '2026-06-16T00:00:00Z')

    expect(out.map((n) => n.id)).toEqual(['health:fx:claude'])
    expect(out[0]!.read).toBe(true)
  })

  test('existing change notices persist even when not in the fresh set', () => {
    const existing = [stored(change('change:stripe:spend:dod:2026-06-15'))]
    const out = mergeNotifications(existing, [], '2026-06-16T00:00:00Z')

    expect(out.map((n) => n.id)).toEqual(['change:stripe:spend:dod:2026-06-15'])
  })
})
