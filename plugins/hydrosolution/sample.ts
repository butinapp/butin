// Synthetic sample GENERATORS for the demo seed — each builds the raw HTML bundle a capability's `fetch`
// returns, purely from the seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through
// the SAME cheerio parsers + `build` the live collector uses. The `documents` knob scales the bill count.
//
// The portal serves no JSON — the wire shape IS server-rendered HTML, so the samples are structurally faithful
// HTML strings (the same selectors the parsers walk) with synthetic data. The repo is public.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { HydroBillingRaw, HydroEquipmentRaw } from './main.js'

// 'YYYY-MM-DD' (g.dayString) → 'DD-MM-YYYY' (the portal's French date format the parser reverses).
const frDate = (day: string): string => {
  const [y, m, d] = day.split('-')

  return `${d}-${m}-${y}`
}

// A `#billsTable` grid row: a date / amount / number / view-link cell quartet. The amount is a French "18.79$"
// string and the PDF href is the relative `?getBillPDF&billID=…` link the parser makes absolute.
const billRow = (date: string, amount: string, number: string): string =>
  `<div class="gh_date">${date}</div><div class="gh_montant"><b>${amount}$</b></div>` +
  `<div class="gh_facture">${number}</div>` +
  `<div class="gh_btn"> <a target="_blank" class="bouton" href="?getBillPDF&billID=${number}">Afficher</a></div>`

export const sampleHydroBilling = (g: SampleGen, config: SampleConfig): HydroBillingRaw => {
  const months = Math.max(1, Math.min(config.documents, 36))
  const account = String(g.int(10_000_000_000, 99_999_999_999))
  const amount = g.moneyStr(15, 25)

  const bills = g
    .repeat(months, (i) => billRow(frDate(`${g.monthsAgo(i).yearMonth}-01`), g.moneyStr(15, 25), g.id('bill')))
    .join('\n    ')

  const facturesHtml = `
<div class="box-detail">
  <p class="esLabel"><span>Numéro de compte : </span>${account}</p>
  <div class="grid_historique" id="billsTable">
    <div class="gh_titre">Date</div><div class="gh_titre">Montant</div><div class="gh_titre">Numéro de facture</div><div class="gh_titre"> </div>
    ${bills}
  </div>
</div>`

  const fr = (n: string) => n.replace('.', ',')
  const landingHtml = `
<div id="ec_content"><div class="ec_dashboard">
  <div class="dash_box" id="dash_compte">
    <p>Solde précédent <span class="floatRight">${fr(amount)} $</span></p>
    <p>Paiements et/ou crédits<br />depuis le dernier relevé <span class="floatRight">${fr(amount)} $</span></p>
    <p>Frais actuels <span class="floatRight">${fr(amount)} $</span></p>
    <p>Dernier montant dû <span class="floatRight">${fr(amount)} $</span></p>
    <p>Date d'échéance <span class="floatRight">${frDate(g.dayString(0))}</span></p>
  </div>
  <div class="dash_box" id="dash_equipements">
    <div class="text-center">
      <a class="esButton seeEquipmentDetailButton" href="https://www.hydrosolution.com/espace-client/detail-espace-client/?account=${g.id('')}">Voir le détail</a>
    </div>
  </div>
</div></div>`

  return { facturesHtml, landingHtml }
}

export const sampleHydroEquipment = (g: SampleGen): HydroEquipmentRaw => ({
  detailHtml: `
<div id="details_equipement">
  <div id="installationAddress" class="dash_box">
    <h3 class="esBlockTitle maison">Adresse de l'installation</h3>
    <p><span class="esLabel">Adresse complète</span><br /> ${g.address()} </p>
    <div class="separateur"></div>
    <p><span class="esLabel">Type de logement</span><br /> ${g.pick(['Condominium', 'Maison', 'Appartement'])} </p>
  </div>
  <div id="esEquipementsServicesDetails" class="dash_box">
    <h3 class="esBlockTitle equipement">Équipements et services</h3>
    <p><span class='esLabel'>CH-EAU 40 GAL </span><br /> Numéro de série : ${g.int(1_000_000, 9_999_999)} <br />
      <span class="esLabel small">Installation</span><br /><span class="smallText">${frDate(g.dayString(2_000))}</span></p>
    <div class="separateur"></div>
    <p><span class="esLabel">Garantie restante sur la main d'oeuvre : ILLIMITÉ</span></p>
    <p><span class="esLabel">Garantie restante sur le réservoir : ILLIMITÉ</span></p>
    <p><span class="esLabel">Garantie restante sur les pièces : ILLIMITÉ</span></p>
    <div class="separateur"></div><p>Cet équipement est en <span class='esLabel'>Location à ${g.moneyStr(12, 20)}$/mois</span></p>
  </div>
</div>`
})
