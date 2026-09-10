import { validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import { githubEnterprisePlugin } from './main.js'

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(githubEnterprisePlugin)).toEqual([])
})
