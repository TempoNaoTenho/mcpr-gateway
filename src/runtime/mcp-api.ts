import type { HandleRegistry } from './handle-registry.js'

export type RuntimeToolExecutor = (target: {
  serverId: string
  name: string
  args: Record<string, unknown>
}) => Promise<unknown>

export type RuntimeSearchMatchOptions = {
  k?: number
  limit?: number
  serverId?: string
  risk?: string
  tags?: string[]
  requiredArgs?: string[]
  detail?: 'name' | 'summary' | 'signature' | 'full'
}

type RuntimeToolHandle = string | { handle: string }

export class McpRuntimeApi {
  private toolCallCount = 0
  private currentIndex = 0

  constructor(
    private readonly handles: HandleRegistry,
    private readonly executeTool: RuntimeToolExecutor,
    private readonly maxToolCallsPerExecution: number,
    private readonly maxConcurrentCalls = 5,
    private readonly searchOne?: (
      query: string,
      options?: RuntimeSearchMatchOptions
    ) => Record<string, unknown> | null
  ) {}

  async call(handleOrEntry: RuntimeToolHandle, args: Record<string, unknown> = {}): Promise<unknown> {
    const handle =
      typeof handleOrEntry === 'string'
        ? handleOrEntry
        : handleOrEntry &&
            typeof handleOrEntry === 'object' &&
            typeof handleOrEntry.handle === 'string'
          ? handleOrEntry.handle
          : String(handleOrEntry)

    const target = this.handles.resolve(handle)
    if (!target) {
      const usageHint =
        typeof handleOrEntry === 'object' && handleOrEntry !== null
          ? ' Pass the string handle or the object returned by catalog.search()/catalog.list() with its handle field.'
          : ''
      throw new Error(`Unknown tool handle: ${handle}.${usageHint}`)
    }
    this.toolCallCount += 1
    if (this.toolCallCount > this.maxToolCallsPerExecution) {
      throw new Error(`Tool call limit exceeded (${this.maxToolCallsPerExecution})`)
    }
    return this.executeTool({
      serverId: target.serverId,
      name: target.name,
      args,
    })
  }

  async callMatch(
    query: string,
    args: Record<string, unknown> = {},
    options: RuntimeSearchMatchOptions = {}
  ): Promise<unknown> {
    if (!this.searchOne) {
      throw new Error('mcp.callMatch() is unavailable in this runtime.')
    }

    const match = this.searchOne(query, options)
    if (!match || typeof match.handle !== 'string') {
      throw new Error(`No tool match found for "${query}".`)
    }

    return this.call(match.handle, args)
  }

  async batch(
    calls: Array<{ handle: string; args?: Record<string, unknown> }>
  ): Promise<unknown[]> {
    if (calls.length === 0) return []

    if (this.toolCallCount + calls.length > this.maxToolCallsPerExecution) {
      throw new Error(`Tool call limit exceeded (${this.maxToolCallsPerExecution})`)
    }

    const results: unknown[] = new Array(calls.length)
    this.currentIndex = 0

    const worker = async (): Promise<void> => {
      while (true) {
        const index = this.currentIndex++
        if (index >= calls.length) break
        results[index] = await this.call(calls[index].handle, calls[index].args ?? {})
      }
    }

    const workers = Math.min(this.maxConcurrentCalls, calls.length)
    const executing: Promise<void>[] = []
    for (let i = 0; i < workers; i++) {
      executing.push(worker())
    }

    await Promise.all(executing)
    return results
  }
}
