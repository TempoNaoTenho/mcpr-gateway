import { ZodError } from 'zod'
import { GatewayError, GatewayErrorCode } from '../types/errors.js'

export function isProductionMode(): boolean {
  return process.env['NODE_ENV'] === 'production'
}

export interface SanitizedError {
  error: string
  message: string
  details?: unknown
}

export function sanitizeError(error: unknown, isProduction?: boolean): SanitizedError {
  const production = isProduction ?? isProductionMode()

  if (error instanceof GatewayError) {
    return {
      error: error.code,
      message: error.message,
      details: production ? undefined : error.details,
    }
  }

  if (error instanceof ZodError) {
    return {
      error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
      message: 'Request validation failed',
      details: production ? undefined : error.issues,
    }
  }

  if (error instanceof Error) {
    if (production) {
      return {
        error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
        message: 'An unexpected error occurred',
      }
    }

    return {
      error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
      message: error.message,
      details: error.stack,
    }
  }

  if (production) {
    return {
      error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
      message: 'An unexpected error occurred',
    }
  }

  return {
    error: GatewayErrorCode.INTERNAL_GATEWAY_ERROR,
    message: String(error),
  }
}

export function logErrorInternal(
  error: unknown,
  logger: (err: unknown) => void = console.error
): void {
  if (error instanceof Error) {
    logger({
      message: error.message,
      stack: error.stack,
      ...(error instanceof GatewayError ? { code: error.code } : {}),
      ...(error instanceof ZodError ? { issues: error.issues } : {}),
    })
  } else {
    logger(error)
  }
}
