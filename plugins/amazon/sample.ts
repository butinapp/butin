// Synthetic sample generator for the demo seed — builds raw Amazon orders purely from the seeded toolkit (no
// literal data), drawn through the SAME build the live collector uses. The `documents` knob scales the order
// count; each order carries a popover URL (the lazy invoice-PDF source the fetchFile resolves on download).

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { AmazonOrder } from './main.js'

const PRODUCTS = [
  'USB-C to USB-C Cable (6ft, 2-Pack)',
  'Portable Power Bank 25,000mAh',
  'AA Batteries (24-Count)',
  'Smart Wi-Fi Dimmer Switch',
  'Stainless Kitchen Shears',
  'Mechanical Keyboard, Hot-Swap',
  'HDMI 2.1 Switch, 4K 120Hz',
  'Noise-Cancelling Headphones',
  'Office Chair Floor Mat',
  'LED Desk Lamp, Dimmable'
]

export const sampleAmazonBilling = (g: SampleGen, config: SampleConfig): AmazonOrder[] =>
  g.repeat(Math.min(config.documents, 36), (i) => {
    const orderId = `${g.int(100, 999)}-${g.int(1000000, 9999999)}-${g.int(1000000, 9999999)}`

    return {
      orderId,
      date: `${g.monthsAgo(i).yearMonth}-12`,
      total: g.money(15, 320),
      // Mostly the account owner, with the occasional gift shipped to someone else.
      recipient: (i % 5 === 0 ? g.person(i) : g.person(0)).name,
      items: g.repeat(g.int(1, 3), () => g.pick(PRODUCTS)),
      popoverUrl: `/your-orders/invoice/popover?orderId=${orderId}&relatedRequestId=${g.id('req')}&ref_=fed_invoice_ajax`
    }
  })
