// Loaded before every renderer (jsdom) test (see vitest.config.ts). Registers jest-dom's matchers on vitest's
// `expect` (and their type augmentation) and unmounts rendered trees between tests so the jsdom document stays clean.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom lacks the Pointer Capture + scrollIntoView APIs radix primitives (Popover/Select) call when opening —
// without these, interaction tests on those components throw. No-op shims are enough for the tests.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

afterEach(() => {
  cleanup()
})
