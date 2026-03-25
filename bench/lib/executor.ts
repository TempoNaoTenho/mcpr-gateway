import { estimateSerializedTokens } from '../../src/admin/catalog.js'
import {
  buildCodeModeToolWindow,
  GATEWAY_CALL_TOOL_NAME,
  GATEWAY_SEARCH_TOOL_NAME,
} from '../../src/gateway/discovery.js'
import { projectWindow } from '../../src/gateway/publish/project.js'
import { getConfig } from '../../src/config/index.js'
import type { DownstreamRegistry } from '../../src/registry/registry.js'
import type {
  BenchmarkScenario,
  E2ETaskResult,
  E2EStepResult,
  RetrievalCaseResult,
  RetrievalStepResult,
} from '../types.js'
import { buildBaselineExposure, findServerForTool, rankVisibleToolsForPrompt } from './catalog.js'
import { callToolDirect } from './direct-call.js'
import { BenchmarkMcpClient } from './mcp-client.js'

type StepLike = Pick<
  BenchmarkScenario,
  'expectedTools' | 'expectedServerIds' | 'discoveryQuery' | 'toolArgs' | 'searchLimit'
> & {
  prompt: string
}
type BaselineContext = Pick<BenchmarkScenario, 'namespace' | 'mode' | 'authHeader'> & {
  id?: string
}

type SearchMatch = { name: string; serverId?: string }

function buildCodeModeExposure(namespace: string): {
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  totalTokens: number
} {
  const tools = projectWindow(buildCodeModeToolWindow(namespace), getConfig().selector)
  return {
    tools,
    totalTokens: estimateSerializedTokens(tools),
  }
}

function buildCodeModeRetrievalProgram(query: string, limit: number): string {
  return [
    `const tools = await catalog.search(${JSON.stringify(query)}, { k: ${limit}, detail: "name" })`,
    'return tools',
  ].join('\n')
}

function buildCodeModeE2EProgram(
  query: string,
  limit: number,
  expectedTools: string[],
  toolArgs: Record<string, unknown>,
): string {
  return [
    `const tools = await catalog.search(${JSON.stringify(query)}, { k: ${limit}, detail: "name" })`,
    `const expected = new Set(${JSON.stringify(expectedTools)})`,
    'const match = tools.find((tool) => expected.has(tool.name)) ?? tools[0]',
    'if (!match) {',
    '  return { success: false, error: "No code-mode match found" }',
    '}',
    `const data = await mcp.call(match.handle, ${JSON.stringify(toolArgs)})`,
    'return {',
    '  success: true,',
    '  chosenTool: match.name,',
    '  result: result.summarize(data),',
    '}',
  ].join('\n')
}

function buildInitializeIntent(scenario: BenchmarkScenario): {
  intent: string
  goal: string
  query: string
  taskContext: string
} {
  const firstStep = scenario.sessionSteps?.[0]
  const seedPrompt = firstStep?.prompt ?? scenario.prompt
  const seedQuery = firstStep?.discoveryQuery ?? scenario.discoveryQuery ?? seedPrompt

  return {
    intent: seedPrompt,
    goal: scenario.prompt,
    query: seedQuery,
    taskContext: seedPrompt,
  }
}

function findRank(
  tools: Array<{ name: string; serverId?: string }>,
  scenario: Pick<BenchmarkScenario, 'expectedTools' | 'expectedServerIds'>,
): { rank: number | null; matchedTool?: string; matchedServerId?: string } {
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]!
    if (scenario.expectedTools.includes(tool.name) && (
      !scenario.expectedServerIds ||
      !tool.serverId ||
      scenario.expectedServerIds.includes(tool.serverId)
    )) {
      return {
        rank: index + 1,
        matchedTool: tool.name,
        matchedServerId: tool.serverId,
      }
    }
  }

  return { rank: null }
}

function pickFirstExpectedMatch(
  matches: SearchMatch[],
  scenario: Pick<BenchmarkScenario, 'expectedTools' | 'expectedServerIds'>,
): SearchMatch | undefined {
  for (const match of matches) {
    if (!scenario.expectedTools.includes(match.name)) continue
    if (
      scenario.expectedServerIds &&
      scenario.expectedServerIds.length > 0 &&
      !scenario.expectedServerIds.includes(match.serverId)
    ) {
      continue
    }
    return match
  }
  return undefined
}

