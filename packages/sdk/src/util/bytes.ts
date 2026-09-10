// A PDF's magic number: the four bytes `%PDF` every file starts with.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]

// Whether a downloaded body is actually a PDF. A portal that has lost the session answers a document request
// with an HTML error page and a 200, so a collector that saves the bytes unchecked writes that page out as an
// invoice — check before saving, and fail loudly instead.
export const isPdfBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b)
