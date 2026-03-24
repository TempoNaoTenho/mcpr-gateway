/** Matches gateway `DownstreamAuthStatus` — maps to Badge.svelte variants */
export const AUTH_STATUS_BADGE_VARIANT = {
  authorized: 'success',
  configured: 'muted',
  auth_required: 'warning',
  refresh_failed: 'danger',
  misconfigured: 'danger',
  none: 'muted',
} as const;

export type AuthStatusBadgeVariant =
  (typeof AUTH_STATUS_BADGE_VARIANT)[keyof typeof AUTH_STATUS_BADGE_VARIANT];

export function authStatusToBadgeVariant(status: string): AuthStatusBadgeVariant {
  if (Object.prototype.hasOwnProperty.call(AUTH_STATUS_BADGE_VARIANT, status)) {
    return AUTH_STATUS_BADGE_VARIANT[status as keyof typeof AUTH_STATUS_BADGE_VARIANT];
  }
  return 'muted';
}