function parseSearchResult(raw: unknown): { matches: SearchMatch[]; payload: unknown } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'matches' in raw) {
    const matchesRaw = (raw as { matches?: unknown }).matches
    if (!Array.isArray(matchesRaw)) return { matches: [], payload: raw }
    const matches: SearchMatch[] = []
    for (const entry of matchesRaw) {
      if (!entry || typeof entry !== 'object') continue
      const name = (entry as { name?: unknown }).name
      const serverId = (entry as { serverId?: unknown }).serverId
      if (typeof name === 'string' && typeof serverId === 'string') {
        matches.push({ name, serverId })
      }
    }
    return { matches, payload: raw }
  }
  return { matches: [], payload: raw }
}


function reciprocalRank(rank: number | null): number {
  return rank ? 1 / rank : 0
}

const defaultSearchLimit = 20

export async function runRetrievalCase(
  client: BenchmarkMcpClient,
  registry: DownstreamRegistry,
  scenario: BenchmarkScenario,
): Promise<RetrievalCaseResult> {
  const { sessionId } = await client.initialize(scenario.mode, buildInitializeIntent(scenario))
  const steps = resolveScenarioSteps(scenario)
  const stepResults: RetrievalStepResult[] = []
  let finalGatewayStep: RetrievalStepResult | undefined
  let finalCodeModeStep: RetrievalStepResult | undefined
  let finalBaselineStep: RetrievalStepResult | undefined

  for (const [index, step] of steps.entries()) {
    const result = await evaluateRetrievalStep(client, registry, sessionId, scenario, step)
    stepResults.push(result)
    finalGatewayStep = result
    finalCodeModeStep = result
    finalBaselineStep = result

    if (
      steps.length > 1 &&
      index < steps.length - 1 &&
      result.gateway.matchedTool &&
      result.gateway.matchedServerId
    ) {
      await client.callTool(sessionId, GATEWAY_CALL_TOOL_NAME, {
        name: result.gateway.matchedTool,
        serverId: result.gateway.matchedServerId,
        arguments: step.toolArgs ?? {},
      })
    }
  }

  const gatewayRank = finalGatewayStep?.gateway ?? {
    visibleToolCount: 0,
    totalTokens: 0,
    listCatalogTokens: 0,
    searchResponseTokens: 0,
    matchedTool: undefined,
    matchedServerId: undefined,
    rank: null,
    reciprocalRank: 0,
    hitAt3: false,
    hitAt5: false,
    searchUsed: false,
    searchMatchCount: 0,
  }
  const baselineRank = finalBaselineStep?.baseline ?? {
    visibleToolCount: 0,
    totalTokens: 0,
    matchedTool: undefined,
    matchedServerId: undefined,
    rank: null,
    reciprocalRank: 0,
    hitAt3: false,
    hitAt5: false,
  }
  const codeModeRank = finalCodeModeStep?.codeMode ?? {
    visibleToolCount: 0,
    totalTokens: 0,
    listCatalogTokens: 0,
    runCodeRequestTokens: 0,
    runCodeResponseTokens: 0,
    matchedTool: undefined,
    matchedServerId: undefined,
    rank: null,
    reciprocalRank: 0,
    hitAt3: false,
    hitAt5: false,
  }

  return {
    scenarioId: scenario.id,
    namespace: scenario.namespace,
    prompt: scenario.prompt,
    expectedTools: scenario.expectedTools,
    gateway: gatewayRank,
    codeMode: codeModeRank,
    baseline: baselineRank,
    steps: steps.length > 1 ? stepResults : undefined,
  }
}

