import { DateTime } from '../libs.js'

// Date→string helpers shared across plugins. Vendors hand us ISO datetimes, epoch ms, or epoch seconds;
// the data-view contract wants plain 'YYYY-MM-DD' day keys. Normalize at the edge here so each plugin's
// build*() stays free of ad-hoc date slicing.
// Milliseconds in a calendar day — the shared unit for day-arithmetic across plugins, core, and the UI.
export const MS_PER_DAY = 86_400_000

// English short month names, indexed by 0-based month — the compact 'Jan'…'Dec' labels for month-keyed series.
export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The single timezone every day/month BUCKET is computed in — so "this month", a per-day series, and the values
// each plugin books all agree on where the boundary sits. Defaults to 'utc' so the pure helpers (and every plugin
// fixture that asserts a day) stay deterministic regardless of the test runner's OS zone; the running app calls
// setReportingZone with the OS zone at boot, so buckets follow the user's wall clock and roll at their local
// midnight. An IANA name ('America/New_York'), 'system', or 'utc'.
let reportingZone = 'utc'

export const setReportingZone = (zone: string): void => {
  reportingZone = zone
}
export const getReportingZone = (): string => reportingZone

// Trim an ISO datetime string to its 'YYYY-MM-DD' day, keeping the day AS WRITTEN (no zone conversion) — for a
// vendor field that is already the intended calendar day. To bucket a real instant into the reporting zone, use
// `dayOf`/`epochMsDay`. Empty/missing → undefined.
export const isoDay = (value?: string | null): string | undefined => (value ? value.slice(0, 10) : undefined)

// Epoch milliseconds → 'YYYY-MM-DD' in the reporting zone. 0/missing/invalid → undefined.
export const epochMsDay = (ms?: number | null): string | undefined => {
  if (!ms) {
    return undefined
  }

  const d = DateTime.fromMillis(ms, { zone: reportingZone })

  return d.isValid ? d.toISODate()! : undefined
}

// Epoch seconds → reporting-zone 'YYYY-MM-DD' (most token/activity APIs report seconds). 0/missing/invalid → undefined.
export const epochSecDay = (seconds?: number | null): string | undefined =>
  epochMsDay(seconds == null ? undefined : seconds * 1000)

// ISO datetime (Z or tz-offset) → its 'YYYY-MM-DD' day in the reporting zone. Reparses through the instant so an
// offset datetime lands on the correct zoned day, where the slice-based `isoDay` would keep the day as written.
// Missing/unparseable → undefined.
export const dayOf = (value?: string | null): string | undefined => epochMsDay(value ? Date.parse(value) : undefined)

// 'YYYY-MM' month key from a 1-based month.
export const monthKey = (year: number, month: number): string => `${year}-${String(month).padStart(2, '0')}`

// 'YYYY-MM' month key of `now` in the reporting zone — the current calendar month.
export const currentMonthKey = (now = new Date()): string =>
  DateTime.fromJSDate(now, { zone: reportingZone }).toFormat('yyyy-MM')

// 'YYYY-MM-DD' for `days` before `day` (a UTC 'YYYY-MM-DD'). Day-string arithmetic goes through luxon, so callers
// never re-roll millisecond math; invalid input returns `day` unchanged.
export const dayMinus = (day: string, days: number): string =>
  DateTime.fromISO(day, { zone: 'utc' }).minus({ days }).toISODate() ?? day

// UTC 'YYYY-MM-DD' for N days before now.
export const utcDaysAgo = (days: number): string => new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, 10)

// Full UTC ISO datetime N days before `now` — the start of a since-window passed to usage/event APIs.
export const isoDaysAgo = (days: number, now = new Date()): string =>
  new Date(now.getTime() - days * MS_PER_DAY).toISOString()

// First day of `now`'s month in the reporting zone, as 'YYYY-MM-DD'.
export const monthStart = (now = new Date()): string =>
  DateTime.fromJSDate(now, { zone: reportingZone }).startOf('month').toISODate()!
