// Synthetic sample GENERATORS for the demo seed — each builds a raw service response (server-rendered DNSimple
// dashboard HTML) purely from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through
// the SAME `build` the live collector uses, so the demo renders exactly what a real fetch would. The `documents`
// knob caps the invoice/domain history; `users` drives the member roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { DnsimpleAccountRaw, DnsimpleBillingRaw } from './main.js'

// One invoice row in the invoices-table; matches the cell order parseInvoices reads: [number, date, items, summary, total, status, actions].
const invoiceRow = (
  id: string,
  date: string,
  items: number,
  summary: string,
  total: string,
  status = 'Collected'
): string => `
  <tr class="${status.toLowerCase()}">
    <td>${id}</td>
    <td><time datetime="${date}">x</time></td>
    <td>${items}</td>
    <td class="summary">${summary}</td>
    <td>${total}</td>
    <td class="state">${status}</td>
    <td><a href="/a/00000/account/invoices/${id}/download">Download</a></td>
  </tr>`

// Summary + Billing share the same billing raw (billing page HTML + the walked invoice-page HTMLs).
export const sampleDnsimpleBilling = (g: SampleGen, config: SampleConfig): DnsimpleBillingRaw => {
  const totalStr = `$${g.moneyStr(90, 160)}`
  const n = Math.min(config.documents, 13)

  const billingHtml = `
<main class="three-col-grid">
  <section class="col">
    <div class="action-card">
      <h3>Teams plan</h3>
      <div class="action-card-container">
        <table>
          <tr><td class="pr4">DNS queries (at $0.10 / million)</td><td class="text-right">$0.10</td></tr>
          <tr><td class="pr4">1 × Teams (at $29.00 / month)</td><td class="text-right">$29.00</td></tr>
          <tr><td class="pr4">${g.int(2, 12)} × Teams Active Zone (at $0.50 / month)</td><td class="text-right">$${g.moneyStr(2, 8)}</td></tr>
          <tr><td class="pr4">${g.int(1, 5)} × Teams Extra Seat (at $29.00 / month)</td><td class="text-right">$${g.moneyStr(30, 90)}</td></tr>
          <tr><td colspan="2"><div class="table-separator"></div></td></tr>
          <tr>
            <td class="pr4">Total <em>(estimated)</em> due on <time datetime="${g.dayString(0)}">due</time></td>
            <td class="text-right">${totalStr}</td>
          </tr>
        </table>
      </div>
    </div>
    <div class="action-card">
      <h3><span class="cc-brand-${g.pick(['visa', 'mastercard', 'amex'])} mr2"></span><span>**** **** **** ${g.last4()}</span></h3>
      <div class="action-card-container"><p><span>Expires ${String(g.int(1, 12)).padStart(2, '0')}/${g.int(28, 32)}</span></p></div>
    </div>
  </section>
</main>`

  const rows = g
    .repeat(n, (i) => {
      const date = `${g.monthsAgo(i).yearMonth}-01`

      return invoiceRow(`${g.int(3_000_000, 3_999_999)}-00000`, date, 4, `Teams Plan Renewal (${date})`, totalStr)
    })
    .join('\n')

  const invoicePagesHtml = [
    `
<table class="invoices-table model-table with-hover">
  <thead><tr><th>Invoice #</th><th>Date</th><th>Items</th><th>Summary</th><th>Total</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="text-centered"><span class="mr2">${n} invoices</span></div>`
  ]

  return { billingHtml, invoicePagesHtml }
}

const memberRow = (id: string, name: string, email: string, role: string): string => `
  <tr data-member-id="${id}">
    <td><span class="member-name">${name}</span></td>
    <td><span class="member-email">${email}</span></td>
    <td><span class="member-role">${role}</span></td>
  </tr>`

export const sampleDnsimpleMembers = (g: SampleGen, config: SampleConfig): string => {
  const rows = g
    .people(config.users)
    .map((p, i) => memberRow(String(500 + i), p.name, p.email, i === 0 ? 'Owner' : 'Member'))
    .join('\n')

  return `
<table class="members-table model-table">
  <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
}

export const sampleDnsimpleApiTokens = (g: SampleGen, config: SampleConfig): string => {
  const tokenRow = (name: string): string =>
    `<tr><td>${name}</td><td><time datetime="${g.dayString(400)}">created</time></td><td><time datetime="${g.dayString(30)}">used</time></td></tr>`
  const rows = g
    .repeat(Math.min(config.documents, 4), (i) =>
      tokenRow(g.pick(['CI deploy token', 'Backup token', 'Read-only token', 'Automation token']) + ` ${i + 1}`)
    )
    .join('\n')

  return `
<div class="action-card">
  <h3>API Limits &amp; Usage</h3>
  <div class="three-col-grid">
    <div class="col-third"><strong>${g.int(2_000, 5_000)}</strong> requests/hour limit</div>
    <div class="col-third"><strong>${g.int(1_000, 2_400)}</strong> requests remaining</div>
    <div class="col-third"><strong><time datetime="${g.pastDate(1)}">1h</time></strong> limit reset</div>
  </div>
</div>
<div class="action-card">
  <h3>Access tokens</h3>
  <table class="model-table with-hover">
    <tbody>${rows}</tbody>
  </table>
</div>`
}

// The Account tab pairs the General page HTML with the domain-list HTML.
export const sampleDnsimpleAccount = (g: SampleGen, config: SampleConfig): DnsimpleAccountRaw => {
  const company = g.company()
  const owner = g.person(0)
  const billing = g.person(1)

  const accountHtml = `
<section class="col">
  <div class="action-card">
    <h3>Account</h3>
    <table>
      <tr><td class="pr3">Name</td><td>${company}</td></tr>
      <tr><td>Notification email</td><td>${owner.email}</td></tr>
      <tr><td class="pr3">Account Identifier</td><td>${g.id('acct')}</td></tr>
    </table>
    <div class="action-card-container"><table><tr><td class="pr3">Country</td><td>Canada</td></tr></table></div>
  </div>
  <div class="action-card">
    <h3>Notifications</h3>
    <p class="b mt2 mb0">Account notifications will be sent to:</p>
    <p>${owner.email}</p>
    <p class="b mt2 mb0">Billing notifications will be sent to:</p>
    <p>${billing.email}</p>
  </div>
</section>`

  const domainRow = (name: string, status: string, expiresOn: string, autoRenew: string): string => `
  <tr>
    <td><a href="/a/00000/domains/${name}">${name}</a></td>
    <td><span class="status">${status}</span></td>
    <td>${expiresOn ? `<time datetime="${expiresOn}">x</time>` : ''}</td>
    <td>${autoRenew}</td>
  </tr>`

  const domains = g
    .repeat(Math.max(2, Math.min(config.documents, 8)), (i) => {
      const name = `${g.orgSlug()}-${i}.${g.pick(['example', 'test'])}`
      const registered = g.bool(0.7)

      return domainRow(
        name,
        registered ? 'Registered' : 'Hosted',
        registered ? g.dayString(g.int(60, 400)) : '',
        registered ? 'Auto-renew on' : ''
      )
    })
    .join('\n')

  const domainsHtml = `
<table class="model-table with-hover domains-table">
  <tbody>${domains}</tbody>
</table>`

  return { accountHtml, domainsHtml }
}