export async function runE2ECase(
  client: BenchmarkMcpClient,
  registry: DownstreamRegistry,
  scenario: BenchmarkScenario,
): Promise<E2ETaskResult> {
  const startGateway = Date.now()
  const { sessionId } = await client.initialize(scenario.mode, buildInitializeIntent(scenario))
  const steps = resolveScenarioSteps(scenario)
  const stepResults: E2EStepResult[] = []
  let finalGatewayStep: E2EStepResult | undefined
  let finalCodeModeStep: E2EStepResult | undefined
  let finalBaselineStep: E2EStepResult | undefined

  for (const step of steps) {
    const result = await evaluateE2EStep(client, registry, sessionId, scenario, step)
    stepResults.push(result)
    finalGatewayStep = result
    finalCodeModeStep = result
    finalBaselineStep = result
  }

  const gatewayLatencyMs = Date.now() - startGateway

  const gatewayResult = finalGatewayStep?.gateway ?? {
    success: false,
    chosenTool: undefined,
    chosenServerId: undefined,
    searchUsed: false,
    searchCalls: 0,
    toolCalls: 0,
    visibleToolCount: 0,
    listCatalogTokens: 0,
    searchResponseTokens: 0,
    proxyCallRequestTokens: 0,
    proxyCallResponseTokens: 0,
    totalContextTokens: 0,
    latencyMs: gatewayLatencyMs,
    error: 'No search match for expected tool',
  }
  const baselineResult = finalBaselineStep?.baseline ?? {
    success: false,
    chosenTool: undefined,
    chosenServerId: undefined,
    toolCalls: 0,
    visibleToolCount: 0,
    catalogTokens: 0,
    directCallRequestTokens: 0,
    directCallResponseTokens: 0,
    totalContextTokens: 0,
    latencyMs: 0,
    error: 'No baseline tool selected',
  }
  const codeModeResult = finalCodeModeStep?.codeMode ?? {
    success: false,
    chosenTool: undefined,
    chosenServerId: undefined,
    toolCalls: 1,
    visibleToolCount: 0,
    listCatalogTokens: 0,
    runCodeRequestTokens: 0,
    runCodeResponseTokens: 0,
    totalContextTokens: 0,
    latencyMs: gatewayLatencyMs,
    error: 'No code-mode tool selected',
  }

  return {
    scenarioId: scenario.id,
    namespace: scenario.namespace,
    prompt: scenario.prompt,
    gateway: {
      ...gatewayResult,
      latencyMs: gatewayLatencyMs,
    },
    codeMode: codeModeResult,
    baseline: baselineResult,
    steps: steps.length > 1 ? stepResults : undefined,
  }
}

async function evaluateRetrievalStep(
  client: BenchmarkMcpClient,
  registry: DownstreamRegistry,
  sessionId: string,
  baselineContext: BaselineContext,
  step: StepLike,
): Promise<RetrievalStepResult> {
  const visibleTools = await client.toolsList(sessionId)
  const listCatalogTokens = estimateSerializedTokens(visibleTools)
  const codeModeExposure = buildCodeModeExposure(baselineContext.namespace)

  const searchQuery = step.discoveryQuery ?? step.prompt
  const limit = step.searchLimit ?? defaultSearchLimit
  const searchRaw = await client.callTool(sessionId, GATEWAY_SEARCH_TOOL_NAME, {
    query: searchQuery,
    limit,
  })
  const { matches, payload: searchPayload } = parseSearchResult(searchRaw)
  const searchResponseTokens = estimateSerializedTokens(searchPayload)

  const gatewayRank = findRank(matches, step)
  const gatewayMatchedServerId =
    gatewayRank.matchedServerId ||
    resolveServerIdForTool(registry, baselineContext.namespace, gatewayRank.matchedTool, step.expectedServerIds)

  // Code mode: simulate catalog.search() via local BM25 — same algorithm, avoids isolated-vm execution
  const codeModeProgram = buildCodeModeRetrievalProgram(searchQuery, limit)
  const codeModeRequestTokens = estimateSerializedTokens({ code: codeModeProgram })
  const baselineExposure = await buildBaselineExposure(registry, baselineContext)
  const codeModeLocalRanked = rankVisibleToolsForPrompt(baselineExposure.tools, searchQuery)
  const codeModeMatches: SearchMatch[] = codeModeLocalRanked
    .slice(0, limit)
    .map((t) => ({ name: t.name, serverId: t.serverId }))
  const codeModeResponseTokens = estimateSerializedTokens(codeModeMatches)
  const codeModeRank = findRank(codeModeMatches, step)

  const rankedBaseline = rankVisibleToolsForPrompt(baselineExposure.tools, step.discoveryQuery ?? step.prompt)
  const baselineRank = findRank(rankedBaseline.map((tool) => ({ name: tool.name, serverId: tool.serverId })), step)
  const baselineMatchedServerId =
    baselineRank.matchedServerId ||
    resolveServerIdForTool(registry, baselineContext.namespace, baselineRank.matchedTool, step.expectedServerIds)

  return {
    prompt: step.prompt,
    expectedTools: step.expectedTools,
    gateway: {
      visibleToolCount: visibleTools.length,
      totalTokens: listCatalogTokens + searchResponseTokens,
      listCatalogTokens,
      searchResponseTokens,
      matchedTool: gatewayRank.matchedTool,
      matchedServerId: gatewayMatchedServerId,
      rank: gatewayRank.rank,
      reciprocalRank: reciprocalRank(gatewayRank.rank),
      hitAt3: gatewayRank.rank !== null && gatewayRank.rank <= 3,
      hitAt5: gatewayRank.rank !== null && gatewayRank.rank <= 5,
      searchUsed: true,
      searchMatchCount: matches.length,
    },
    codeMode: {
      visibleToolCount: codeModeExposure.tools.length,
      totalTokens: codeModeExposure.totalTokens + codeModeRequestTokens + codeModeResponseTokens,
      listCatalogTokens: codeModeExposure.totalTokens,
      runCodeRequestTokens: codeModeRequestTokens,
      runCodeResponseTokens: codeModeResponseTokens,
      matchedTool: codeModeRank.matchedTool,
      matchedServerId: codeModeRank.matchedServerId,
      rank: codeModeRank.rank,
      reciprocalRank: reciprocalRank(codeModeRank.rank),
      hitAt3: codeModeRank.rank !== null && codeModeRank.rank <= 3,
      hitAt5: codeModeRank.rank !== null && codeModeRank.rank <= 5,
    },
    baseline: {
      visibleToolCount: baselineExposure.tools.length,
      totalTokens: baselineExposure.totalTokens,
      matchedTool: baselineRank.matchedTool,
      matchedServerId: baselineMatchedServerId,
      rank: baselineRank.rank,
      reciprocalRank: reciprocalRank(baselineRank.rank),
      hitAt3: baselineRank.rank !== null && baselineRank.rank <= 3,
      hitAt5: baselineRank.rank !== null && baselineRank.rank <= 5,
    },
  }
}

