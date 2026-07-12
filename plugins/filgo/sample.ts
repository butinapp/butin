// Synthetic sample GENERATORS for the demo seed — each fabricates a raw Filgo payload purely from the seeded
// toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector uses.
// The `documents`/`users` knobs scale the statement/delivery history and tank counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { FilgoActifs, FilgoDeliveriesRaw, FilgoStatementsRaw } from './main.js'

export const sampleFilgoActifs = (g: SampleGen, config: SampleConfig): FilgoActifs => {
  const account = String(g.int(10_000_000, 99_999_999))

  return {
    accounts: [{ guid: g.id('acct'), number: account, name: g.person(0).name.toUpperCase() }],
    tanks: g.repeat(Math.max(1, Math.min(config.users, 2)), (i) => ({
      assetId: g.id('asset'),
      name: `RÉSERVOIR PROPANE - ${g.person(i).firstName.toUpperCase()}`,
      product: 'PROPANE',
      capacity: `${g.pick([454, 500, 909, 1136])} L`,
      serviceState: 'Fonctionnel',
      address: g.address()
    }))
  }
}

export const sampleFilgoStatements = (g: SampleGen, config: SampleConfig): FilgoStatementsRaw => {
  const account = String(g.int(10_000_000, 99_999_999))

  return {
    account,
    statements: g.repeat(Math.min(config.documents, 24), (i) => {
      const month = g.monthsAgo(i)
      const number = g.seqId('', g.int(6_000_000, 6_999_999), 7)

      return {
        name: `ECOI_${account}_${number}`,
        templateName: 'ÉTAT DE COMPTE - OI',
        creationTime: `${month.yearMonth}-08T14:00:00-04:00`,
        url: g.url('statements', g.id('doc')),
        metadataV2: [
          { key: "Date de l'état de compte", value: `${month.yearMonth}-28T00:00:00` },
          { key: "Total de l'état de compte", value: g.money(150, 500) },
          { key: 'No relevé', value: number }
        ]
      }
    })
  }
}

export const sampleFilgoDeliveries = (g: SampleGen, config: SampleConfig): FilgoDeliveriesRaw => ({
  deliveries: g.repeat(Math.min(config.documents, 12), (i) => {
    const day = g.day(i * 30 + g.int(0, 20))
    const volume = g.float(150, 400, 1)
    const price = g.float(0.9, 1.3, 4)

    return {
      tickref: g.seqId('001', g.int(10_000_000, 99_999_999), 8),
      createdt: `${day.date}T12:00:00`,
      net_vol: volume,
      gross_vol: g.float(volume * 0.9, volume, 1),
      net_price: price,
      grand_total: g.money(volume * price, volume * price * 1.15),
      fill: 'Y',
      prodcd: '100'
    }
  })
})
