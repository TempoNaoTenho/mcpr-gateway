import type { HandleRegistry } from './handle-registry.js'

export type RuntimeToolExecutor = (target: {
  serverId: string
  name: string
  args: Record<string, unknown>
}) => Promise<unknown>

export class McpRuntimeApi {
  private toolCallCount = 0
  private currentIndex = 0

  constructor(
    private readonly handles: HandleRegistry,
    private readonly executeTool: RuntimeToolExecutor,
    private readonly maxToolCallsPerExecution: number,
    private readonly maxConcurrentCalls = 5
  ) {}

  async call(handle: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const target = this.handles.resolve(handle)
    if (!target) {
      throw new Error(`Unknown tool handle: ${handle}`)
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
