import type { NotificationDraft, NotificationDto } from '../../shared/ipc.js'

export const MAX_NOTIFICATIONS = 100

// Reduce the prior list + this run's fresh drafts into the new persisted list:
//  - change (events): a fresh id that already exists is dropped (already fired this period); a new id is
//    added unread. Existing change notices are retained regardless of the fresh set.
//  - health (conditions): the fresh set is authoritative. A persisted health notice absent from fresh is
//    removed (auto-resolved); one still present keeps its read state + original createdAt.
// Result is newest-first, capped at MAX_NOTIFICATIONS.
export const mergeNotifications = (
  existing: NotificationDto[],
  fresh: NotificationDraft[],
  now: string
): NotificationDto[] => {
  const byId = new Map(existing.map((n) => [n.id, n]))
  const freshHealth = new Set(fresh.filter((d) => d.kind === 'health').map((d) => d.id))
  const out: NotificationDto[] = []

  // Retain existing notices: every change notice; only still-present health notices.
  for (const n of existing) {
    if (n.kind === 'change' || freshHealth.has(n.id)) {
      out.push(n)
    }
  }

  // Add genuinely new drafts (id not already persisted).
  for (const d of fresh) {
    if (!byId.has(d.id)) {
      out.push({ ...d, createdAt: now, read: false })
    }
  }

  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_NOTIFICATIONS)
}
