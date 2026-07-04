// Shared transport timing knobs. Both clients bound every request so a stalled connection (Cloudflare holding
// the socket, no response and no error) settles into a clear error the panel can show — instead of leaving the
// collector and the UI's "Fetching…" pending forever. axios defaults to no timeout (0); net.request has none.
// The default ceiling for a single request; a collector that runs a known-heavy query (a wide usage aggregation
// that the dashboard itself paginates) overrides it per call via `RequestOptions.timeout`.
export const REQUEST_TIMEOUT_MS = 60_000
