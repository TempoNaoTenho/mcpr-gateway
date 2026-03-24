type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getByPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined
    return current[segment]
  }, value)
}

function serializePreview(value: unknown, maxLength = 240): string {
  const serialized = JSON.stringify(value)
  if (!serialized) return ''
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized
}

export function pick(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => pick(entry, fields))
  }
  if (!isRecord(value)) return value

  const projected: RecordLike = {}
  for (const field of fields) {
    const resolved = getByPath(value, field)
    if (resolved !== undefined) {
      projected[field] = resolved
    }
  }
  return projected
}

export function limit<T>(value: T[], count: number): T[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, Math.max(0, count))
}

export function count(value: unknown): number {
  if (Array.isArray(value) || typeof value === 'string') return value.length
  if (isRecord(value)) return Object.keys(value).length
  return 0
}

export function groupBy<T>(value: T[], field: string): Record<string, T[]> {
  if (!Array.isArray(value)) return {}
  return value.reduce<Record<string, T[]>>((groups, entry) => {
    const key = getByPath(entry, field)
    const normalizedKey = key === undefined ? 'undefined' : String(key)
    groups[normalizedKey] ??= []
    groups[normalizedKey]!.push(entry)
    return groups
  }, {})
}

export function grep<T>(value: T[], field: string, pattern: string): T[] {
  if (!Array.isArray(value)) return []
  const matcher = new RegExp(pattern, 'i')
  return value.filter((entry) => matcher.test(String(getByPath(entry, field) ?? '')))
}

export function flatten(value: unknown, depth = 1): unknown {
  if (!Array.isArray(value)) return value
  return value.flat(Math.max(0, depth))
}

export function summarize(value: unknown): {
  type: string
  keys?: string[]
  length?: number
  preview: string
} {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      preview: serializePreview(value.slice(0, 3)),
    }
  }
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      preview: value.length > 240 ? `${value.slice(0, 240)}...` : value,
    }
  }
  if (isRecord(value)) {
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, 20),
      length: Object.keys(value).length,
      preview: serializePreview(value),
    }
  }
  return {
    type: value === null ? 'null' : typeof value,
    preview: serializePreview(value),
  }
}

export function createResultApi() {
  return {
    pick,
    limit,
    count,
    groupBy,
    grep,
    flatten,
    summarize,
  }
}