async function evaluateE2EStep(
  client: BenchmarkMcpClient,
  registry: DownstreamRegistry,
  sessionId: string,
  baselineContext: BaselineContext,
  step: StepLike,
): Promise<E2EStepResult> {
  const namespace = baselineContext.namespace
  const startGateway = Date.now()
  const startCodeMode = Date.now()

  const visibleTools = await client.toolsList(sessionId)
  const listCatalogTokens = estimateSerializedTokens(visibleTools)
  const codeModeExposure = buildCodeModeExposure(namespace)

  const searchQuery = step.discoveryQuery ?? step.prompt
  const limit = step.searchLimit ?? defaultSearchLimit
  let searchRaw: unknown
  try {
    searchRaw = await client.callTool(sessionId, GATEWAY_SEARCH_TOOL_NAME, {
      query: searchQuery,
      limit,
    })
  } catch (error) {
    const gatewayLatencyMs = Date.now() - startGateway
    const codeModeProgram = buildCodeModeE2EProgram(searchQuery, limit, step.expectedTools, step.toolArgs ?? {})
    const codeModeRequestTokens = estimateSerializedTokens({ code: codeModeProgram })
    const baselineOnError = await evaluateBaselineE2EBlock(registry, baselineContext, namespace, step)
    const codeModeRespTokens = estimateSerializedTokens(
      baselineOnError.chosenTool ? { success: baselineOnError.success } : { error: baselineOnError.error },
    )
    return {
      prompt: step.prompt,
      expectedTools: step.expectedTools,
      gateway: {
        success: false,
        searchUsed: true,
        searchCalls: 1,
        toolCalls: 1,
        visibleToolCount: visibleTools.length,
        listCatalogTokens,
        searchResponseTokens: 0,
        proxyCallRequestTokens: 0,
        proxyCallResponseTokens: 0,
        totalContextTokens: listCatalogTokens,
        latencyMs: gatewayLatencyMs,
        error: error instanceof Error ? error.message : String(error),
      },
      codeMode: {
        success: baselineOnError.success,
        chosenTool: baselineOnError.chosenTool,
        chosenServerId: baselineOnError.chosenServerId,
        toolCalls: 1,
        visibleToolCount: codeModeExposure.tools.length,
        listCatalogTokens: codeModeExposure.totalTokens,
        runCodeRequestTokens: codeModeRequestTokens,
        runCodeResponseTokens: codeModeRespTokens,
        totalContextTokens: codeModeExposure.totalTokens + codeModeRequestTokens + codeModeRespTokens,
        latencyMs: Date.now() - startCodeMode,
        error: baselineOnError.error,
      },
      baseline: baselineOnError,
    }
  }

  const { matches, payload: searchPayload } = parseSearchResult(searchRaw)
  const searchResponseTokens = estimateSerializedTokens(searchPayload)
  const match = pickFirstExpectedMatch(matches, step)

  let proxyCallRequestTokens = 0
  let proxyCallResponseTokens = 0
  let gatewaySuccess = false
  let gatewayError: string | undefined
  let chosenTool: string | undefined
  let chosenServerId: string | undefined
  let toolCalls = 1

  if (!match) {
    gatewayError = 'Expected tool not found in gateway_search_tools matches'
  } else {
    chosenTool = match.name
    chosenServerId = match.serverId
    const proxyArgs = {
      name: match.name,
      serverId: match.serverId,
      arguments: step.toolArgs ?? {},
    }
    proxyCallRequestTokens = estimateSerializedTokens(proxyArgs)
    toolCalls = 2
    try {
      const callResult = await client.callTool(sessionId, GATEWAY_CALL_TOOL_NAME, proxyArgs)
      proxyCallResponseTokens = estimateSerializedTokens(callResult)
      gatewaySuccess = true
    } catch (error) {
      gatewayError = error instanceof Error ? error.message : String(error)
    }
  }

  const gatewayLatencyMs = Date.now() - startGateway
  const totalContextTokens =
    listCatalogTokens + searchResponseTokens + proxyCallRequestTokens + proxyCallResponseTokens

  // Code mode: simulate catalog.search() + mcp.call() locally — avoids isolated-vm execution in benchmark
  // catalog.search() uses the same BM25 ranking as the baseline exposure
  const codeModeProgram = buildCodeModeE2EProgram(searchQuery, limit, step.expectedTools, step.toolArgs ?? {})
  const codeModeRequestTokens = estimateSerializedTokens({ code: codeModeProgram })
  const baselineBlock = await evaluateBaselineE2EBlock(registry, baselineContext, namespace, step)
  const codeModeResponseTokens = estimateSerializedTokens(
    baselineBlock.chosenTool ? { success: baselineBlock.success, chosenTool: baselineBlock.chosenTool } : { error: baselineBlock.error },
  )
  const codeModeLatencyMs = Date.now() - startCodeMode

  return {
    prompt: step.prompt,
    expectedTools: step.expectedTools,
    gateway: {
      success: gatewaySuccess,
      chosenTool,
      chosenServerId,
      searchUsed: true,
      searchCalls: 1,
      toolCalls,
      visibleToolCount: visibleTools.length,
      listCatalogTokens,
      searchResponseTokens,
      proxyCallRequestTokens,
      proxyCallResponseTokens,
      totalContextTokens,
      latencyMs: gatewayLatencyMs,
      error: gatewayError,
    },
    codeMode: {
      success: baselineBlock.success,
      chosenTool: baselineBlock.chosenTool,
      chosenServerId: baselineBlock.chosenServerId,
      toolCalls: 1,
      visibleToolCount: codeModeExposure.tools.length,
      listCatalogTokens: codeModeExposure.totalTokens,
      runCodeRequestTokens: codeModeRequestTokens,
      runCodeResponseTokens: codeModeResponseTokens,
      totalContextTokens: codeModeExposure.totalTokens + codeModeRequestTokens + codeModeResponseTokens,
      latencyMs: codeModeLatencyMs,
      error: baselineBlock.error,
    },
    baseline: baselineBlock,
  }
}

