export type SandboxBackend = 'isolated-vm'

export type SandboxHostApi = {
  catalogSearch: (query: string, options?: Record<string, unknown>) => Promise<unknown> | unknown
  catalogServers: () => Promise<unknown> | unknown
  catalogList: (filters?: Record<string, unknown>) => Promise<unknown> | unknown
  catalogDescribe: (handle: string, options?: Record<string, unknown>) => Promise<unknown> | unknown
  mcpCall: (handle: string, args?: Record<string, unknown>) => Promise<unknown> | unknown
  mcpBatch: (
    calls: Array<{ handle: string; args?: Record<string, unknown> }>
  ) => Promise<unknown> | unknown
  resultPick: (value: unknown, fields: string[]) => unknown
  resultLimit: (value: unknown[], count: number) => unknown
  resultItems: (value: unknown) => unknown
  resultText: (value: unknown) => unknown
  resultCount: (value: unknown) => unknown
  resultGroupBy: (value: unknown[], field: string) => unknown
  resultGrep: (value: unknown[], field: string, pattern: string) => unknown
  resultFlatten: (value: unknown, depth?: number) => unknown
  resultSummarize: (value: unknown) => unknown
  artifactsSave: (data: unknown, options?: Record<string, unknown>) => Promise<unknown> | unknown
  artifactsList: () => Promise<unknown> | unknown
}

export type SandboxExecutionOptions = {
  code: string
  memoryLimitMb: number
  executionTimeoutMs: number
  operationTimeoutMs?: number
  backend?: SandboxBackend
}

export type SandboxExecutionResult = {
  value: unknown
  backend: SandboxBackend
}

export type SandboxBridgeOperation =
  | 'catalog.search'
  | 'catalog.servers'
  | 'catalog.list'
  | 'catalog.describe'
  | 'mcp.call'
  | 'mcp.batch'
  | 'artifacts.save'
  | 'artifacts.list'

export type SandboxDiagnosticEvent =
  | {
      type: 'bridge_start'
      operation: SandboxBridgeOperation
      pendingCount: number
      timeoutMs?: number
    }
  | {
      type: 'bridge_settled'
      operation: SandboxBridgeOperation
      pendingCount: number
      outcome: 'resolved' | 'rejected' | 'timed_out'
      durationMs: number
      payloadBytes?: number
      itemCount?: number
      empty?: boolean
      normalized: boolean
      truncated: boolean
      error?: string
    }
  | {
      type: 'cleanup_wait_start'
      pendingCount: number
    }
  | {
      type: 'cleanup_wait_complete'
      pendingCount: number
    }

export type SandboxDiagnostics = {
  onDiagnosticEvent?: (event: SandboxDiagnosticEvent) => void
}

type NormalizedBridgeValue = {
  value: unknown
  normalized: boolean
  truncated: boolean
}

class SandboxBridgeTimeoutError extends Error {
  readonly operation: SandboxBridgeOperation
  readonly timeoutMs: number

  constructor(operation: SandboxBridgeOperation, timeoutMs: number) {
    super(
      `Bridge operation ${operation} timed out after ${timeoutMs}ms. Reduce the work for this step or split it into smaller calls.`
    )
    this.name = 'SandboxBridgeTimeoutError'
    this.operation = operation
    this.timeoutMs = timeoutMs
  }
}

function byteSizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
  } catch {
    return Buffer.byteLength(String(value), 'utf8')
  }
}

function summarizeCollection(value: unknown): { itemCount?: number; empty?: boolean } {
  if (Array.isArray(value)) {
    return { itemCount: value.length, empty: value.length === 0 }
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    return { itemCount: keys.length, empty: keys.length === 0 }
  }
  return {}
}

function normalizeBridgeValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): NormalizedBridgeValue {
  if (value == null) return { value, normalized: false, truncated: false }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { value, normalized: false, truncated: false }
  }
  if (typeof value === 'bigint') {
    return { value: value.toString(), normalized: true, truncated: false }
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return { value: String(value), normalized: true, truncated: false }
  }
  if (depth >= 20) {
    return { value: '[MaxDepthExceeded]', normalized: true, truncated: true }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return { value: '[Circular]', normalized: true, truncated: false }
    }
    seen.add(value)
    let normalized = false
    let truncated = false
    const mapped = value.map((entry) => {
      const next = normalizeBridgeValue(entry, seen, depth + 1)
      normalized ||= next.normalized
      truncated ||= next.truncated
      return next.value
    })
    seen.delete(value)
    return { value: mapped, normalized, truncated }
  }
  if (value instanceof Date) {
    return { value: value.toISOString(), normalized: true, truncated: false }
  }
  if (value instanceof Error) {
    return {
      value: { name: value.name, message: value.message, stack: value.stack },
      normalized: true,
      truncated: false,
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return { value: '[Circular]', normalized: true, truncated: false }
    }
    seen.add(value as object)
    if (value instanceof Map) {
      seen.add(value)
      let truncated = false
      const mapped = [...value.entries()].map(([key, entry]) => {
        const next = normalizeBridgeValue(entry, seen, depth + 1)
        truncated ||= next.truncated
        return [String(key), next.value]
      })
      seen.delete(value)
      return { value: Object.fromEntries(mapped), normalized: true, truncated }
    }
    if (value instanceof Set) {
      seen.add(value)
      let truncated = false
      const mapped = [...value.values()].map((entry) => {
        const next = normalizeBridgeValue(entry, seen, depth + 1)
        truncated ||= next.truncated
        return next.value
      })
      seen.delete(value)
      return { value: mapped, normalized: true, truncated }
    }
    const normalizedObject: Record<string, unknown> = {}
    let normalized = false
    let truncated = false
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const next = normalizeBridgeValue(entry, seen, depth + 1)
      normalizedObject[key] = next.value
      normalized ||= next.normalized
      truncated ||= next.truncated
    }
    seen.delete(value as object)
    return { value: normalizedObject, normalized, truncated }
  }
  return { value: String(value), normalized: true, truncated: false }
}

const SETUP_SOURCE = `
globalThis.catalog = Object.freeze({
  search: (query, options) =>
    globalThis.__catalogSearch.applySyncPromise(undefined, [query, options], {
      arguments: { copy: true },
    }),
  servers: () =>
    globalThis.__catalogServers.applySyncPromise(undefined, [], {
      arguments: { copy: true },
    }),
  list: (filters) =>
    globalThis.__catalogList.applySyncPromise(undefined, [filters], {
      arguments: { copy: true },
    }),
  describe: (handle, options) =>
    globalThis.__catalogDescribe.applySyncPromise(undefined, [handle, options], {
      arguments: { copy: true },
    }),
})

globalThis.mcp = Object.freeze({
  call: (handle, args) =>
    globalThis.__mcpCall.applySyncPromise(undefined, [handle, args], {
      arguments: { copy: true },
    }),
  batch: (calls) =>
    globalThis.__mcpBatch.applySyncPromise(undefined, [calls], {
      arguments: { copy: true },
    }),
})

globalThis.result = Object.freeze({
  pick: (value, fields) => globalThis.__resultPick(value, fields),
  limit: (value, count) => globalThis.__resultLimit(value, count),
  items: (value) => globalThis.__resultItems(value),
  text: (value) => globalThis.__resultText(value),
  count: (value) => globalThis.__resultCount(value),
  groupBy: (value, field) => globalThis.__resultGroupBy(value, field),
  grep: (value, field, pattern) => globalThis.__resultGrep(value, field, pattern),
  flatten: (value, depth) => globalThis.__resultFlatten(value, depth),
  summarize: (value) => globalThis.__resultSummarize(value),
})

globalThis.artifacts = Object.freeze({
  save: (data, options) =>
    globalThis.__artifactsSave.applySyncPromise(undefined, [data, options], {
      arguments: { copy: true },
    }),
  list: () =>
    globalThis.__artifactsList.applySyncPromise(undefined, [], {
      arguments: { copy: true },
    }),
})
`

