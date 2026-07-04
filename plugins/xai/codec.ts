// Protobuf wire-format codec + gRPC-Web framing (pure). xAI's console serves all data over
// `application/grpc-web+proto` with no `.proto` schema, so requests are hand-encoded from observed field
// numbers and responses are walked generically by field number. This self-contained module is the codec both
// the live collector (main.ts) and the synthetic samples (sample.ts) build on — keeping it free of either
// avoids an import cycle when sample.ts synthesizes a raw payload through the real encode/decode path.
// Wire types: 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit.

const WIRE_VARINT = 0
const WIRE_I64 = 1
const WIRE_LEN = 2
const WIRE_I32 = 5

export type WireValue =
  | { kind: 'varint'; value: bigint }
  | { kind: 'len'; bytes: Buffer }
  | { kind: 'i64'; bytes: Buffer }
  | { kind: 'i32'; bytes: Buffer }

// A decoded message: field number → the (possibly repeated) values seen.
export type ProtoMessage = Map<number, WireValue[]>

// --- encoding (request building) ---

// Encode an unsigned varint (LEB128). Negative values use two's-complement 64-bit (protobuf int64).
export const encodeVarint = (value: number | bigint): Buffer => {
  let v = BigInt(value)

  if (v < 0n) {
    v += 1n << 64n
  }

  const out: number[] = []

  do {
    let byte = Number(v & 0x7fn)

    v >>= 7n

    if (v > 0n) {
      byte |= 0x80
    }

    out.push(byte)
  } while (v > 0n)

  return Buffer.from(out)
}

const encodeTag = (field: number, wire: number): Buffer => encodeVarint((field << 3) | wire)

// `field: varint` (wire type 0).
export const varintField = (field: number, value: number | bigint): Buffer =>
  Buffer.concat([encodeTag(field, WIRE_VARINT), encodeVarint(value)])

// `field: string` (wire type 2).
export const stringField = (field: number, value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8')

  return Buffer.concat([encodeTag(field, WIRE_LEN), encodeVarint(bytes.length), bytes])
}

// `field: <nested message>` (wire type 2).
export const messageField = (field: number, msg: Buffer): Buffer =>
  Buffer.concat([encodeTag(field, WIRE_LEN), encodeVarint(msg.length), msg])

// Concatenate field buffers into a single message body.
export const message = (...fields: Buffer[]): Buffer => Buffer.concat(fields)

// --- decoding (response walking) ---

const readVarint = (buf: Buffer, offset: number): [bigint, number] => {
  let shift = 0n
  let result = 0n
  let off = offset

  while (off < buf.length) {
    const byte = buf[off++]!

    result |= BigInt(byte & 0x7f) << shift

    if ((byte & 0x80) === 0) {
      return [result, off]
    }

    shift += 7n

    if (shift > 70n) {
      throw new Error('[xai] varint too long')
    }
  }

  throw new Error('[xai] truncated varint')
}

// Decode a protobuf message body into a field-number → values map.
export const decodeMessage = (buf: Buffer): ProtoMessage => {
  const out: ProtoMessage = new Map()
  let off = 0

  const push = (field: number, value: WireValue) => {
    const list = out.get(field)

    if (list) {
      list.push(value)
    } else {
      out.set(field, [value])
    }
  }

  while (off < buf.length) {
    let key: bigint

    ;[key, off] = readVarint(buf, off)
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)

    if (wire === WIRE_VARINT) {
      let value: bigint

      ;[value, off] = readVarint(buf, off)
      push(field, { kind: 'varint', value })
    } else if (wire === WIRE_LEN) {
      let len: bigint

      ;[len, off] = readVarint(buf, off)
      const end = off + Number(len)

      if (end > buf.length) {
        throw new Error('[xai] length-delimited field overruns buffer')
      }

      push(field, { kind: 'len', bytes: buf.subarray(off, end) })
      off = end
    } else if (wire === WIRE_I64) {
      if (off + 8 > buf.length) {
        throw new Error('[xai] truncated 64-bit field')
      }

      push(field, { kind: 'i64', bytes: buf.subarray(off, off + 8) })
      off += 8
    } else if (wire === WIRE_I32) {
      if (off + 4 > buf.length) {
        throw new Error('[xai] truncated 32-bit field')
      }

      push(field, { kind: 'i32', bytes: buf.subarray(off, off + 4) })
      off += 4
    } else {
      throw new Error(`[xai] unsupported wire type ${wire} for field ${field}`)
    }
  }

  return out
}

