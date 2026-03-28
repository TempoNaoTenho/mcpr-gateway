import { spawn } from 'node:child_process'
import type { DownstreamServer } from '../../types/server.js'
import type { ToolSchema } from '../../types/tools.js'

const DEFAULT_TIMEOUT_MS = 15_000
const STDERR_TAIL_LIMIT = 600
const LOOPBACK_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s"'<>)]*/gi

function getTimeoutMs(server: DownstreamServer): number {
  return (server.stdioTimeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000
}

function pushTail(current: string, chunk: Buffer): string {
  const next = `${current}${chunk.toString()}`
  return next.length <= STDERR_TAIL_LIMIT ? next : next.slice(-STDERR_TAIL_LIMIT)
}

function summarizeStderr(stderrTail: string): string | undefined {
  const summary = stderrTail
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' | ')
    .trim()
  return summary.length > 0 ? summary : undefined
}

function extractLoopbackUrl(text: string): string | undefined {
  const matches = text.match(LOOPBACK_URL_RE)
  return matches?.at(-1)
}

function looksInteractive(text: string | undefined): boolean {
  if (!text) return false
  return /(oauth\/callback|oauth callback|redirect_?uri|device code|authentication required|waiting for authorization|authorize|browser|login|localhost:\d+|127\.0\.0\.1:\d+)/i.test(
    text
  )
}