async function evaluateBaselineE2EBlock(
  registry: DownstreamRegistry,
  baselineContext: BaselineContext,
  namespace: string,
  step: StepLike,
): Promise<E2EStepResult['baseline']> {
  const startBaseline = Date.now()
  const baselineExposure = await buildBaselineExposure(registry, baselineContext)
  const baselineRanked = rankVisibleToolsForPrompt(baselineExposure.tools, step.discoveryQuery ?? step.prompt)
  const baselineChosen = baselineRanked[0]
  if (!baselineChosen) {
    return {
      success: false,
      toolCalls: 0,
      visibleToolCount: baselineExposure.tools.length,
      catalogTokens: baselineExposure.totalTokens,
      directCallRequestTokens: 0,
      directCallResponseTokens: 0,
      totalContextTokens: baselineExposure.totalTokens,
      latencyMs: Date.now() - startBaseline,
      error: 'No baseline tool selected',
    }
  }
  return evaluateBaselineCall(
    registry,
    baselineContext,
    namespace,
    step,
    baselineExposure,
    baselineChosen,
    startBaseline,
  )
}

async function evaluateBaselineCall(
  registry: DownstreamRegistry,
  baselineContext: BaselineContext,
  namespace: string,
  step: StepLike,
  baselineExposure: Awaited<ReturnType<typeof buildBaselineExposure>>,
  baselineChosen: { name: string; serverId: string },
  startBaseline: number,
): Promise<E2EStepResult['baseline']> {
  const directCallRequestTokens = estimateSerializedTokens({
    name: baselineChosen.name,
    arguments: step.toolArgs ?? {},
  })
  const baselineChosenServerId =
    resolveServerIdForTool(registry, baselineContext.namespace, baselineChosen.name, step.expectedServerIds) ||
    baselineChosen.serverId

  let baselineSuccess = false
  let baselineError: string | undefined
  let directCallResponseTokens = 0

  try {
    const server = await findServerForTool(registry, namespace, baselineChosen.name)
    if (!server) {
      throw new Error(`Server not found for tool ${baselineChosen.name}`)
    }
    const response = await callToolDirect(
      server,
      baselineChosen.name,
      step.toolArgs ?? {},
      getConfig().resilience.timeouts.responseMs,
    )
    if (response.error !== undefined) {
      directCallResponseTokens = estimateSerializedTokens(response.error)
      baselineError = JSON.stringify(response.error)
    } else {
      directCallResponseTokens = estimateSerializedTokens(response.result ?? null)
      baselineSuccess = response.error === undefined && step.expectedTools.includes(baselineChosen.name)
    }
  } catch (error) {
    baselineError = error instanceof Error ? error.message : String(error)
    directCallResponseTokens = estimateSerializedTokens(baselineError)
  }

  const totalContextTokens =
    baselineExposure.totalTokens + directCallRequestTokens + directCallResponseTokens

  return {
    success: baselineSuccess,
    chosenTool: baselineChosen.name,
    chosenServerId: baselineChosenServerId,
    toolCalls: 1,
    visibleToolCount: baselineExposure.tools.length,
    catalogTokens: baselineExposure.totalTokens,
    directCallRequestTokens,
    directCallResponseTokens,
    totalContextTokens,
    latencyMs: Date.now() - startBaseline,
    error: baselineError,
  }
}

