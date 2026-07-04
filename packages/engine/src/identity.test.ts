import { describe, expect, it } from 'vitest'

import { BROWSER_UA, SEC_CH_UA_HEADERS } from './identity.js'

describe('browser identity', () => {
  it('presents as Google Chrome, not Electron', () => {
    expect(BROWSER_UA).toContain('Chrome/')
    expect(BROWSER_UA).not.toContain('Electron')
  })

  it('derives the Sec-Ch-Ua version from the same major as the UA string', () => {
    const major = BROWSER_UA.match(/Chrome\/(\d+)/)?.[1]

    expect(major).toBeTruthy()
    expect(SEC_CH_UA_HEADERS['Sec-Ch-Ua']).toContain(`"Google Chrome";v="${major}"`)
  })
})
