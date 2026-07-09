// The recorder reads a response body one of two ways. A finite response is read in one shot with
// Network.getResponseBody once Network.loadingFinished fires. A long-lived / unbounded response — Server-Sent
// Events, a Firestore Listen WebChannel, gRPC-web, a chunked NDJSON feed — may never fire loadingFinished (the
// stream stays open for the life of the page), so getResponseBody would hang and the record would be dropped at
// stop. Those we switch to Network.streamResourceContent and accumulate Network.dataReceived chunks instead,
// flushing whatever arrived if the run ends mid-stream.
//
// shouldStreamResponse picks the streaming path. The explicit signals are an event-stream mime or the
// EventSource resource type. The general one is a data fetch (XHR/Fetch) that carries NO Content-Length: the
// browser was handed a body of unknown length — a chunked / HTTP-2 stream — which is exactly the shape of the
// Firestore Listen channel (text/plain, no length) and every other framed-forever transport. A finite response
// advertises its Content-Length and keeps the cheaper single-shot path (with a fallback in writeRecord for the
// rare case where streaming engaged but produced no bytes).

const STREAMABLE_FETCH_TYPES = new Set(['XHR', 'Fetch', 'EventSource'])

export function shouldStreamResponse(
  resourceType: string,
  mimeType: string,
  responseHeaders: Record<string, string>
): boolean {
  if (/event-stream/i.test(mimeType) || resourceType === 'EventSource') {
    return true
  }

  if (!STREAMABLE_FETCH_TYPES.has(resourceType)) {
    return false
  }

  return !hasHeader(responseHeaders, 'content-length')
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name)
}
