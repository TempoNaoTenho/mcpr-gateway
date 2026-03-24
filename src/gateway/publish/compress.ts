type PublicationConfig = {
  descriptionCompression?: 'off' | 'conservative'
  schemaCompression?: 'off' | 'conservative'
  descriptionMaxLength?: number
}

const DEFAULT_DESCRIPTION_MAX_LENGTH = 160
const DOC_ONLY_SCHEMA_KEYS = new Set(['example', 'examples', '$comment', 'title'])

function trimSentence(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim()
  return firstSentence && firstSentence.length > 0 ? firstSentence : text.trim()
}

function trimAtExampleMarkers(text: string): string {
  return text
    .split(/\b(?:for example|examples?:|e\.g\.)\b/i)[0]
    .trim()
}

function clampDescription(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const sliced = text.slice(0, maxLength - 1)
  const boundary = sliced.lastIndexOf(' ')
  const base = boundary > 80 ? sliced.slice(0, boundary) : sliced
  return `${base.trimEnd()}…`
}

export function compressDescription(
  raw: string | undefined,
  config: PublicationConfig = {},
): string | undefined {
  if (!raw) return raw
  if (config.descriptionCompression === 'off') return raw

  const maxLength = config.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH
  const trimmed = trimSentence(trimAtExampleMarkers(raw))
    .replace(/\b(?:use this tool to|this tool can|this tool will)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (trimmed.length === 0) return undefined
  return clampDescription(trimmed, maxLength)
}

export function compressSchema(
  schema: Record<string, unknown>,
  config: PublicationConfig = {},
  depth = 0,
): Record<string, unknown> {
  if (config.schemaCompression === 'off') {
    return structuredClone(schema)
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (DOC_ONLY_SCHEMA_KEYS.has(key)) continue

    if (key === 'description') {
      if (typeof value !== 'string') continue
      if (depth > 2) continue
      const compressed = compressDescription(value, config)
      if (compressed) result[key] = compressed
      continue
    }

    if (Array.isArray(value)) {
      result[key] = value.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          return compressSchema(entry as Record<string, unknown>, config, depth + 1)
        }
        return entry
      })
      continue
    }

    if (value && typeof value === 'object') {
      result[key] = compressSchema(value as Record<string, unknown>, config, depth + 1)
      continue
    }

    result[key] = value
  }

  return result
}
