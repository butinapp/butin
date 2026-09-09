import { createHash, randomBytes } from 'node:crypto'
import { type FileHandle, open, rename, rm, stat } from 'node:fs/promises'

import {
  generateRecoveryCode,
  normalizeRecovery,
  sealBytes,
  type Slot,
  unsealBytes,
  unwrapDek,
  wrapDek
} from '../vault/vault.js'

// The portable profile archive: one file carrying a profile's whole tree, sealed under a passphrase. The
// layout puts the index LAST, the way a zip central directory does, because a streaming writer doesn't know a
// file's hash until it has written it:
//
//   "BTNA" | formatVersion:u8
//   headerLen:u32le | headerJson          <- PLAINTEXT: the only bytes readable without the secret
//   <framed sealed chunk>*                <- every entry's chunks, in index order
//   indexLen:u32le | sealed index
//   indexOffset:u64le | "BTNA"            <- fixed-size trailer, written LAST
//
// The header carries only what's needed before a key exists: the format version and the wrapped key slots.
// Everything else — the profile's name, the file paths, the sizes — lives inside the sealed index, so the
// archive discloses neither which services the user has nor what their documents are called. Each chunk is
// sealed independently, so a large documents tree streams through flat memory and every chunk carries its own
// GCM tag. The trailer landing last is what makes a torn archive detectable rather than half-restorable.

export const ARCHIVE_FORMAT_VERSION = 1

const MAGIC = Buffer.from('BTNA')
const CHUNK_BYTES = 4 * 1024 * 1024
const KEY_LEN = 32
const TRAILER_LEN = 8 + MAGIC.length
const HEADER_START = MAGIC.length + 1

export type ArchiveEntry = { path: string; size: number; sha256: string; chunks: number }

export type ArchiveProfile = { name: string; color?: string; createdAt: string }

// The sealed index — the single description of what's in the archive. Entry frames carry no header of their
// own: they appear in this order, and an entry IS its `chunks` consecutive frames. One description, so there
// is nothing that can disagree with itself.
export type ArchiveIndex = {
  profile: ArchiveProfile
  appVersion: string
  createdAt: string
  totalBytes: number
  entries: ArchiveEntry[]
  // Services whose documents folder was redirected outside the profile tree; their files are packed under the
  // plugin's own documents/ path, and import drops the override. Named here so import can report it.
  reHomed?: string[]
  // Plugin entries whose stored secret would not decrypt on the source machine — shipped absent rather than
  // as a working-looking blank, and surfaced by import.
  unreadableSecrets?: string[]
  // True when the source profile was vault-encrypted; the archive holds its decrypted contents, so the import
  // lands unencrypted and says so.
  sourceEncrypted?: boolean
}

type ArchiveHeader = { formatVersion: number; slots: { password: Slot; recovery: Slot } }

// One file to pack. `open()` is called once, when the writer reaches this entry, so a caller can decide per
// file how to produce bytes (a plaintext read stream, or a whole sealed file decrypted in memory).
export type ArchiveSource = { path: string; size: number; open: () => AsyncIterable<Buffer> }

// The services an index describes, read off the top-level folder of each entry. The profile's own root files
// (config.json, fx.json) sit at the top level with no folder, so they name no service.
export const servicesIn = (index: ArchiveIndex): string[] =>
  [...new Set(index.entries.filter((e) => e.path.includes('/')).map((e) => e.path.split('/')[0]!))].sort()

export type ArchiveProgress = (p: { phase: string; message?: string; completed: number; total: number }) => void

const ARCHIVE_ERROR_CODES = ['not-an-archive', 'format-too-new', 'unfinished', 'wrong-secret', 'corrupt'] as const

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number]

const archiveError = (code: ArchiveErrorCode, message: string): Error => Object.assign(new Error(message), { code })

// The archive-specific reason a read failed, when there is one — so the UI can say "wrong passphrase" instead
// of surfacing a crypto message. A failure from anywhere else (a missing file, a full disk) carries no code
// this recognizes, and the caller falls back to the raw message.
export const archiveErrorCode = (err: unknown): ArchiveErrorCode | undefined =>
  ARCHIVE_ERROR_CODES.find((code) => code === (err as { code?: unknown } | null)?.code)

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)

  b.writeUInt32LE(n)

  return b
}

