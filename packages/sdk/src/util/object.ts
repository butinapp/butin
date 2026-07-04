// Drop keys whose value is `undefined` (keeps null/0/'' /false). Used when assembling wire objects so an
// absent optional field is omitted rather than serialized as `undefined`.
export const omitUndef = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

// A parsed wire value as a typed array, or [] when it isn't one — the guard every `build*()` repeats against a
// JSON payload whose "list" field can arrive missing, null, or (the classic trap) a name-keyed object. The
// element type is the caller's claim about the rows; pass it explicitly: `asArray<RawFoo>(payload.items)`.
export const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
