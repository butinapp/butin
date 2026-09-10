import { toast } from 'sonner'

import type { Result } from '../shared/ipc.js'

// Surface a failed IPC `Result` to the user, and say whether it failed — so a caller reads as
// `if (failed(res)) return null` and keeps whatever its own callback must return. A predicate rather than an
// unwrap: the call sites return `undefined`/`null`/`false`/nothing depending on what their mutation hands back,
// and an unwrapper would have to invent a sentinel that collides with a legitimately falsy `data`.
export const failed = <T>(res: Result<T>, fallback?: string): res is Extract<Result<T>, { ok: false }> => {
  if (res.ok) {
    return false
  }

  toast.error(res.error || fallback || 'Something went wrong')

  return true
}
