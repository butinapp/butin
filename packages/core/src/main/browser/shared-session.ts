import { applyBrowserIdentity, promoteSessionCookies } from '@butinapp/engine'
import type { ButinPlugin } from '@butinapp/sdk'
import { app, session as electronSession, type Session } from 'electron'
import { join } from 'node:path'

// The base partition for the active profile. A profile switch repoints this to `persist:butin-<id>`; on a
// single-profile install it stays `persist:butin`. A plugin can still pin its own with `session.partition`.
let active = 'persist:butin'

export const activePartition = (): string => active

export const setActivePartition = (partition: string): void => {
  active = partition
}

// Where Electron persists the active partition on disk: userData/Partitions/<name> (the `persist:` prefix is
// dropped in the folder name). Lives under Electron's userData, NOT under ~/butin.
export const activePartitionDir = (): string =>
  join(app.getPath('userData'), 'Partitions', active.replace(/^persist:/, ''))

export const partitionFor = (plugin: ButinPlugin): string => {
  if (plugin.session?.partition) {
    return plugin.session.partition
  }

  // A native-headers plugin (its CSRF gate needs Chromium's untouched Fetch-Metadata headers) runs on its
  // OWN partition, so the header-rewrite can stay off for it without disturbing the shared session every
  // other plugin uses. Derived from the active base so it's still profile-isolated.
  if (plugin.transport?.nativeBrowserHeaders) {
    return `${active}-native-${plugin.meta.id}`
  }

  return active
}

// Every partition we've touched, so we can promote its session cookies before quit.
const touched = new Set<string>()

// What a page loaded into a capture/replay partition may be granted. A sign-in page needs none of the
// device permissions Chromium grants by default, so everything else is refused before a prompt could show.
const ALLOWED_PERMISSIONS = new Set<string>(['clipboard-sanitized-write', 'fullscreen'])

const restrictPermissions = (ses: Session): void => {
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
}

// The partitions touched this run, for the developer Cookie Jar's partition list.
export const touchedPartitions = (): string[] => [...touched]

// The capture/replay session for a plugin: the shared (or overridden) persistent partition with the
// canonical browser identity applied. Reused across launches — this is what makes "log in once" work.
export const getPluginSession = (plugin: ButinPlugin): Session => {
  const partition = partitionFor(plugin)
  const ses = electronSession.fromPartition(partition)

  applyBrowserIdentity(ses, { rewriteHeaders: !plugin.transport?.nativeBrowserHeaders })
  restrictPermissions(ses)
  touched.add(partition)

  return ses
}

// The active shared-partition session with the canonical browser identity, for a plugin-less consumer
// (the navigation browser). Marks the partition touched so its cookies promote on quit like any plugin's.
export const getSharedSession = (): Session => {
  const ses = electronSession.fromPartition(active)

  applyBrowserIdentity(ses, { rewriteHeaders: true })
  restrictPermissions(ses)
  touched.add(active)

  return ses
}

// Promote session cookies → persistent for every partition we've used this run. Call on app quit.
// `excludeDomains` (the cookie hosts of every `persistCookies:false` plugin) are left to expire instead.
export const persistAllSessions = async (excludeDomains: string[] = []): Promise<void> => {
  await Promise.all([...touched].map((p) => promoteSessionCookies(electronSession.fromPartition(p), excludeDomains)))
}