function buildTimeoutError(server: DownstreamServer, timeoutMs: number, stderrTail: string): Error {
  const summary = summarizeStderr(stderrTail)
  let message = `[registry/stdio] Server ${server.id} timed out after ${timeoutMs}ms`
  if (summary) {
    message += `; stderr: ${summary}`
  }
  if (looksInteractive(stderrTail)) {
    message += '; the process appears to be waiting for local browser or device authentication'
  } else {
    message += '; increase stdioTimeoutSeconds if this server needs longer startup'
  }
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export type StdioToolsListSessionUpdate = {
  message?: string
  interactiveDetected: boolean
  interactiveUrl?: string
}

export type StdioToolsListSessionHandle = {
  completion: Promise<ToolSchema[]>
  cancel: (reason?: string) => void
}

export function startToolsListStdioSession(
  server: DownstreamServer,
  options: {
    timeoutMs?: number
    onUpdate?: (update: StdioToolsListSessionUpdate) => void
  } = {}
): StdioToolsListSessionHandle {
  const command = server.command!
  const args = server.args ?? []
  const env = { ...process.env, ...(server.env ?? {}) }
  const timeoutMs = options.timeoutMs ?? getTimeoutMs(server)

  let child: ReturnType<typeof spawn> | undefined
  let finished = false
  let stderrTail = ''
  let lastSummary: string | undefined
  let lastInteractiveUrl: string | undefined
  let lastInteractiveDetected = false
  let nextId = 1
  let buffer = ''
  let toolsResponseReceived = false
  let rejectCompletion: ((reason?: unknown) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const pendingMessages: Map<number, (msg: Record<string, unknown>) => void> = new Map()

  const completion = new Promise<ToolSchema[]>((resolve, reject) => {
    rejectCompletion = reject
    child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const processChild = child
    const processStdin = processChild.stdin

    const finish = (callback: () => void): void => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      callback()
    }

    const publishUpdate = (): void => {
      const summary = summarizeStderr(stderrTail)
      const interactiveUrl = extractLoopbackUrl(stderrTail)
      const interactiveDetected = looksInteractive(stderrTail)
      if (
        summary === lastSummary &&
        interactiveUrl === lastInteractiveUrl &&
        interactiveDetected === lastInteractiveDetected
      ) {
        return
      }
      lastSummary = summary
      lastInteractiveUrl = interactiveUrl
      lastInteractiveDetected = interactiveDetected
      options.onUpdate?.({
        message: summary,
        interactiveDetected,
        interactiveUrl,
      })
    }

    timer = setTimeout(() => {
      clearTimeout(timer)
      processChild.kill()
      finish(() => reject(buildTimeoutError(server, timeoutMs, stderrTail)))
    }, timeoutMs)

    function sendMessage(msg: Record<string, unknown>): Promise<void> {
      if (!processStdin || processStdin.destroyed || processStdin.writableEnded) {
        return Promise.reject(
          buildStdioWriteError(server, 'tools/list', new Error('stdin is not writable'), stderrTail)
        )
      }

      return new Promise((res, rej) => {
        processStdin.write(JSON.stringify(msg) + '\n', (error) => {
          if (error) {
            rej(buildStdioWriteError(server, 'tools/list', error, stderrTail))
            return
          }
          res()
        })
      })
    }

    function sendRequest(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> {
      return new Promise((res, rej) => {
        const id = nextId++
        pendingMessages.set(id, res)
        void sendMessage({ jsonrpc: '2.0', id, method, params }).catch((error) => {
          pendingMessages.delete(id)
          rej(error)
        })
      })
    }

    function sendNotification(method: string, params: Record<string, unknown> = {}): void {
      void sendMessage({ jsonrpc: '2.0', method, params }).catch((error) => {
        finish(() => reject(error))
      })
    }

    function processLine(line: string): void {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }

      const id = msg['id'] as number | undefined
      if (id !== undefined && pendingMessages.has(id)) {
        const resolver = pendingMessages.get(id)!
        pendingMessages.delete(id)
        resolver(msg)
      }
    }

    processChild.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) processLine(line)
      }
    })

    processChild.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = pushTail(stderrTail, chunk)
      publishUpdate()
    })

    processChild.on('error', (err) => {
      finish(() => reject(buildSpawnError(command, err, stderrTail)))
    })

    processStdin?.on('error', (err: Error) => {
      finish(() => reject(buildStdioWriteError(server, 'tools/list', err, stderrTail)))
    })

    processChild.on('close', (code) => {
      if (!toolsResponseReceived) {
        finish(() => reject(buildExitError(server, code, 'tools/list', stderrTail)))
      }
    })

    async function run(): Promise<void> {
      try {
        const initResp = await sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mcpr-gateway', version: '1.0.0' },
        })

        if (initResp['error']) {
          throw new Error(
            `[registry/stdio] initialize failed: ${JSON.stringify(initResp['error'])}`
          )
        }

        sendNotification('notifications/initialized')

        const toolsResp = await sendRequest('tools/list')
        if (toolsResp['error']) {
          throw new Error(
            `[registry/stdio] tools/list failed: ${JSON.stringify(toolsResp['error'])}`
          )
        }

        toolsResponseReceived = true
        const tools = (toolsResp['result'] as Record<string, unknown>)?.['tools']
        if (!Array.isArray(tools)) {
          throw new Error(
            `[registry/stdio] Server ${server.id} missing result.tools in tools/list response`
          )
        }

        processChild.kill()
        finish(() => resolve(tools as ToolSchema[]))
      } catch (err) {
        processChild.kill()
        finish(() => reject(err))
      }
    }

    void run()
  })

  return {
    completion,
    cancel(reason = `[registry/stdio] Interactive auth session cancelled for ${server.id}`) {
      if (!child || finished) return
      if (timer) clearTimeout(timer)
      child.kill()
      finished = true
      rejectCompletion?.(new Error(reason))
    },
  }
}

function buildExitError(
  server: DownstreamServer,
  code: number | null,
  operation: 'tools/list' | 'tools/call',
  stderrTail: string
): Error {
  const summary = summarizeStderr(stderrTail)
  let message = `[registry/stdio] Server ${server.id} exited (code ${code}) before ${operation} response`
  if (summary) {
    message += `; stderr: ${summary}`
  }
  return new Error(message)
}

function buildSpawnError(command: string, err: Error, stderrTail: string): Error {
  const summary = summarizeStderr(stderrTail)
  let message = `[registry/stdio] Failed to spawn ${command}: ${err.message}`
  if (summary) {
    message += `; stderr: ${summary}`
  }
  return new Error(message)
}

