export function sanitizeDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined

  // Strip HTML tags
  let result = raw.replace(/<[^>]*>/g, '')

  // Strip markdown bold/italic noise (**bold**, *italic*, __bold__, _italic_)
  result = result.replace(/(\*\*|__)(.*?)\1/g, '$2')
  result = result.replace(/(\*|_)(.*?)\1/g, '$2')

  // Remove control characters (< 0x20 except tab, newline, carriage return)
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

  // Normalize line endings, then collapse horizontal whitespace per line only (keep \n / paragraph breaks)
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  result = result
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
  result = result.replace(/\n{3,}/g, '\n\n').trim()

  return result.length === 0 ? undefined : result
}

export function sanitizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-.]/g, '')
}
