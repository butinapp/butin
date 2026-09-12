import { describe, expect, it } from 'vitest'

import { reduceUpdateEvent, updaterAvailability } from './update-state.js'

describe('reduceUpdateEvent', () => {
  it('enters checking when a check starts', () => {
    expect(reduceUpdateEvent({ kind: 'idle' }, { type: 'checking' })).toEqual({ kind: 'checking' })
  })

  it('an available update starts a download at zero percent', () => {
    expect(reduceUpdateEvent({ kind: 'checking' }, { type: 'available', version: '0.3.0' })).toEqual({
      kind: 'downloading',
      version: '0.3.0',
      percent: 0
    })
  })

  it('progress keeps the version and rounds the percent', () => {
    const downloading = { kind: 'downloading', version: '0.3.0', percent: 0 } as const

    expect(reduceUpdateEvent(downloading, { type: 'progress', percent: 43.6 })).toEqual({
      kind: 'downloading',
      version: '0.3.0',
      percent: 44
    })
  })

  it('a downloaded update is ready under its version', () => {
    const downloading = { kind: 'downloading', version: '0.3.0', percent: 99 } as const

    expect(reduceUpdateEvent(downloading, { type: 'downloaded', version: '0.3.0' })).toEqual({
      kind: 'ready',
      version: '0.3.0'
    })
  })

  it('no newer release records when the check ran', () => {
    expect(reduceUpdateEvent({ kind: 'checking' }, { type: 'not-available', at: '2026-09-11T12:00:00.000Z' })).toEqual({
      kind: 'upToDate',
      checkedAt: '2026-09-11T12:00:00.000Z'
    })
  })

  it('an error carries its message', () => {
    expect(
      reduceUpdateEvent({ kind: 'checking' }, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
    ).toEqual({ kind: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
  })

  it('a ready update is never lost to a later error', () => {
    const ready = { kind: 'ready', version: '0.3.0' } as const

    expect(reduceUpdateEvent(ready, { type: 'error', message: 'boom' })).toEqual(ready)
  })
})

describe('updaterAvailability', () => {
  it('a dev run has no updater', () => {
    expect(updaterAvailability({ isDev: true, platform: 'win32', appImage: undefined })).toBe('dev')
  })

  it('a Linux run outside the AppImage has nothing to replace', () => {
    expect(updaterAvailability({ isDev: false, platform: 'linux', appImage: undefined })).toBe('not-appimage')
  })

  it('a packaged build updates', () => {
    expect(updaterAvailability({ isDev: false, platform: 'darwin', appImage: undefined })).toBeNull()
    expect(updaterAvailability({ isDev: false, platform: 'linux', appImage: '/opt/Butin.AppImage' })).toBeNull()
  })
})
