export function getRequestOrigin(request: {
  protocol: string
  headers: Record<string, unknown>
}): string {
  const protoHeader = request.headers['x-forwarded-proto']
  const forwardedProto =
    typeof protoHeader === 'string'
      ? protoHeader.split(',')[0]?.trim()
      : Array.isArray(protoHeader)
        ? protoHeader[0]
        : undefined
  const hostHeader = request.headers['x-forwarded-host'] ?? request.headers['host']
  const host =
    typeof hostHeader === 'string'
      ? hostHeader.split(',')[0]?.trim()
      : '127.0.0.1:3000'
  return `${forwardedProto || request.protocol}://${host}`
}
