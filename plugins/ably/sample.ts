// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. Ably's dashboard is server-rendered HTML, so the generators assemble the same HTML the scrapers parse;
// `documents` caps the invoice-row count.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { AblyBillingRaw, AblyUsageRaw } from './main.js'

// One invoice <tr> the scraper reads: cell order is [expand, invoice#, date, amount, status, reason, actions].
const invoiceRow = (idSuffix: number, num: string, monthName: string, day: number, year: number, amount: string) => `
    <tr data-testid="invoice-row" id="invoice-${idSuffix}" data-source="stripe">
      <td><svg></svg></td>
      <td><span class="text-sm">${num}</span></td>
      <td><span class="text-sm">${monthName} ${day}, ${year}</span></td>
      <td class="text-right"><span class="text-sm">${amount}</span></td>
      <td class="text-center"><span>Paid</span></td>
      <td></td>
      <td class="text-right"><a href="/accounts/${idSuffix}/invoices/${idSuffix}">View</a></td>
    </tr>`

// Monthly invoice rows (newest first) so the trailing-12mo total + monthly spend chart fill in. dayString walks
// back a month per row; the amount strings are scraped dollar strings the build parses.
export const sampleAblyBilling = (g: SampleGen, config: SampleConfig): AblyBillingRaw => {
  const n = Math.min(config.documents, 36)
  const accountId = g.int(80000, 99999)
  const rows = g
    .repeat(n, (i) => {
      const m = g.monthsAgo(i)
      const [monthName, year] = m.label.split(' ')

      return invoiceRow(accountId + i, `in_1${g.id('')}`, monthName!, 1, Number(year), `$${g.moneyStr(20, 90)}`)
    })
    .join('')

  const invoicesHtml = `
<table class="border-separate">
  <tbody data-controller="invoice-toggle">${rows}
  </tbody>
</table>`

  const plan = g.pick(['standard', 'pro', 'enterprise'])
  const packageHtml = `<div data-turbo-mount-props-value="{&quot;propData&quot;:{&quot;currentPackagePlanId&quot;:&quot;${plan}&quot;}}"></div>`

  return { invoicesHtml, packageHtml }
}

// Bare <tbody> usage fragment: bold billable-total rows (with monthly limits) + sub-metric rows, with the display
// strings the build preserves. Counts/volumes drawn from the toolkit; the units (GiB) are structural literals.
export const sampleAblyUsage = (g: SampleGen, _config: SampleConfig): AblyUsageRaw => {
  const n = (min: number, max: number) => g.int(min, max).toLocaleString('en-US')

  return {
    html: `
<tr class="bold">
  <td data-js-stat="billable_messages_all_count">Messages volume</td>
  <td>1,000,000,000</td>
  <td>${n(50_000_000, 90_000_000)}</td>
  <td>${n(10_000_000, 25_000_000)}</td>
  <td>${n(40_000_000, 60_000_000)}</td>
  <td></td>
</tr>
<tr>
  <td data-js-stat="messages_published"> - Messages published (REST &amp; Realtime)</td>
  <td></td>
  <td>${n(1_000_000, 2_000_000)}</td>
  <td>${n(500_000, 900_000)}</td>
  <td>${n(1_500_000, 2_500_000)}</td>
  <td>${g.sentence()}</td>
</tr>
<tr class="bold">
  <td data-js-stat="billable_messages_all_data">Messages volume (data)</td>
  <td>500 GiB</td>
  <td>${g.int(40, 80)} GiB</td>
  <td>${g.int(8, 20)} GiB</td>
  <td>${g.int(30, 50)} GiB</td>
  <td></td>
</tr>
<tr>
  <td data-js-stat="peak_connections">Peak connections</td>
  <td>10,000</td>
  <td>${n(3_000, 5_000)}</td>
  <td>${n(2_500, 4_500)}</td>
  <td>${n(4_000, 6_000)}</td>
  <td></td>
</tr>`
  }
}
