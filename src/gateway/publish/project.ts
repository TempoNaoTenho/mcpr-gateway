import type { SelectorConfig } from '../../config/schemas.js'
import type { PublicTool, VisibleTool } from '../../types/tools.js'
import { GATEWAY_SERVER_ID } from '../gateway-constants.js'
import { compressDescription, compressSchema } from './compress.js'

export function projectToPublic(
  tool: VisibleTool,
  selectorConfig?: SelectorConfig,
): PublicTool {
  if (tool.serverId === GATEWAY_SERVER_ID) {
    return {
      name: tool.name,
      ...(tool.description !== undefined && { description: tool.description }),
      inputSchema: structuredClone(tool.inputSchema),
    }
  }

  const publication = selectorConfig?.publication
  const description = compressDescription(tool.description, publication)
  const inputSchema = compressSchema(tool.inputSchema, publication)

  return {
    name: tool.name,
    ...(description !== undefined && { description }),
    inputSchema,
  }
}

export function projectWindow(
  tools: VisibleTool[],
  selectorConfig?: SelectorConfig,
): PublicTool[] {
  return tools.map((tool) => projectToPublic(tool, selectorConfig))
}
