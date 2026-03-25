import type { DownstreamServer } from '../../src/types/server.js'
import { callToolHttp } from '../../src/registry/transport/http.js'
import { callToolStdio } from '../../src/registry/transport/stdio.js'

export async function callToolDirect(
  server: DownstreamServer,
  toolName: string,
  args: unknown,
  responseTimeoutMs?: number,
): Promise<{ result?: unknown; error?: unknown }> {
  if (server.transport === 'stdio') {
    return callToolStdio(server, toolName, args)
  }

  return callToolHttp(server, toolName, args, responseTimeoutMs)
}
