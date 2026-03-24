import type { CodeModeConfig } from '../config/schemas.js'
import type { SessionState } from '../types/session.js'
import type { IRegistryAdapter } from '../types/interfaces.js'
import { GatewayMode } from '../types/enums.js'
import { artifactStore } from './artifact-store.js'
import { CatalogRuntimeApi } from './catalog-api.js'
import { HandleRegistry } from './handle-registry.js'
import { buildGatewayHelp } from './help.js'
import { McpRuntimeApi, type RuntimeToolExecutor } from './mcp-api.js'
import { count, flatten, grep, groupBy, limit, pick, summarize } from './result-api.js'
import { executeInSandbox } from './sandbox.js'

function byteSizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

export async function executeCodeMode(
  code: string,
  session: SessionState,
  registry: IRegistryAdapter,
  config: CodeModeConfig,
  executeTool: RuntimeToolExecutor
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
    },
    {
      catalogSearch: (query, options) => catalog.search(query, options),
      catalogList: (filters) => catalog.list(filters),
      catalogDescribe: (handle, options) => catalog.describe(handle, options),
      mcpCall: (handle, args) => mcp.call(handle, args),
      mcpBatch: (calls) => mcp.batch(calls),
      resultPick: pick,
      resultLimit: limit,
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
    }
  )

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
