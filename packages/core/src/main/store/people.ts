import { buildPeopleData, serviceMembersFrom, type ServiceMembers } from '@butinapp/shapes'

import type { PeopleDto } from '../../shared/ipc.js'
import { plugins } from '../plugin/plugins.js'

import { getPluginInstalled } from './config-file.js'
import { readCurrent, reconstructResult } from './store.js'

// Read every installed plugin's cached reports and merge their member rosters into the People payload. The
// cross-service merge/shape lives in @butinapp/shapes (shared with the embed viewer); this is the cache-only
// IO glue that feeds it — no collectors run.
export const buildPeople = async (): Promise<PeopleDto> => {
  const inputs: ServiceMembers[] = []

  for (const plugin of plugins.filter((p) => getPluginInstalled(p.meta.id))) {
    const caps = await Promise.all(
      plugin.capabilities.map(async (cap) => {
        const envelope = await readCurrent(plugin.meta.id, cap.id)

        return { id: cap.id, result: envelope ? reconstructResult(envelope.data) : null, asOf: envelope?.lastRunAt }
      })
    )

    const roster = serviceMembersFrom({ pluginId: plugin.meta.id, serviceName: plugin.meta.name, caps })

    if (roster) {
      inputs.push(roster)
    }
  }

  return buildPeopleData(inputs)
}
