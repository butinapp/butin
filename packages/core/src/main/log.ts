import { MS_PER_DAY } from '@butinapp/sdk/util'
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { LogEntryDto, LogLevel } from '../shared/ipc.js'

// In-process logger: every line that passes the level gate goes to the console (terminal/devtools), a capped
// in-memory ring buffer the Logs view reads (live view), AND a daily file under ~/butin/logs/ (for
// post-mortem — pruned by the retention setting). Deliberately tiny — no electron-log dependency, no
// transports. File writes are skipped off-Electron (tests) so a `vitest` run never touches the real home.
//
// Three ways in: the `log.*` helpers (positional scope tag), `createLogger(binding)` child loggers (a fixed
// scope/plugin/action bound once — what plugin collect + the net layer use so their origin lands in
// structured fields, not the message), and — once installConsoleCapture() runs — EVERY console.* call across
// main + plugins, so nothing logged anywhere is invisible to the panel.

const RING_CAP = 2000

// Severity order — a line is emitted only when its level is >= the effective threshold for its origin.
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

// The real console methods, captured BEFORE installConsoleCapture() patches them — push() always prints
// through these, so patched console.* → push() → ORIGINAL.* can never recurse.
const ORIGINAL: Record<LogLevel, (...a: unknown[]) => void> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

const ring: LogEntryDto[] = []
let seqCounter = 0

// The level gate. `globalLevel` is the floor for everything; `overrides` (keyed by plugin id or scope tag)
// lifts/lowers one source so a noisy plugin can go to debug without flooding the rest. Set at bootstrap from
// settings and on every change — live, no restart. Default 'info' so a `log.*` call before setLogLevels()
// (and every test) still emits info/warn/error.
let globalLevel: LogLevel = 'info'
let overrides: Record<string, LogLevel> = {}

export const setLogLevels = (level: LogLevel, levelOverrides: Record<string, LogLevel> = {}): void => {
  globalLevel = level
  overrides = levelOverrides
}

// Daily-file persistence gate. Logs are in-memory only (the ring buffer is the live view) until a positive
// retention window is set in Settings → Advanced; only then are daily files written and pruned. Set at
// bootstrap and whenever the retention setting changes. Off by default so nothing touches disk unasked.
let fileLogging = false

export const setLogRetention = (retentionDays: number): void => {
  fileLogging = retentionDays > 0
}

// What an origin binds: a subsystem scope and/or a plugin + action. Used to compute the threshold and to tag
// the entry. All optional — a bare console.* capture binds nothing and follows the global level.
type LogBinding = { scope?: string; plugin?: string; action?: string }

// The minimum level that passes for a binding: the most specific override (by plugin, else scope), else the
// global level.
const thresholdFor = (binding: LogBinding): LogLevel => {
  if (binding.plugin && overrides[binding.plugin]) {
    return overrides[binding.plugin]
  }

  if (binding.scope && overrides[binding.scope]) {
    return overrides[binding.scope]
  }

  return globalLevel
}

// Logs live under ~/butin/logs (same home as every other captured artifact — never the repo / OneDrive).
let logRoot = join(homedir(), 'butin', 'logs')

// Test seam pointing the log dir at a temp path; file writes are also gated on Electron.
export const setLogRoot = (dir: string): void => {
  logRoot = dir
}

const isElectron = Boolean(process.versions.electron)

const logFile = (): string => join(logRoot, `butin-${new Date().toISOString().slice(0, 10)}.log`)

export const logFilePath = (): string => logFile()
export const logDir = (): string => logRoot