const frame = (payload: Buffer): Buffer => Buffer.concat([u32(payload.length), payload])

// Re-cut an arbitrary stream of buffers into CHUNK_BYTES pieces (the last one short), so chunk size is a
// property of the format rather than of however the source happened to yield bytes.
const rechunk = async function* (input: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  let held: Buffer[] = []
  let heldLen = 0

  for await (const buf of input) {
    held.push(buf)
    heldLen += buf.length

    while (heldLen >= CHUNK_BYTES) {
      const joined = Buffer.concat(held, heldLen)

      yield joined.subarray(0, CHUNK_BYTES)

      const rest = joined.subarray(CHUNK_BYTES)

      held = rest.length > 0 ? [rest] : []
      heldLen = rest.length
    }
  }

  if (heldLen > 0) {
    yield Buffer.concat(held, heldLen)
  }
}

// Pack `sources` into `target`, sealed under `secret`. Writes to `<target>.partial` and renames on success, so
// an interrupted export never leaves a file that looks openable. Returns the recovery code to show once — the
// second way into the archive when the passphrase is gone.
export const writeArchive = async (
  target: string,
  secret: string,
  meta: { profile: ArchiveProfile; appVersion: string } & Pick<
    ArchiveIndex,
    'reHomed' | 'unreadableSecrets' | 'sourceEncrypted'
  >,
  sources: AsyncIterable<ArchiveSource> | Iterable<ArchiveSource>,
  totalBytes: number,
  onProgress?: ArchiveProgress
): Promise<{ recoveryCode: string; index: ArchiveIndex }> => {
  const key = randomBytes(KEY_LEN)
  const recoveryCode = generateRecoveryCode()
  const header: ArchiveHeader = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    slots: { password: wrapDek(secret, key), recovery: wrapDek(normalizeRecovery(recoveryCode), key) }
  }
  const partial = `${target}.partial`
  const fh = await open(partial, 'w')

  let pos = 0

  const put = async (b: Buffer): Promise<void> => {
    await fh.write(b)
    pos += b.length
  }

  try {
    const entries: ArchiveEntry[] = []
    let done = 0

    await put(Buffer.concat([MAGIC, Buffer.from([ARCHIVE_FORMAT_VERSION])]))
    await put(frame(Buffer.from(JSON.stringify(header))))

    for await (const source of sources) {
      const hash = createHash('sha256')
      let chunks = 0
      let size = 0

      onProgress?.({ phase: 'packing', message: source.path, completed: done, total: totalBytes })

      for await (const chunk of rechunk(source.open())) {
        hash.update(chunk)
        await put(frame(sealBytes(key, chunk)))
        chunks += 1
        size += chunk.length
        done += chunk.length
        onProgress?.({ phase: 'packing', message: source.path, completed: done, total: totalBytes })
      }

      entries.push({ path: source.path, size, sha256: hash.digest('hex'), chunks })
    }

    const index: ArchiveIndex = {
      profile: meta.profile,
      appVersion: meta.appVersion,
      createdAt: new Date().toISOString(),
      totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
      entries,
      reHomed: meta.reHomed,
      unreadableSecrets: meta.unreadableSecrets,
      sourceEncrypted: meta.sourceEncrypted
    }
    const indexOffset = pos
    const trailer = Buffer.alloc(TRAILER_LEN)

    await put(frame(sealBytes(key, Buffer.from(JSON.stringify(index)))))

    trailer.writeBigUInt64LE(BigInt(indexOffset))
    MAGIC.copy(trailer, 8)

    await put(trailer)
    await fh.close()
    await rename(partial, target)

    return { recoveryCode, index }
  } catch (err) {
    await fh.close().catch(() => {})
    await rm(partial, { force: true }).catch(() => {})

    throw err
  }
}

const readExact = async (fh: FileHandle, position: number, length: number): Promise<Buffer> => {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)

  if (bytesRead !== length) {
    throw archiveError('corrupt', 'the archive ends in the middle of a record')
  }

  return buf
}

