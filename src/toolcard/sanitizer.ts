const MAX_DESCRIPTION_LENGTH = 512

export function sanitizeDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined

  // Strip HTML tags
  let result = raw.replace(/<[^>]*>/g, '')

  // Strip markdown bold/italic noise (**bold**, *italic*, __bold__, _italic_)
  result = result.replace(/(\*\*|__)(.*?)\1/g, '$2')
  result = result.replace(/(\*|_)(.*?)\1/g, '$2')

  // Remove control characters (< 0x20 except tab, newline, carriage return)
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

  // Normalize whitespace (multiple spaces/newlines → single space)
  result = result.replace(/\s+/g, ' ').trim()

  // Length-cap
  if (result.length > MAX_DESCRIPTION_LENGTH) {
    result = result.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()
  }

  return result.length === 0 ? undefined : result
}

export function sanitizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-.]/g, '')
}