// Render one arg to a string without ever throwing (circular refs / weird objects must not break a log call).
const stringifyArg = (a: unknown): string => {
  if (a instanceof Error) {
    return a.stack ?? a.message
  }

  if (typeof a === 'string') {
    return a
  }

  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

// The plain-text origin tag for the daily file: `[scope] {plugin/action}` (whichever are present).
const originTag = (entry: LogEntryDto): string => {
  const tags: string[] = []

  if (entry.scope) {
    tags.push(`[${entry.scope}]`)
  }

  if (entry.plugin) {
    tags.push(`{${entry.plugin}${entry.action ? `/${entry.action}` : ''}}`)
  }

  return tags.length > 0 ? `${tags.join(' ')} ` : ''
}

// The single sink. Wrapped so a logging failure can never propagate to the caller (a patched console.* must
// behave exactly like the original from the caller's perspective).
const push = (level: LogLevel, binding: LogBinding, args: unknown[], data?: Record<string, unknown>): void => {
  try {
    // Source-gate: below threshold → never emitted (no ring, no file, no console).
    if (LEVELS[level] < LEVELS[thresholdFor(binding)]) {
      return
    }

    const message = args.map(stringifyArg).join(' ')
    const entry: LogEntryDto = { seq: ++seqCounter, ts: new Date().toISOString(), level, message }

    if (binding.scope) {
      entry.scope = binding.scope
    }

    if (binding.plugin) {
      entry.plugin = binding.plugin
    }

    if (binding.action) {
      entry.action = binding.action
    }

    if (data) {
      entry.data = data
    }

    ring.push(entry)

    if (ring.length > RING_CAP) {
      ring.shift()
    }

    const tag = originTag(entry).trimEnd()

    ORIGINAL[level](...(tag ? [tag] : []), ...args, ...(data ? [data] : []))

    // Persist every emitted level to the daily file so a past issue is reconstructable — daily rotation +
    // pruning bound the size. Only when a retention window is set (off by default: in-memory ring only).
    // Skipped off-Electron so tests never touch the home.
    if (isElectron && fileLogging) {
      mkdirSync(logRoot, { recursive: true })
      appendFileSync(
        logFile(),
        `${entry.ts} ${level.toUpperCase()} ${originTag(entry)}${message}${data ? ` ${stringifyArg(data)}` : ''}\n`
      )
    }
  } catch {
    // Logging must never throw — drop this line rather than break the caller.
  }
}

// scope is an optional subsystem tag ('plugins', 'magic:claude', 'ipc') shown in the panel + file.
export const log = {
  debug: (scope: string | undefined, ...args: unknown[]) => push('debug', { scope }, args),
  info: (scope: string | undefined, ...args: unknown[]) => push('info', { scope }, args),
  warn: (scope: string | undefined, ...args: unknown[]) => push('warn', { scope }, args),
  error: (scope: string | undefined, ...args: unknown[]) => push('error', { scope }, args)
}

// A logger bound to a fixed origin (plugin + action, or a scope) so every line it emits carries those as
// structured fields. `data` is optional structured context kept on the entry (shown expandable in the
// viewer) and printed to the terminal. This is what plugin collect (`ctx.log`) and the net layer use.
export type Logger = {
  debug: (message: unknown, data?: Record<string, unknown>) => void
  info: (message: unknown, data?: Record<string, unknown>) => void
  warn: (message: unknown, data?: Record<string, unknown>) => void
  error: (message: unknown, data?: Record<string, unknown>) => void
}

export const createLogger = (binding: LogBinding): Logger => {
  const make =
    (level: LogLevel) =>
    (message: unknown, data?: Record<string, unknown>): void =>
      push(level, binding, [message], data)

  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') }
}

let captured = false

// Electron prints a raw console.error for every failed subresource/child-window load — e.g. a cross-domain
// SSO handoff iframe blocked by ERR_BLOCKED_BY_RESPONSE — plus the Node "--trace-warnings" hint. Uncaptured,
// those bind no origin and surface as unscoped lines that read as unhandled app failures. Tag them to an
// 'electron' scope (so they're attributed + filterable) while keeping their natural level — an error stays
// an error. Failures the app owns are still logged scoped by their layer (magic:* / net).
const ELECTRON_LOAD_NOISE = /Failed to load URL|--trace-warnings/

const captureConsole = (level: LogLevel, args: unknown[]): void => {
  if (typeof args[0] === 'string' && ELECTRON_LOAD_NOISE.test(args[0])) {
    push(level, { scope: 'electron' }, args)

    return
  }

  push(level, {}, args)
}

// Route EVERY console.* through the buffer + file (one-time, idempotent). console.log/info → info,
// warn → warn, error → error, debug → debug. Captured lines bind no origin (so they follow the global
// level), except the Electron load-failure noise above, which is tagged to the 'electron' scope at its
// natural level. Each prints to the terminal via ORIGINAL.* inside push.
export const installConsoleCapture = (): void => {
  if (captured) {
    return
  }

  captured = true
  console.log = (...a: unknown[]) => captureConsole('info', a)
  console.info = (...a: unknown[]) => captureConsole('info', a)
  console.warn = (...a: unknown[]) => captureConsole('warn', a)
  console.error = (...a: unknown[]) => captureConsole('error', a)
  console.debug = (...a: unknown[]) => captureConsole('debug', a)
}

// Delete daily log files older than `retentionDays`. retentionDays <= 0 is the session-only mode (no files
// are written, so there's nothing to prune). Best-effort — a missing logs dir or an undeletable file is
// ignored. Called at bootstrap and when the setting changes.
export const pruneLogs = (retentionDays: number): void => {
  if (!isElectron || retentionDays <= 0) {
    return
  }

  try {
    const cutoff = Date.now() - retentionDays * MS_PER_DAY

    for (const name of readdirSync(logRoot)) {
      const match = /^butin-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
      const day = match ? Date.parse(match[1]) : Number.NaN

      if (!Number.isNaN(day) && day < cutoff) {
        unlinkSync(join(logRoot, name))
      }
    }
  } catch {
    // logs dir may not exist yet, or a file is locked — nothing to prune, no-op.
  }
}

// Newest-last snapshot of the ring for the Logs view.
export const getRecentLogs = (): LogEntryDto[] => [...ring]

// Empty the in-memory ring (the on-disk daily files are untouched). Backs the Logs view "Clear" action.
export const clearLogs = (): void => {
  ring.length = 0
}
