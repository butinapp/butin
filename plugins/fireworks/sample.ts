// Synthetic sample GENERATOR for the demo seed — builds the billing-page RSC flight string purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses, so the demo renders exactly what a real fetch would. The flight embeds the `invoiceRows` array mid-stream
// with RSC-escaped `$$` amounts + a trailing prop after the array (so the balance-scan must stop at the array's
// own closing bracket). `documents` scales the invoice history.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

// The billing-page RSC flight: a synthetic `invoiceRows` array embedded in the live flight frame shape. The
// first row is the in-progress "Upcoming" invoice (the live MTD), the rest "Success".
export const sampleFireworksFlight = (g: SampleGen, config: SampleConfig): string => {
  const rows = g.repeat(Math.min(config.documents, 8), (i) => ({
    id: `${g.id('inv')}sample`,
    amount: `$$${g.moneyStr(150, 1_800)}`,
    invoiceUrl: g.url('invoice', g.id('')),
    status: i === 0 ? 'Upcoming' : 'Success',
    targetTimeMs: g.monthsAgo(i).startEpochMs,
    type: 1
  }))

  return `1:["$","$L0",null,{}]
9:[null,["$","$L4",null,{"invoiceRows":${JSON.stringify(rows)},"trailingProp":true}]]
10:["done"]`
}