function externalizeBridgeValue(
  ivm: typeof import('isolated-vm'),
  value: unknown,
): import('isolated-vm').Copy<unknown> {
  return new ivm.ExternalCopy(value).copyInto()
}

const EXECUTION_SOURCE = `
return (async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

  try {
    const expressionFn = new AsyncFunction(
      'catalog',
      'mcp',
      'result',
      'artifacts',
      'return (' + $0 + ');',
    )
    return await expressionFn(catalog, mcp, result, artifacts)
  } catch (error) {
    if (!error || error.name !== 'SyntaxError') {
      throw error
    }
  }

  const statementFn = new AsyncFunction('catalog', 'mcp', 'result', 'artifacts', $0)
  return await statementFn(catalog, mcp, result, artifacts)
})()
`

function resolveBackend(backend: string | undefined = 'isolated-vm'): SandboxBackend {
  if (backend !== 'isolated-vm') {
    throw new Error(`Unsupported sandbox backend "${backend}". Only "isolated-vm" is allowed.`)
  }
  return 'isolated-vm'
}

export function trackBridgedPromise(
  pendingBridged: Map<Promise<unknown>, SandboxBridgeOperation>,
  operation: SandboxBridgeOperation,
  op: Promise<unknown> | unknown,
  diagnostics?: SandboxDiagnostics,
  timeoutMs?: number,
): Promise<unknown> {
  const startedAt = Date.now()
  const basePromise = Promise.resolve(op) as Promise<unknown>
  const p =
    timeoutMs && timeoutMs > 0
      ? new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new SandboxBridgeTimeoutError(operation, timeoutMs))
          }, timeoutMs)
          void basePromise.then(
            (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            (error) => {
              clearTimeout(timer)
              reject(error)
            }
          )
        })
      : basePromise
  pendingBridged.set(p, operation)
  diagnostics?.onDiagnosticEvent?.({
    type: 'bridge_start',
    operation,
    pendingCount: pendingBridged.size,
    timeoutMs,
  })
  void p.then(
    (value) => {
      pendingBridged.delete(p)
      const normalized = normalizeBridgeValue(value)
      const collection = summarizeCollection(normalized.value)
      diagnostics?.onDiagnosticEvent?.({
        type: 'bridge_settled',
        operation,
        pendingCount: pendingBridged.size,
        outcome: 'resolved',
        durationMs: Date.now() - startedAt,
        payloadBytes: byteSizeOf(normalized.value),
        itemCount: collection.itemCount,
        empty: collection.empty,
        normalized: normalized.normalized,
        truncated: normalized.truncated,
      })
    },
    (error) => {
      pendingBridged.delete(p)
      diagnostics?.onDiagnosticEvent?.({
        type: 'bridge_settled',
        operation,
        pendingCount: pendingBridged.size,
        outcome: error instanceof SandboxBridgeTimeoutError ? 'timed_out' : 'rejected',
        durationMs: Date.now() - startedAt,
        normalized: false,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  )
  return p
}

async function waitForPendingBridged(
  pendingBridged: Map<Promise<unknown>, SandboxBridgeOperation>,
  diagnostics?: SandboxDiagnostics,
): Promise<void> {
  const snapshot = [...pendingBridged.entries()]
  if (snapshot.length === 0) {
    return
  }

  diagnostics?.onDiagnosticEvent?.({
    type: 'cleanup_wait_start',
    pendingCount: snapshot.length,
  })
  await Promise.allSettled(snapshot.map(([promise]) => promise))
  diagnostics?.onDiagnosticEvent?.({
    type: 'cleanup_wait_complete',
    pendingCount: 0,
  })
}

async function executeWithIsolatedVm(
  options: SandboxExecutionOptions,
  hostApi: SandboxHostApi,
  diagnostics?: SandboxDiagnostics,
): Promise<SandboxExecutionResult> {
  const loaded = await import('isolated-vm')
  const ivm = (loaded.default ?? loaded) as typeof import('isolated-vm')

  /** Promises created by host bridged callbacks (catalog/mcp/artifacts). If guest code does not
   * await them, evalClosure can still finish and we must not dispose the isolate until they settle,
   * otherwise the host side can hit unhandledRejection and exit the gateway process. */
  const pendingBridged = new Map<Promise<unknown>, SandboxBridgeOperation>()

  let isolate
  let result: SandboxExecutionResult | undefined
  let executionError: unknown
  try {
    isolate = new ivm.Isolate({
      memoryLimit: options.memoryLimitMb,
    })
    const context = isolate.createContextSync()
    const jail = context.global
    jail.setSync('globalThis', jail.derefInto())
    jail.setSync(
      '__catalogSearch',
      new ivm.Reference(
        async (query: string, runtimeOptions?: Record<string, unknown>) =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'catalog.search',
                hostApi.catalogSearch(query, runtimeOptions),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync(
      '__catalogServers',
      new ivm.Reference(
        async () =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'catalog.servers',
                hostApi.catalogServers(),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync(
      '__catalogList',
      new ivm.Reference(
        async (filters?: Record<string, unknown>) =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'catalog.list',
                hostApi.catalogList(filters),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync(
      '__catalogDescribe',
      new ivm.Reference(
        async (handle: string, runtimeOptions?: Record<string, unknown>) =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'catalog.describe',
                hostApi.catalogDescribe(handle, runtimeOptions),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync(
      '__mcpCall',
      new ivm.Reference(
        async (handle: string, args?: Record<string, unknown>) =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'mcp.call',
                hostApi.mcpCall(handle, args),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync(
      '__mcpBatch',
      new ivm.Reference(
        async (calls: Array<{ handle: string; args?: Record<string, unknown> }>) =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'mcp.batch',
                hostApi.mcpBatch(calls),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync('__resultPick', hostApi.resultPick)
    jail.setSync('__resultLimit', hostApi.resultLimit)
    jail.setSync('__resultItems', hostApi.resultItems)
    jail.setSync('__resultText', hostApi.resultText)
    jail.setSync('__resultCount', hostApi.resultCount)
    jail.setSync('__resultGroupBy', hostApi.resultGroupBy)
    jail.setSync('__resultGrep', hostApi.resultGrep)
    jail.setSync('__resultFlatten', hostApi.resultFlatten)
    jail.setSync('__resultSummarize', hostApi.resultSummarize)
    jail.setSync(
      '__artifactsSave',
      new ivm.Reference(
        async (data: unknown, runtimeOptions?: Record<string, unknown>) =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'artifacts.save',
                hostApi.artifactsSave(data, runtimeOptions),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )
    jail.setSync(
      '__artifactsList',
      new ivm.Reference(
        async () =>
          externalizeBridgeValue(
            ivm,
            normalizeBridgeValue(
              await trackBridgedPromise(
                pendingBridged,
                'artifacts.list',
                hostApi.artifactsList(),
                diagnostics,
                options.operationTimeoutMs,
              )
            ).value
          )
      )
    )

    context.evalSync(SETUP_SOURCE, { timeout: options.executionTimeoutMs })
    const value = await context.evalClosure(EXECUTION_SOURCE, [options.code], {
      arguments: { copy: true },
      result: { copy: true, promise: true },
      timeout: options.executionTimeoutMs,
    })

    result = {
      value,
      backend: 'isolated-vm',
    }
  } catch (error) {
    executionError = error
  } finally {
    if (isolate) {
      await waitForPendingBridged(pendingBridged, diagnostics)
      isolate.dispose()
    }
  }

  if (executionError !== undefined) {
    throw executionError
  }
  return result as SandboxExecutionResult
}

export async function executeInSandbox(
  options: SandboxExecutionOptions,
  hostApi: SandboxHostApi,
  diagnostics?: SandboxDiagnostics,
): Promise<SandboxExecutionResult> {
  resolveBackend(options.backend)
  return executeWithIsolatedVm(options, hostApi, diagnostics)
}