// --- typed accessors (navigate a decoded message by field number) ---

const firstOf = (msg: ProtoMessage, field: number): WireValue | undefined => msg.get(field)?.[0]

// First value of `field` as a JS number (varint).
export const getNumber = (msg: ProtoMessage, field: number): number | undefined => {
  const v = firstOf(msg, field)

  return v?.kind === 'varint' ? Number(v.value) : undefined
}

// First value of `field` as a UTF-8 string (length-delimited).
export const getString = (msg: ProtoMessage, field: number): string | undefined => {
  const v = firstOf(msg, field)

  return v?.kind === 'len' ? v.bytes.toString('utf8') : undefined
}

// First value of `field` decoded as a nested message.
export const getMessage = (msg: ProtoMessage, field: number): ProtoMessage | undefined => {
  const v = firstOf(msg, field)

  return v?.kind === 'len' ? decodeMessage(v.bytes) : undefined
}

// All length-delimited values of a repeated `field`, decoded as nested messages.
export const getRepeatedMessages = (msg: ProtoMessage, field: number): ProtoMessage[] => {
  const out: ProtoMessage[] = []

  for (const v of msg.get(field) ?? []) {
    if (v.kind === 'len') {
      out.push(decodeMessage(v.bytes))
    }
  }

  return out
}

// All UTF-8 string values of a repeated `field`.
export const getRepeatedStrings = (msg: ProtoMessage, field: number): string[] => {
  const out: string[] = []

  for (const v of msg.get(field) ?? []) {
    if (v.kind === 'len') {
      out.push(v.bytes.toString('utf8'))
    }
  }

  return out
}

// --- gRPC-Web framing ---

const TRAILER_FLAG = 0x80

// Wrap a message body in a single gRPC-Web data frame: `[0x00][len u32 BE][body]`.
export const frameMessage = (body: Buffer): Buffer => {
  const header = Buffer.alloc(5)

  header.writeUInt8(0, 0)
  header.writeUInt32BE(body.length, 1)

  return Buffer.concat([header, body])
}

export interface DeframedResponse {
  // The first non-trailer (data) frame body, if any.
  message?: Buffer
  // Parsed `grpc-status` from the trailer frame (0 = ok).
  grpcStatus?: number
  // Parsed `grpc-message` from the trailer frame, if present.
  grpcMessage?: string
}

// Split a gRPC-Web response into its data frame and trailer frame. The trailer frame (high bit of the flag
// byte set) carries `grpc-status` / `grpc-message` as an HTTP/1-style header block — a non-zero status means
// the call failed even though the HTTP response was 200.
export const deframeResponse = (buf: Buffer): DeframedResponse => {
  const result: DeframedResponse = {}
  let off = 0

  while (off + 5 <= buf.length) {
    const flag = buf.readUInt8(off)
    const len = buf.readUInt32BE(off + 1)
    const start = off + 5
    const end = start + len

    if (end > buf.length) {
      break
    }

    const frame = buf.subarray(start, end)

    if (flag & TRAILER_FLAG) {
      const text = frame.toString('utf8')
      const status = /(?:^|\r?\n)grpc-status:\s*(\d+)/i.exec(text)
      const msg = /(?:^|\r?\n)grpc-message:\s*([^\r\n]*)/i.exec(text)

      if (status) {
        result.grpcStatus = Number(status[1])
      }

      if (msg) {
        result.grpcMessage = decodeURIComponent(msg[1]!.trim())
      }
    } else if (!result.message) {
      result.message = frame
    }

    off = end
  }

  return result
}
