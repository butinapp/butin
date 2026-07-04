import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { setDataRoot } from '../store/store.js'

import { DEFAULT_ALERT_CONFIG, getAlertConfig, setAlertConfig } from './alerts-config.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-alertcfg-'))
  setDataRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('returns defaults when nothing is stored', async () => {
  expect(await getAlertConfig()).toEqual(DEFAULT_ALERT_CONFIG)
})

test('round-trips a saved config', async () => {
  const cfg = { change: { dod: {}, wow: {}, mom: { spend: 10 } }, health: { fxMissing: false } }

  await setAlertConfig(cfg)
  expect(await getAlertConfig()).toEqual(cfg)
})
