import { expect, test, vi } from 'vitest'

import type { Result } from '../shared/ipc.js'

const error = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (m: string) => error(m) } }))

const { failed } = await import('./result-toast.js')

test('an ok result is not a failure and shows nothing', () => {
  expect(failed({ ok: true, data: 1 })).toBe(false)
  expect(error).not.toHaveBeenCalled()
})

test('a failed result surfaces its error and reports the failure', () => {
  expect(failed({ ok: false, error: 'profile is locked' })).toBe(true)
  expect(error).toHaveBeenCalledWith('profile is locked')
})

test('a failure with no message falls back, so the user never sees an empty toast', () => {
  failed({ ok: false, error: '' }, 'Could not duplicate the profile.')
  expect(error).toHaveBeenLastCalledWith('Could not duplicate the profile.')

  failed({ ok: false, error: '' })
  expect(error).toHaveBeenLastCalledWith('Something went wrong')
})

test('narrows the result, so a caller keeps the ok branch typed', () => {
  const res: Result<{ id: string }> = { ok: true, data: { id: 'p1' } }

  // The point of the predicate: after the guard, `res.data` is reachable without a cast.
  expect(failed(res) ? null : res.data.id).toBe('p1')
})
