// Bucket invoices onto a continuous YYYY-MM axis from the earliest invoice through the latest (or the
// current month), gaps filled with 0 so a month with no spend stays an aligned slot instead of
// collapsing. Single series, no year picker. `nowMonth` is passed in to keep this pure/testable.
import { round2 } from '@butinapp/sdk/util'
import { groupBy, sumBy } from 'lodash-es'
import { DateTime } from 'luxon'

export interface MonthBucket {
  month: string
  amount: number
}

const monthOf = (date: string): string => date.slice(0, 7)

export const monthRange = (start: string, end: string): string[] => {
  const out: string[] = []
  const last = DateTime.fromFormat(end, 'yyyy-MM', { zone: 'utc' })

  for (let m = DateTime.fromFormat(start, 'yyyy-MM', { zone: 'utc' }); m <= last; m = m.plus({ months: 1 })) {
    out.push(m.toFormat('yyyy-MM'))
  }

  return out
}

export const monthlyBuckets = (invoices: Array<{ date?: string; amount: number }>, nowMonth: string): MonthBucket[] => {
  const dated = invoices.filter(
    (inv): inv is { date: string; amount: number } => typeof inv.date === 'string' && inv.date.length >= 7
  )

  if (dated.length === 0) {
    return []
  }

  const months = dated.map((inv) => monthOf(inv.date)).sort()
  const start = months[0]!
  let end = months[months.length - 1]!

  if (nowMonth > end) {
    end = nowMonth
  }

  const byMonth = groupBy(dated, (inv) => monthOf(inv.date))

  return monthRange(start, end).map((month) => ({
    month,
    amount: round2(sumBy(byMonth[month] ?? [], (inv) => inv.amount))
  }))
}