const readFrame = async (fh: FileHandle, position: number): Promise<{ payload: Buffer; next: number }> => {
  const len = (await readExact(fh, position, 4)).readUInt32LE()

  return { payload: await readExact(fh, position + 4, len), next: position + 4 + len }
}

export type ArchiveReader = {
  index: ArchiveIndex
  // Every entry in index order, each paired with its chunk stream. Consume an entry's chunks before advancing
  // to the next: the frames are laid out sequentially, so reading is a single forward pass.
  entries: () => AsyncIterable<{ entry: ArchiveEntry; chunks: AsyncIterable<Buffer> }>
  close: () => Promise<void>
}

// Open an archive and unseal ONLY its index — enough to preview what an import would land, with nothing
// written. Throws a coded error for every way a file can fail to be a usable archive.
export const openArchive = async (path: string, secret: string): Promise<ArchiveReader> => {
  const { size } = await stat(path)
  const fh = await open(path, 'r')

  try {
    if (size < HEADER_START + 4 + TRAILER_LEN) {
      throw archiveError('not-an-archive', 'this file is not a Butin profile archive')
    }

    const preamble = await readExact(fh, 0, HEADER_START)

    if (!preamble.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw archiveError('not-an-archive', 'this file is not a Butin profile archive')
    }

    const formatVersion = preamble[MAGIC.length]!

    if (formatVersion > ARCHIVE_FORMAT_VERSION) {
      throw archiveError(
        'format-too-new',
        `this archive is format version ${formatVersion}; this version of Butin reads up to ${ARCHIVE_FORMAT_VERSION}`
      )
    }

    const trailer = await readExact(fh, size - TRAILER_LEN, TRAILER_LEN)

    // No valid trailer means the writer never reached the end: the export was interrupted. Refusing here is
    // what keeps a torn archive from restoring as a plausible-looking half profile.
    if (!trailer.subarray(8).equals(MAGIC)) {
      throw archiveError('unfinished', 'this archive was not finished writing — export it again')
    }

    const { payload: headerJson, next: dataStart } = await readFrame(fh, HEADER_START)
    const header = JSON.parse(headerJson.toString()) as ArchiveHeader
    const key = unwrapDek(secret, header.slots.password) ?? unwrapDek(normalizeRecovery(secret), header.slots.recovery)

    if (!key) {
      throw archiveError('wrong-secret', 'that passphrase does not open this archive')
    }

    const indexOffset = Number(trailer.readBigUInt64LE())

    if (indexOffset < dataStart || indexOffset > size - TRAILER_LEN) {
      throw archiveError('corrupt', 'the archive index is out of bounds')
    }

    let index: ArchiveIndex

    try {
      index = JSON.parse(unsealBytes(key, (await readFrame(fh, indexOffset)).payload).toString()) as ArchiveIndex
    } catch {
      throw archiveError('corrupt', 'the archive index could not be read')
    }

    const entries = async function* (): AsyncIterable<{ entry: ArchiveEntry; chunks: AsyncIterable<Buffer> }> {
      let at = dataStart

      for (const entry of index.entries) {
        // Advance `at` past this entry's frames even if the consumer abandons its chunk stream, so the next
        // entry still starts in the right place.
        const spans: { from: number }[] = []
        let scan = at

        for (let i = 0; i < entry.chunks; i += 1) {
          spans.push({ from: scan })
          scan = scan + 4 + (await readExact(fh, scan, 4)).readUInt32LE()
        }

        const chunks = async function* (): AsyncIterable<Buffer> {
          for (const span of spans) {
            const { payload } = await readFrame(fh, span.from)

            try {
              yield unsealBytes(key, payload)
            } catch {
              throw archiveError('corrupt', `a chunk of ${entry.path} failed its integrity check`)
            }
          }
        }

        yield { entry, chunks: chunks() }
        at = scan
      }
    }

    return { index, entries, close: () => fh.close() }
  } catch (err) {
    await fh.close().catch(() => {})

    throw err
  }
}
