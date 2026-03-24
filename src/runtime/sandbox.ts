export type SandboxBackend = 'isolated-vm'

export type SandboxHostApi = {
  catalogSearch: (query: string, options?: Record<string, unknown>) => Promise<unknown> | unknown
  catalogList: (filters?: Record<string, unknown>) => Promise<unknown> | unknown
  catalogDescribe: (handle: string, options?: Record<string, unknown>) => Promise<unknown> | unknown
  mcpCall: (handle: string, args?: Record<string, unknown>) => Promise<unknown> | unknown
  mcpBatch: (
    calls: Array<{ handle: string; args?: Record<string, unknown> }>
  ) => Promise<unknown> | unknown
  resultPick: (value: unknown, fields: string[]) => unknown
  resultLimit: (value: unknown[], count: number) => unknown
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
  backend?: SandboxBackend
}

export type SandboxExecutionResult = {
  value: unknown
  backend: SandboxBackend
}

const SETUP_SOURCE = `
globalThis.catalog = Object.freeze({
  search: (query, options) => globalThis.__catalogSearch(query, options),
  list: (filters) => globalThis.__catalogList(filters),
  describe: (handle, options) => globalThis.__catalogDescribe(handle, options),
})

globalThis.mcp = Object.freeze({
  call: (handle, args) => globalThis.__mcpCall(handle, args),
  batch: (calls) => globalThis.__mcpBatch(calls),
})

globalThis.result = Object.freeze({
  pick: (value, fields) => globalThis.__resultPick(value, fields),
  limit: (value, count) => globalThis.__resultLimit(value, count),
  count: (value) => globalThis.__resultCount(value),
  groupBy: (value, field) => globalThis.__resultGroupBy(value, field),
  grep: (value, field, pattern) => globalThis.__resultGrep(value, field, pattern),
  flatten: (value, depth) => globalThis.__resultFlatten(value, depth),
  summarize: (value) => globalThis.__resultSummarize(value),
})

globalThis.artifacts = Object.freeze({
  save: (data, options) => globalThis.__artifactsSave(data, options),
  list: () => globalThis.__artifactsList(),
})
`

const EXECUTION_SOURCE = `
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
`

function resolveBackend(backend: string | undefined = 'isolated-vm'): SandboxBackend {
  if (backend !== 'isolated-vm') {
    throw new Error(`Unsupported sandbox backend "${backend}". Only "isolated-vm" is allowed.`)
  }
  return 'isolated-vm'
}

async function executeWithIsolatedVm(
  options: SandboxExecutionOptions,
  hostApi: SandboxHostApi
): Promise<SandboxExecutionResult> {
  const loaded = await import('isolated-vm')
  const ivm = (loaded.default ?? loaded) as typeof import('isolated-vm')

  let isolate
  try {
    isolate = new ivm.Isolate({
      memoryLimit: options.memoryLimitMb,
    })
    const context = isolate.createContextSync()
    const jail = context.global
    jail.setSync('globalThis', jail.derefInto())
    jail.setSync(
      '__catalogSearch',
      async (query: string, runtimeOptions?: Record<string, unknown>) =>
        hostApi.catalogSearch(query, runtimeOptions)
    )
    jail.setSync('__catalogList', async (filters?: Record<string, unknown>) =>
      hostApi.catalogList(filters)
    )
    jail.setSync(
      '__catalogDescribe',
      async (handle: string, runtimeOptions?: Record<string, unknown>) =>
        hostApi.catalogDescribe(handle, runtimeOptions)
    )
    jail.setSync('__mcpCall', async (handle: string, args?: Record<string, unknown>) =>
      hostApi.mcpCall(handle, args)
    )
    jail.setSync(
      '__mcpBatch',
      async (calls: Array<{ handle: string; args?: Record<string, unknown> }>) =>
        hostApi.mcpBatch(calls)
    )
    jail.setSync('__resultPick', hostApi.resultPick)
    jail.setSync('__resultLimit', hostApi.resultLimit)
    jail.setSync('__resultCount', hostApi.resultCount)
    jail.setSync('__resultGroupBy', hostApi.resultGroupBy)
    jail.setSync('__resultGrep', hostApi.resultGrep)
    jail.setSync('__resultFlatten', hostApi.resultFlatten)
    jail.setSync('__resultSummarize', hostApi.resultSummarize)
    jail.setSync(
      '__artifactsSave',
      async (data: unknown, runtimeOptions?: Record<string, unknown>) =>
        hostApi.artifactsSave(data, runtimeOptions)
    )
    jail.setSync('__artifactsList', async () => hostApi.artifactsList())

    context.evalSync(SETUP_SOURCE, { timeout: options.executionTimeoutMs })
    const value = await context.evalClosure(EXECUTION_SOURCE, [options.code], {
      arguments: { copy: true },
      result: { copy: true, promise: true },
      timeout: options.executionTimeoutMs,
    })

    return {
      value,
      backend: 'isolated-vm',
    }
  } finally {
    if (isolate) isolate.dispose()
  }
}

export async function executeInSandbox(
  options: SandboxExecutionOptions,
  hostApi: SandboxHostApi
): Promise<SandboxExecutionResult> {
  resolveBackend(options.backend)
  return executeWithIsolatedVm(options, hostApi)
}
