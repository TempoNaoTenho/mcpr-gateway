export class DownstreamAuthError extends Error {
  readonly name = 'DownstreamAuthError'

  constructor(
    message: string,
    readonly details: {
      serverId: string
      kind: 'auth_required' | 'invalid_token' | 'token_expired' | 'oauth_exchange_failed' | 'misconfigured'
      status?: number
      challenge?: string
      authorizationServer?: string
    },
  ) {
    super(message)
  }
}

export function isDownstreamAuthError(error: unknown): error is DownstreamAuthError {
  return error instanceof DownstreamAuthError
}
