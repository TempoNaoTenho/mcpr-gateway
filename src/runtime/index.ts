import type { CodeModeConfig } from '../config/schemas.js'
import type { SessionState } from '../types/session.js'
import type { IRegistryAdapter } from '../types/interfaces.js'
import { GatewayMode } from '../types/enums.js'
import { artifactStore } from './artifact-store.js'
import { CatalogRuntimeApi } from './catalog-api.js'
import { HandleRegistry } from './handle-registry.js'
import { buildGatewayHelp } from './help.js'
import { McpRuntimeApi, type RuntimeToolExecutor } from './mcp-api.js'
import { count, flatten, grep, groupBy, items, limit, pick, summarize, text } from './result-api.js'
import {
  executeInSandbox,
  type SandboxDiagnosticEvent,
  type SandboxDiagnostics,
} from './sandbox.js'

function byteSizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

function deriveOperationTimeoutMs(executionTimeoutMs: number): number {
  return Math.max(25, executionTimeoutMs - 25)
}

function extractNestedValidationError(message: string): Error | undefined {
  const toolMatch = message.match(/Invalid arguments for tool ([^:]+):\s*(\[[\s\S]*\])$/)
  if (!toolMatch) return undefined

  const toolName = toolMatch[1]
  const rawIssues = toolMatch[2]

  try {
    const issues = JSON.parse(rawIssues) as Array<{
      path?: unknown[]
      message?: string
      expected?: string
    }>
    const first = issues[0]
    const field =
      Array.isArray(first?.path) && typeof first.path[0] === 'string' ? first.path[0] : 'input'
    const detail =
      typeof first?.message === 'string' && first.message.length > 0
        ? first.message
        : typeof first?.expected === 'string'
          ? `expected ${first.expected}`
          : 'invalid input'
    return new Error(`Tool validation failed for ${toolName}: ${field} (${detail}).`)
  } catch {
    return new Error(`Tool validation failed for ${toolName}. Check catalog.describe(handle, { detail: "signature" }) and retry with matching args.`)
  }
}

function normalizeCodeModeError(error: unknown, maxResultSizeBytes: number): Error {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes("Identifier 'result' has already been declared")) {
    return new Error(
      '`result` is reserved in code mode. Rename your local variable to something like `rows`, `out`, or `data`.',
      { cause: error instanceof Error ? error : undefined }
    )
  }

  if (message.includes('could not be cloned') || message.includes('non-transferable')) {
    return new Error(
      'The returned value could not be serialized back from the sandbox. Return plain JSON data or normalize it with JSON.parse(JSON.stringify(value)). Use result.pick() or result.limit() for rich tool outputs.',
      { cause: error instanceof Error ? error : undefined }
    )
  }

  if (message.includes('result.limit expects an array')) {
    return new Error(message, { cause: error instanceof Error ? error : undefined })
  }

  if (message.includes("Cannot read properties of undefined (reading 'handle')")) {
    return new Error(
      'The script tried to use a missing tool entry (for example tools[1].handle). Check tools.length first, increase k, or relax the search filters before building the call or batch.',
      { cause: error instanceof Error ? error : undefined }
    )
  }

  if (message.includes('Invalid arguments for tool')) {
    const normalized = extractNestedValidationError(message)
    if (normalized) {
      return new Error(normalized.message, { cause: error instanceof Error ? error : undefined })
    }
  }

  if (message.includes('timed out after')) {
    return new Error(message, { cause: error instanceof Error ? error : undefined })
  }

  if (message.toLowerCase().includes('timeout')) {
    return new Error(
      'Code execution timed out. Reduce the work per call or split it into smaller steps.',
      { cause: error instanceof Error ? error : undefined }
    )
  }

  if (message.includes('Artifact store unavailable')) {
    return new Error(
      `The result exceeded the inline response limit (${maxResultSizeBytes} bytes) and storing it as an artifact failed.`,
      { cause: error instanceof Error ? error : undefined }
    )
  }

  return error instanceof Error ? error : new Error(message)
}

export type CodeModeDiagnostics = SandboxDiagnostics
export type { SandboxDiagnosticEvent }

export async function executeCodeMode(
  code: string,
  session: SessionState,
  registry: IRegistryAdapter,
  config: CodeModeConfig,
  executeTool: RuntimeToolExecutor,
  diagnostics: CodeModeDiagnostics = {},
): Promise<unknown> {
  const ttlMs = config.artifactStoreTtlSeconds * 1000
  const handles =
    (session as unknown as { handleRegistry?: HandleRegistry }).handleRegistry ??
    new HandleRegistry(ttlMs)
  if (!(session as unknown as { handleRegistry?: HandleRegistry }).handleRegistry) {
    ;(session as unknown as { handleRegistry: HandleRegistry }).handleRegistry = handles
  }
  const catalog = new CatalogRuntimeApi(session, registry, handles)
  const mcp = new McpRuntimeApi(handles, executeTool, config.maxToolCallsPerExecution)

  const sandboxResult = await executeInSandbox(
    {
      code,
      memoryLimitMb: config.memoryLimitMb,
      executionTimeoutMs: config.executionTimeoutMs,
      operationTimeoutMs: deriveOperationTimeoutMs(config.executionTimeoutMs),
    },
    {
      catalogSearch: (query, options) => catalog.search(query, options),
      catalogList: (filters) => catalog.list(filters),
      catalogDescribe: (handle, options) => catalog.describe(handle, options),
      mcpCall: (handle, args) => mcp.call(handle, args),
      mcpBatch: (calls) => mcp.batch(calls),
      resultPick: pick,
      resultLimit: limit,
      resultItems: items,
      resultText: text,
      resultCount: count,
      resultGroupBy: groupBy,
      resultGrep: grep,
      resultFlatten: flatten,
      resultSummarize: summarize,
      artifactsSave: (data, options) =>
        artifactStore.save(data, {
          label: typeof options?.['label'] === 'string' ? options['label'] : undefined,
          ttlSeconds: config.artifactStoreTtlSeconds,
        }),
      artifactsList: () => artifactStore.list(),
    },
    diagnostics
  ).catch((error) => {
    throw normalizeCodeModeError(error, config.maxResultSizeBytes)
  })

  const finalResult = {
    backend: sandboxResult.backend,
    value: sandboxResult.value,
  }

  if (byteSizeOf(finalResult) <= config.maxResultSizeBytes) {
    return finalResult
  }

  const artifact = artifactStore.save(finalResult, {
    label: 'gateway_run_code result',
    ttlSeconds: config.artifactStoreTtlSeconds,
  })
  if (artifact && typeof artifact === 'object' && typeof artifact.ref === 'string') {
    return {
      backend: sandboxResult.backend,
      artifactRef: artifact.ref,
      byteSize: artifact.byteSize,
      preview: artifact.preview,
    }
  }
  return finalResult
}

export function executeCodeModeHelp(
  topic?: string,
  gatewayMode?: GatewayMode
): { topic: string; text: string } {
  return buildGatewayHelp(topic, gatewayMode)
}

export { artifactStore }
