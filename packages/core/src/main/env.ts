import { app } from 'electron'
import { resolve } from 'node:path'

// The single place the main process reads `process.env`. Every environment knob is declared, defaulted, and
// typed here once, so call sites import a typed value instead of reaching into `process.env` (no defaults
// drifting between sites, every knob discoverable in one file). Main-process only — `@butinapp/sdk` and
// `@butinapp/ui` stay env-free so they remain pure and embeddable.
export const env = {
  // Relocates the entire store (config + data + the profiles registry) off the real ~/butin — for an
  // isolated dev/test run that must not read or mutate it (the Playwright drive harness sets it). Undefined
  // means the default ~/butin; the home default itself stays in profiles.ts. Resolved to an ABSOLUTE path so
  // a relative BUTIN_HOME (e.g. ./.demo-home) still reveals/opens correctly — shell.openPath needs absolute.
  home: process.env.BUTIN_HOME ? resolve(process.env.BUTIN_HOME) : undefined,

  // Opt-in DevTools-protocol endpoint for driving the app from a CDP client. The open port relaxes the
  // Chromium sandbox, so it must stay off for a shipped build.
  remoteDebug: Boolean(process.env.BUTIN_REMOTE_DEBUG),
  remoteDebugPort: process.env.BUTIN_REMOTE_DEBUG_PORT ?? '9222',

  // Overrides the timezone every day/month bucket is computed in (the SDK reporting zone). Undefined means the
  // OS zone — the right default so "this month" follows the user's wall clock. An explicit IANA name pins it for
  // a deterministic run (the drive/seed harness), so buckets don't drift with the machine the run happens on.
  reportingZone: process.env.BUTIN_REPORTING_ZONE,

  // A development run: electron-vite dev, the built-but-unpackaged app the drive/smoke harness launches, and
  // tests (where `app` is absent). A plugin contract violation throws loudly in dev so the author sees it
  // immediately; a packaged build quarantines instead (keeps the last good report, surfaces a data-invalid
  // state) so one bad field never takes down a usable service. Keyed on the package, not NODE_ENV — the main
  // bundle ships with `process.env.NODE_ENV` unset, so a NODE_ENV check would read as dev in production.
  isDev: !app?.isPackaged
} as const
