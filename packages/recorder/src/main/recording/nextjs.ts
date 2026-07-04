// Next.js App Router invokes a Server Action as a POST to the current page URL
// carrying a `Next-Action: <id>` header. Without surfacing that id, every action
// looks like an identical POST to the page route. Pull it out (case-insensitive)
// so actions are findable. Returns undefined when the header is absent.
export function extractNextAction(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) {
    return undefined
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'next-action' && typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}
