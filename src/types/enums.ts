export enum SessionStatus {
  Cold = 'cold',
  Active = 'active',
  Expired = 'expired',
  Revoked = 'revoked',
}

export enum DownstreamHealth {
  Unknown = 'unknown',
  Healthy = 'healthy',
  Degraded = 'degraded',
  Offline = 'offline',
}

export enum DownstreamAuthStatus {
  None = 'none',
  Configured = 'configured',
  Authorized = 'authorized',
  AuthRequired = 'auth_required',
  RefreshFailed = 'refresh_failed',
  Misconfigured = 'misconfigured',
}

export enum StdioInteractiveAuthStatus {
  Idle = 'idle',
  Starting = 'starting',
  Pending = 'pending',
  Ready = 'ready',
  Failed = 'failed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export enum ToolRiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export enum SourceTrustLevel {
  Untrusted = 'untrusted',
  Verified = 'verified',
  Internal = 'internal',
}

export enum OutcomeClass {
  Success = 'success',
  ToolError = 'tool_error',
  TransportError = 'transport_error',
  Timeout = 'timeout',
  AuthError = 'auth_error',
  UnavailableDownstream = 'unavailable_downstream',
}

export enum RefreshTriggerType {
  ExplicitRequest = 'explicit_request',
  NamespaceChange = 'namespace_change',
  RoleChange = 'role_change',
  IdleTimeout = 'idle_timeout',
  ErrorThreshold = 'error_threshold',
  FirstSuccessInDomain = 'first_success_in_domain',
}

export enum Mode {
  Read = 'read',
  Write = 'write',
  Admin = 'admin',
}

export enum GatewayMode {
  Default = 'default',
  Compat = 'compat',
  Code = 'code',
}

export enum AuditEventType {
  SessionCreated = 'session_created',
  BootstrapWindowPublished = 'bootstrap_window_published',
  ActiveWindowRecomputed = 'active_window_recomputed',
  ToolExecuted = 'tool_executed',
  ExecutionDenied = 'execution_denied',
  DownstreamMarkedUnhealthy = 'downstream_marked_unhealthy',
}
