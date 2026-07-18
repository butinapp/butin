// How a `RequestOptions.body` becomes wire bytes. Both transports share this so a body encodes identically
// whichever engine a plugin declares.
//
// A binary body is ALREADY the exact payload the service expects (a gRPC-Web frame, a protobuf message, raw
// upload bytes) and goes out verbatim. It must never be JSON-encoded: `JSON.stringify(buffer)` yields
// `{"type":"Buffer","data":[…]}`, which a binary endpoint answers with an undecodable body rather than an
// error — the failure surfaces as empty data, not a thrown request. Anything else object-shaped is a JSON
// document; a string is already its own body.

export interface EncodedBody {
  // The exact text/bytes to write; undefined when the request carries no body.
  data?: string | Buffer
  // True only for a JSON document, so the caller defaults Content-Type to application/json. Binary declares
  // its own content type (the plugin knows it); a raw string is never assumed to be JSON.
  isJson: boolean
  // A stable string identifying this body in the request cache; binary keys off its base64.
  cacheKey?: string
}

export const encodeBody = (body: unknown): EncodedBody => {
  if (body === undefined) {
    return { isJson: false }
  }

  if (typeof body === 'string') {
    return { data: body, isJson: false, cacheKey: body }
  }

  // Buffer is itself an ArrayBuffer view, so this covers Buffer/Uint8Array/DataView in one branch. The view's
  // offset+length are honoured so a slice of a pooled buffer sends only its own bytes.
  if (ArrayBuffer.isView(body)) {
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength)

    return { data: bytes, isJson: false, cacheKey: bytes.toString('base64') }
  }

  if (body instanceof ArrayBuffer) {
    const bytes = Buffer.from(body)

    return { data: bytes, isJson: false, cacheKey: bytes.toString('base64') }
  }

  if (typeof body === 'object') {
    const json = JSON.stringify(body)

    return { data: json, isJson: true, cacheKey: json }
  }

  const text = String(body)

  return { data: text, isJson: false, cacheKey: text }
}
