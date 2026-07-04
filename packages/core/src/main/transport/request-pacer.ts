// Pace outbound provider requests: serialize the requests to each provider host and insert a jittered
// 100–500ms gap between consecutive dispatches, so the tool adds a light, steady trickle of load instead of
// bursting (many collectors fan out with Promise.all). On by default — being a gentle client is the baseline;
// disabling it trades that courtesy for raw refresh speed. Cache hits never reach here (RequestCache returns
// the shared in-flight/settled promise without invoking the fetch), so only real network fetches are paced.

const MIN_GAP_MS = 100
const MAX_GAP_MS = 500

let enabled = true

// Set from the persisted app setting at startup and whenever it changes.
export const configureRequestPacing = (on: boolean): void => {
  enabled = on
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const jitterGap = (): number => MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS + 1))

// Per-host chain of release "gates". Each gate resolves a jittered gap after the previous one, so concurrent
// callers to the same host are released one after another, spaced out. The gate is released BEFORE the fetch
// runs (and `fn`'s outcome never feeds back into the chain), so a slow or failing response can't stall or
// poison the pacing — the gap is purely between dispatch starts.
const tails = new Map<string, Promise<void>>()

// `onWait` (when paced) reports the ACTUAL delay this request incurred — its jittered gap plus any time spent
// queued behind earlier same-host requests — so callers can log the real pacing cost, not just the nominal
// gap. Not called when pacing is disabled (no wait happened).
export const paceRequest = async <T>(key: string, fn: () => Promise<T>, onWait?: (ms: number) => void): Promise<T> => {
  if (!enabled) {
    return fn()
  }

  const previous = tails.get(key) ?? Promise.resolve()
  const gate = previous.then(() => sleep(jitterGap()))

  tails.set(key, gate)
  const t0 = Date.now()

  await gate
  onWait?.(Date.now() - t0)

  return fn()
}

// Test seam: reset the gate chains + re-enable. Production never calls this.
export const __resetRequestPacing = (): void => {
  tails.clear()
  enabled = true
}
