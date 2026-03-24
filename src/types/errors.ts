export const GatewayErrorCode = {
  UNAUTHORIZED_NAMESPACE: 'UNAUTHORIZED_NAMESPACE',
  TOOL_NOT_VISIBLE: 'TOOL_NOT_VISIBLE',
  TOOL_NOT_ALLOWED: 'TOOL_NOT_ALLOWED',
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  DOWNSTREAM_UNAVAILABLE: 'DOWNSTREAM_UNAVAILABLE',
  DOWNSTREAM_TIMEOUT: 'DOWNSTREAM_TIMEOUT',
  INVALID_TOOL_ARGUMENTS: 'INVALID_TOOL_ARGUMENTS',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  INTERNAL_GATEWAY_ERROR: 'INTERNAL_GATEWAY_ERROR',
  OAUTH_PROVIDER_NOT_ALLOWED: 'OAUTH_PROVIDER_NOT_ALLOWED',
} as const

export type GatewayErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode]

const defaultMessages: Record<GatewayErrorCode, string> = {
  UNAUTHORIZED_NAMESPACE: 'Access to the requested namespace is not authorized',
  TOOL_NOT_VISIBLE:
    'Tool is not in the current session tool window. In compat mode, use gateway_search_tools to discover available tools, then gateway_call_tool (with tool name and serverId) to execute them.',
  TOOL_NOT_ALLOWED: 'Tool execution is not permitted under current policy',
  COMMAND_NOT_ALLOWED: 'Command is not in the allowed list or contains dangerous arguments',
  DOWNSTREAM_UNAVAILABLE: 'Downstream server is unavailable',
  DOWNSTREAM_TIMEOUT: 'Downstream server did not respond in time',
  INVALID_TOOL_ARGUMENTS: 'Tool arguments failed schema validation',
  SESSION_NOT_FOUND: 'Session does not exist or has expired',
  UNSUPPORTED_OPERATION: 'Operation is not supported',
  INTERNAL_GATEWAY_ERROR: 'An unexpected internal error occurred',
  OAUTH_PROVIDER_NOT_ALLOWED: 'OAuth provider URL is not in the allowed list',
}

const defaultStatusCodes: Record<GatewayErrorCode, number> = {
  UNAUTHORIZED_NAMESPACE: 403,
  TOOL_NOT_VISIBLE: 404,
  TOOL_NOT_ALLOWED: 403,
  COMMAND_NOT_ALLOWED: 403,
  DOWNSTREAM_UNAVAILABLE: 503,
  DOWNSTREAM_TIMEOUT: 504,
  INVALID_TOOL_ARGUMENTS: 400,
  SESSION_NOT_FOUND: 404,
  UNSUPPORTED_OPERATION: 501,
  INTERNAL_GATEWAY_ERROR: 500,
  OAUTH_PROVIDER_NOT_ALLOWED: 403,
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode
  readonly statusCode: number
  readonly details?: unknown

  constructor(code: GatewayErrorCode, message?: string, details?: unknown) {
    super(message ?? defaultMessages[code])
    this.name = 'GatewayError'
    this.code = code
    this.statusCode = defaultStatusCodes[code]
    this.details = details
  }
}
