// Pure view-model helper for the downloadable-table file size cell — node-tested, no React.

export const formatSize = (bytes?: number): string => {
  if (bytes === undefined) {
    return '—'
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }

  return `${value.toFixed(1)} ${units[i]}`
}
