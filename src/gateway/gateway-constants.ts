/**
 * Stable id for tools implemented by the gateway (search, call, code mode, help, optional discovery).
 * {@link projectToPublic} must never apply publication compression to these tools so prompts and schemas
 * stay identical to the source definitions in `discovery.ts`.
 */
export const GATEWAY_SERVER_ID = '__gateway__' as const