function buildStdioWriteError(
  server: DownstreamServer,
  operation: 'tools/list' | 'tools/call',
  err: Error,
  stderrTail: string
): Error {
  const summary = summarizeStderr(stderrTail)
  let message = `[registry/stdio] Server ${server.id} closed stdin before ${operation}: ${err.message}`
  if (summary) {
    message += `; stderr: ${summary}`
  }
  return new Error(message)
}

export async function callToolStdio(
  server: DownstreamServer,
  toolName: string,
  args: unknown
): Promise<{ result?: unknown; error?: unknown }> {
  const command = server.command!
  const spawnArgs = server.args ?? []
  const env = { ...process.env, ...(server.env ?? {}) }
  const timeoutMs = getTimeoutMs(server)

  return new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
    const child = spawn(command, spawnArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderrTail = ''
    let settled = false

    function rejectOnce(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    function resolveOnce(value: { result?: unknown; error?: unknown }): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      clearTimeout(timer)
      child.kill()
      rejectOnce(buildTimeoutError(server, timeoutMs, stderrTail))
    }, timeoutMs)

    let buffer = ''
    let callResponseReceived = false

    const pendingMessages: Map<number, (msg: Record<string, unknown>) => void> = new Map()
    let nextId = 1

    function sendMessage(msg: Record<string, unknown>): Promise<void> {
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        return Promise.reject(
          buildStdioWriteError(server, 'tools/call', new Error('stdin is not writable'), stderrTail)
        )
      }

      return new Promise((res, rej) => {
        child.stdin.write(JSON.stringify(msg) + '\n', (error) => {
          if (error) {
            rej(buildStdioWriteError(server, 'tools/call', error, stderrTail))
            return
          }
          res()
        })
      })
    }

    function sendRequest(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> {
      return new Promise((res, rej) => {
        const id = nextId++
        pendingMessages.set(id, res)
        void sendMessage({ jsonrpc: '2.0', id, method, params }).catch((error) => {
          pendingMessages.delete(id)
          rej(error)
        })
      })
    }

    function sendNotification(method: string, params: Record<string, unknown> = {}): void {
      void sendMessage({ jsonrpc: '2.0', method, params }).catch((error) => {
        rejectOnce(error)
      })
    }

    function processLine(line: string): void {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }

      const id = msg['id'] as number | undefined
      if (id !== undefined && pendingMessages.has(id)) {
        const resolver = pendingMessages.get(id)!
        pendingMessages.delete(id)
        resolver(msg)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) processLine(line)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = pushTail(stderrTail, chunk)
    })

    child.on('error', (err) => {
      rejectOnce(buildSpawnError(command, err, stderrTail))
    })

    child.stdin.on('error', (err: Error) => {
      rejectOnce(buildStdioWriteError(server, 'tools/call', err, stderrTail))
    })

    child.on('close', (code) => {
      if (!callResponseReceived) {
        rejectOnce(buildExitError(server, code, 'tools/call', stderrTail))
      }
    })

    async function run(): Promise<void> {
      try {
        const initResp = await sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mcpr-gateway', version: '1.0.0' },
        })

        if (initResp['error']) {
          throw new Error(
            `[registry/stdio] initialize failed: ${JSON.stringify(initResp['error'])}`
          )
        }

        sendNotification('notifications/initialized')

        const callResp = await sendRequest('tools/call', {
          name: toolName,
          arguments: args as Record<string, unknown>,
        })

        callResponseReceived = true
        child.kill()

        const result = (callResp['result'] as Record<string, unknown>) ?? undefined
        const error = callResp['error'] ?? undefined
        resolveOnce({ result, error })
      } catch (err) {
        child.kill()
        rejectOnce(err instanceof Error ? err : new Error(String(err)))
      }
    }

    void run()
  })
}

export async function fetchToolsStdio(server: DownstreamServer): Promise<ToolSchema[]> {
  return startToolsListStdioSession(server).completion
}
