// The `dev` (developer-panel) DTOs: the partitions of the active profile and the cookies inside one. Cookie
// values are real session secrets — they cross IPC only for the local Cookie Jar, never logged or sent out.
export interface DevPartitionDto {
  partition: string
  label: string
  count: number
}

export interface DevCookieDto {
  name: string
  value: string
  domain: string
  path: string
  // name.length + value.length — the byte weight that drives Chromium's per-domain cookie cap.
  size: number
  // Epoch seconds, or null for a session cookie.
  expires: number | null
  session: boolean
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

// Identifies one cookie for removal (the fields `cookies.remove` needs to reconstruct its URL + name).
export interface DevCookieSelector {
  domain: string
  path: string
  name: string
  secure: boolean
}
