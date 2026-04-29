import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { logger } from '../../../utils/logger'
import { getMCPServers } from './config'
import { callMCPTool, type MCPToolMetadata } from './client'
import { mcpToolCacheManager, type MCPToolCacheItem } from './mcp-cache'

/**
 * MCP 工具描述，包含服务器名称
 */
export interface MCPToolDescription {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, { type: string; description?: string }>
    required?: string[]
  }
  serverName: string
}

/**
 * MCP 工具名称前缀格式
 */
const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 生成 MCP 工具的唯一名称
 * @param serverName 服务器名称
 * @param toolName 工具名称
 * @returns 唯一工具名称
 */
function generateMCPToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`
}

/**
 * 解析 MCP 工具名称
 * @param fullName 完整工具名称
 * @returns 服务器名称和工具名称，如果不是 MCP 工具返回 null
 */
export function parseMCPToolName(
  fullName: string,
): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith(MCP_TOOL_PREFIX)) {
    return null
  }
  const parts = fullName.slice(MCP_TOOL_PREFIX.length).split('__')
  if (parts.length !== 2) {
    return null
  }
  return { serverName: parts[0], toolName: parts[1] }
}

/**
 * 将缓存的工具项转换为 MCP 工具描述
 * @param tool 缓存的工具项
 * @param serverName 服务器名称
 * @returns MCP 工具描述
 */
function convertCacheItemToDescription(
  tool: MCPToolCacheItem,
  serverName: string,
): MCPToolDescription {
  return {
    name: tool.name,
    description: tool.description || `MCP tool: ${tool.name}`,
    inputSchema: tool.inputSchema as MCPToolDescription['inputSchema'],
    serverName,
  }
}

/**
 * 将 MCP 工具转换为 LangChain DynamicStructuredTool
 * @param tool MCP 工具描述
 * @returns LangChain 工具
 */
function convertMCPToolToLangChainTool(tool: MCPToolDescription): DynamicStructuredTool {
  const { name, description, inputSchema, serverName } = tool
  const uniqueName = generateMCPToolName(serverName, name)

  const schemaProperties: Record<string, z.ZodType> = {}
  if (inputSchema.properties) {
    for (const [key, value] of Object.entries(inputSchema.properties)) {
      let zodType: z.ZodType
      // 处理可能不是对象的情况
      const propValue = value as { type?: string; description?: string }
      switch (propValue.type) {
        case 'string':
          zodType = z.string().describe(propValue.description || '')
          break
        case 'number':
          zodType = z.number().describe(propValue.description || '')
          break
        case 'boolean':
          zodType = z.boolean().describe(propValue.description || '')
          break
        case 'array':
          zodType = z.array(z.any()).describe(propValue.description || '')
          break
        case 'object':
          zodType = z.record(z.string(), z.any()).describe(propValue.description || '')
          break
        default:
          zodType = z.any().describe(propValue.description || '')
      }
      schemaProperties[key] = zodType
    }
  }

  const toolSchema = z.object(schemaProperties)

  return new DynamicStructuredTool({
    name: uniqueName,
    description: `${description} [MCP: ${serverName}]`,
    schema: toolSchema,
    func: async (args: Record<string, unknown>) => {
      logger.info(`[MCP] 调用工具: ${serverName}/${name}`)
      try {
        const result = await callMCPTool(serverName, name, args)
        const textContent = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        logger.info(
          `[MCP] 工具返回: ${name}, isError: ${result.isError}, length: ${textContent.length}`,
        )
        return textContent || '(无输出)'
      } catch (error) {
        logger.error(`[MCP] 工具调用失败: ${serverName}/${name}`)
        throw error
      }
    },
  })
}

/**
 * 从缓存加载所有 MCP 工具
 * @returns MCP 工具列表
 */
export async function loadMCPTools(): Promise<DynamicStructuredTool[]> {
  const servers = getMCPServers()

  if (servers.length === 0) {
    return []
  }

  const allTools: DynamicStructuredTool[] = []

  for (const serverConfig of servers) {
    try {
      // 从缓存获取工具列表（缓存不存在会自动创建）
      const cachedTools = await mcpToolCacheManager.getOrCreateCache(serverConfig)

      for (const tool of cachedTools) {
        const toolDesc = convertCacheItemToDescription(tool, serverConfig.name)
        allTools.push(convertMCPToolToLangChainTool(toolDesc))
      }
    } catch (error) {
      logger.warn(`[MCP] 加载 ${serverConfig.name} 失败`)
    }
  }

  logger.info(`[MCP] 已加载 ${allTools.length} 个工具`)
  return allTools
}

/**
 * MCP 工具管理器
 * 提供 MCP 工具的延迟加载和缓存
 */
class MCPToolManager {
  private cachedTools: DynamicStructuredTool[] | null = null
  private loadingPromise: Promise<DynamicStructuredTool[]> | null = null
  private toolsByServer: Map<string, DynamicStructuredTool[]> = new Map()
  /** 工具元数据缓存（轻量级，用于搜索，包含serverName） */
  private cachedMetadata: Array<MCPToolMetadata & { serverName: string }> | null = null

  /**
   * 获取所有 MCP 工具（从缓存加载）
   * @returns MCP 工具列表
   */
  async getTools(): Promise<DynamicStructuredTool[]> {
    if (this.cachedTools !== null) {
      return this.cachedTools
    }

    if (this.loadingPromise) {
      return this.loadingPromise
    }

    this.loadingPromise = loadMCPTools().finally(() => {
      this.loadingPromise = null
    })

    this.cachedTools = await this.loadingPromise
    return this.cachedTools
  }

  /**
   * 轻量级获取所有 MCP 工具元数据（优先从缓存读取，缓存为空时自动获取）
   * @returns 工具元数据列表
   */
  async getToolsMetadata(): Promise<Array<MCPToolMetadata & { serverName: string }>> {
    if (this.cachedMetadata !== null) {
      return this.cachedMetadata
    }

    // 从缓存管理器获取所有工具
    let allTools = mcpToolCacheManager.getAllCachedTools()

    // 如果缓存为空，尝试为每个服务器创建缓存
    if (allTools.length === 0) {
      const servers = getMCPServers()
      if (servers.length > 0) {
        logger.info('[MCP] 工具缓存为空，尝试连接服务器获取工具列表...')
        for (const serverConfig of servers) {
          try {
            await mcpToolCacheManager.getOrCreateCache(serverConfig)
          } catch {
            // 静默失败，继续处理其他服务器
          }
        }
        // 重新获取缓存
        allTools = mcpToolCacheManager.getAllCachedTools()
      }
    }

    const allMetadata: Array<MCPToolMetadata & { serverName: string }> = []

    for (const tool of allTools) {
      allMetadata.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        serverName: tool.serverName,
      })
    }

    // 缓存元数据
    this.cachedMetadata = allMetadata

    return allMetadata
  }

  /**
   * 获取指定服务器的所有工具
   * @param serverName 服务器名称
   * @returns 该服务器的工具列表
   */
  async getToolsByServer(serverName: string): Promise<DynamicStructuredTool[]> {
    if (this.toolsByServer.has(serverName)) {
      return this.toolsByServer.get(serverName)!
    }

    await this.getTools()

    const serverTools =
      this.cachedTools?.filter((tool) => {
        const parsed = parseMCPToolName(tool.name)
        return parsed?.serverName === serverName
      }) || []

    this.toolsByServer.set(serverName, serverTools)
    return serverTools
  }

  /**
   * 获取指定服务器的特定工具
   * @param serverName 服务器名称
   * @param toolName 工具名称（原始名称，不带前缀）
   * @returns 工具实例，不存在返回 undefined
   */
  async getToolByName(
    serverName: string,
    toolName: string,
  ): Promise<DynamicStructuredTool | undefined> {
    const serverTools = await this.getToolsByServer(serverName)
    const fullName = generateMCPToolName(serverName, toolName)
    return serverTools.find((t) => t.name === fullName)
  }

  /**
   * 列出所有可用的 MCP 服务器名称
   * @returns 服务器名称列表
   */
  listAvailableServers(): string[] {
    return getMCPServers().map((s) => s.name)
  }

  /**
   * 列出指定服务器的所有工具名称
   * @param serverName 服务器名称
   * @returns 工具名称列表（原始名称）
   */
  async listServerTools(serverName: string): Promise<string[]> {
    const serverTools = await this.getToolsByServer(serverName)
    return serverTools.map((tool) => {
      const parsed = parseMCPToolName(tool.name)
      return parsed?.toolName || tool.name
    })
  }

  /**
   * 清除缓存，强制重新加载
   */
  async refresh(): Promise<DynamicStructuredTool[]> {
    this.cachedTools = null
    this.cachedMetadata = null
    this.toolsByServer.clear()
    return this.getTools()
  }

  /**
   * 清除工具缓存
   * 在 MCP 配置文件发生变化时调用
   */
  clearCache(): void {
    this.cachedTools = null
    this.cachedMetadata = null
    this.toolsByServer.clear()
  }
}

/** MCP 工具管理器单例 */
export const mcpToolManager = new MCPToolManager()