function resolveScenarioSteps(scenario: BenchmarkScenario): StepLike[] {
  const scenarioSearchLimit = scenario.searchLimit
  if (scenario.sessionSteps && scenario.sessionSteps.length > 0) {
    return scenario.sessionSteps.map((s) => ({
      prompt: s.prompt,
      expectedTools: s.expectedTools,
      expectedServerIds: s.expectedServerIds,
      discoveryQuery: s.discoveryQuery,
      toolArgs: s.toolArgs,
      searchLimit: s.searchLimit ?? scenarioSearchLimit,
    }))
  }

  return [{
    prompt: scenario.prompt,
    expectedTools: scenario.expectedTools,
    expectedServerIds: scenario.expectedServerIds,
    discoveryQuery: scenario.discoveryQuery,
    toolArgs: scenario.toolArgs,
    searchLimit: scenarioSearchLimit,
  }]
}

function resolveServerIdForTool(
  registry: DownstreamRegistry,
  namespace: string,
  toolName?: string,
  expectedServerIds?: string[],
): string | undefined {
  if (!toolName) return undefined
  for (const { server, records } of registry.getToolsByNamespace(namespace)) {
    if (!records.some((record) => record.name === toolName)) continue
    if (expectedServerIds && expectedServerIds.length > 0 && !expectedServerIds.includes(server.id)) continue
    return server.id
  }
  return undefined
}
