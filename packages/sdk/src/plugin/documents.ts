// Bytes for one downloaded file. The plain Uint8Array form lets core derive the filename from the row's
// name + ext; the object form lets a plugin override the basename / content-type (e.g. a server-supplied
// filename). Returned by a capability's `fetchFile(ctx, row)` hook (see Capability) for table views
// that declare a `{ fetch: true }` files source (POST/multi-step downloads).
export type DocumentBytes = Uint8Array | { data: Uint8Array; filename?: string; mime?: string }
