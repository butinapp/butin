import type { ButinPlugin } from '@butinapp/sdk'
import { type Cookie, session } from 'electron'

import type { DevCookieDto, DevCookieSelector, DevPartitionDto } from '../../shared/ipc/dev.js'
import { activePartition, partitionFor, touchedPartitions } from '../browser/shared-session.js'
import { plugins } from '../plugin/plugins.js'
import { getSetting } from '../store/config-file.js'

import { type IpcHandlers, safeResult } from './result.js'

// An Electron cookie → the renderer DTO. size is the byte weight a server sees; a cookie with no
// expirationDate is a session cookie.
export const cookieToDto = (c: Cookie): DevCookieDto => ({
  name: c.name,
  value: c.value,
  domain: c.domain ?? '',
  path: c.path ?? '/',
  size: c.name.length + c.value.length,
  expires: c.expirationDate ?? null,
  session: c.session ?? c.expirationDate == null,
  httpOnly: c.httpOnly ?? false,
  secure: c.secure ?? false,
  sameSite: c.sameSite ?? 'unspecified'
})

// The URL `cookies.remove` needs: scheme from secure, host = domain with a leading dot stripped, plus the path.
export const cookieRemoveUrl = (sel: { domain: string; path: string; secure: boolean }): string =>
  `${sel.secure ? 'https' : 'http'}://${sel.domain.replace(/^\./, '')}${sel.path || '/'}`

// A human label for a partition: the active base is the shared default; `…-native-<id>` and a custom
// `session.partition` read the owning plugin's name; anything else shows the bare (de-prefixed) string.
export const partitionLabel = (
  partition: string,
  active: string,
  list: Pick<ButinPlugin, 'meta' | 'transport' | 'session'>[]
): string => {
  if (partition === active) {
    return 'Default (shared)'
  }

  const native = /-native-([a-z0-9-]+)$/.exec(partition)

  if (native) {
    return `${list.find((p) => p.meta.id === native[1])?.meta.name ?? native[1]} (isolated)`
  }

  const custom = list.find((p) => p.session?.partition === partition)

  return custom ? custom.meta.name : partition.replace(/^persist:/, '')
}

// Every partition of the active profile: the shared base, the partitions used this run, and each plugin's
// declared partition (native-headers + custom overrides). De-duped, active first.
const knownPartitions = (): string[] => [
  ...new Set<string>([activePartition(), ...touchedPartitions(), ...plugins.map(partitionFor)])
]

// The developer channels read and delete live session cookies. They answer only while the user has turned
// developer mode on, so the channel is inert in an ordinary run whatever calls it.
const requireDevMode = (): void => {
  if (!getSetting('devMode')) {
    throw new Error('developer mode is off')
  }
}

export const devHandlers = {
  listPartitions: async (): Promise<DevPartitionDto[]> => {
    requireDevMode()

    const active = activePartition()

    return Promise.all(
      knownPartitions().map(async (partition) => ({
        partition,
        label: partitionLabel(partition, active, plugins),
        count: (await session.fromPartition(partition).cookies.get({})).length
      }))
    )
  },

  listCookies: async (_e, partition: string): Promise<DevCookieDto[]> => {
    requireDevMode()

    return (await session.fromPartition(partition).cookies.get({})).map(cookieToDto)
  },

  deleteCookie: (_e, partition: string, sel: DevCookieSelector) =>
    safeResult(async () => {
      requireDevMode()
      await session.fromPartition(partition).cookies.remove(cookieRemoveUrl(sel), sel.name)
    }),

  clearCookieDomain: (_e, partition: string, domain: string) =>
    safeResult(async () => {
      requireDevMode()

      const ses = session.fromPartition(partition)
      const matched = (await ses.cookies.get({})).filter((c) => (c.domain ?? '').includes(domain))
      let cleared = 0

      for (const c of matched) {
        try {
          await ses.cookies.remove(
            cookieRemoveUrl({ domain: c.domain ?? '', path: c.path ?? '/', secure: !!c.secure }),
            c.name
          )
          cleared += 1
        } catch {
          // host-only / __Host- cookies Electron won't round-trip are skipped; the count reflects reality.
        }
      }

      return cleared
    })
} satisfies IpcHandlers['dev']
