import { DynamicStructuredTool } from '@langchain/core/tools'
import { logger } from '../../utils/logger'
import { baseToolsByName } from './core-tools'
import { mcpToolManager, parseMCPToolName } from './mcp'

export type { DynamicStructuredTool }

/**
 * 工具类型枚举
 */
export enum ToolType {
  /** 核心工具（常驻） */
  CORE = 'core',
  /** MCP 工具（动态装载） */
  MCP = 'mcp',
}

/**
 * 工具信息
 */
export interface ToolInfo {
  /** 工具实例 */
  tool: DynamicStructuredTool
  /** 工具类型 */
  type: ToolType
  /** 是否已激活（MCP工具需要装载后才激活） */
  isActive: boolean
}

/**
 * ToolRegister - 统一工具注册中心
 *
 * 职责：
 * 1. 管理核心工具（常驻，直接绑定给模型）
 * 2. 按名称查询工具（自动区分核心/MCP）
 * 3. 装载/卸载 MCP 工具
 * 4. 获取激活工具列表（核心 + 已装载的MCP）
 * 5. 自动装载机制（调用未装载的MCP工具时自动装载）
 */
class ToolRegister {
  /** 核心工具映射表（延迟初始化以避免循环依赖） */
  private coreTools: Map<string, DynamicStructuredTool> | null = null
  /** 会话级已装载的MCP工具缓存 */
  private readonly loadedMCPTools: Map<string, DynamicStructuredTool>

  constructor() {
    this.loadedMCPTools = new Map()
  }

  /**
   * 获取核心工具映射表（延迟初始化）
   */
  private getCoreToolsMap(): Map<string, DynamicStructuredTool> {
    if (this.coreTools === null) {
      this.coreTools = new Map(Object.entries(baseToolsByName).map(([name, tool]) => [name, tool]))
      logger.info(`[ToolRegister] 核心工具映射表初始化完成，工具数量: ${this.coreTools.size}`)
    }
    return this.coreTools
  }

  /**
   * 清除已加载的 MCP 工具缓存
   * 在 MCP 配置文件发生变化时调用
   */
  clearMCPCache(): void {
    logger.info('[ToolRegister] 清除已加载的 MCP 工具缓存')
    this.loadedMCPTools.clear()
  }

  /**
   * 获取核心工具列表（常驻工具，直接绑定给模型）
   * @returns 核心工具列表
   */
  getCoreTools(): DynamicStructuredTool[] {
    return Array.from(this.getCoreToolsMap().values())
  }

  /**
   * 按名称查询工具（统一接口，自动区分核心/MCP）
   * @param name 工具名称
   * @param options 查询选项
   * @returns 工具实例，不存在返回 undefined
   */
  async getTool(
    name: string,
    options?: { autoLoadMCP?: boolean },
  ): Promise<DynamicStructuredTool | undefined> {
    const autoLoadMCP = options?.autoLoadMCP !== false

    // 1. 先查核心工具
    const coreTool = this.getCoreToolsMap().get(name)
    if (coreTool) {
      return coreTool
    }

    // 2. 再查已装载的MCP工具
    const loadedMCPTool = this.loadedMCPTools.get(name)
    if (loadedMCPTool) {
      return loadedMCPTool
    }

    // 3. 检查是否是MCP工具格式
    const mcpParsed = parseMCPToolName(name)
    if (!mcpParsed) {
      return undefined
    }

    const { serverName, toolName } = mcpParsed

    // 4. 如果启用自动装载，尝试自动装载
    if (autoLoadMCP) {
      logger.info(`[ToolRegister] MCP工具 ${name} 未装载，尝试自动装载...`)
      const loaded = await this.loadMCPTool(serverName, toolName)
      if (loaded) {
        return loaded
      }
    }

    return undefined
  }

  /**
   * 装载MCP工具到当前会话
   * @param serverName MCP服务器名称
   * @param toolName 工具原始名称（不带前缀）
   * @returns 装载成功返回工具实例，失败返回 undefined
   */
  async loadMCPTool(
    serverName: string,
    toolName: string,
  ): Promise<DynamicStructuredTool | undefined> {
    const fullName = `mcp__${serverName}__${toolName}`

    // 检查是否已装载
    if (this.loadedMCPTools.has(fullName)) {
      logger.info(`[ToolRegister] MCP工具 ${fullName} 已装载`)
      return this.loadedMCPTools.get(fullName)!
    }

    try {
      // 从MCP管理器获取工具实例
      const tool = await mcpToolManager.getToolByName(serverName, toolName)
      if (!tool) {
        logger.warn(`[ToolRegister] MCP工具 ${fullName} 不存在于服务器 ${serverName}`)
        return undefined
      }

      // 缓存到本地
      this.loadedMCPTools.set(fullName, tool)

      logger.info(`[ToolRegister] MCP工具 ${fullName} 装载成功`)
      return tool
    } catch (error) {
      logger.error({ error }, `[ToolRegister] MCP工具 ${fullName} 装载失败`)
      return undefined
    }
  }

  /**
   * 从当前会话卸载MCP工具
   * @param fullName 完整工具名称（格式: mcp__serverName__toolName）
   * @returns 是否卸载成功
   */
  async unloadMCPTool(fullName: string): Promise<boolean> {
    // 检查是否已装载
    if (!this.loadedMCPTools.has(fullName)) {
      logger.info(`[ToolRegister] MCP工具 ${fullName} 未装载，无需卸载`)
      return false
    }

    // 从本地缓存移除
    this.loadedMCPTools.delete(fullName)

    logger.info(`[ToolRegister] MCP工具 ${fullName} 卸载成功`)
    return true
  }

  /**
   * 获取激活工具列表（核心工具 + 已装载的MCP工具）
   * @returns 激活的工具列表
   */
  getActiveTools(): DynamicStructuredTool[] {
    const coreTools = this.getCoreTools()
    const mcpTools = Array.from(this.loadedMCPTools.values())

    return [...coreTools, ...mcpTools]
  }

  /**
   * 获取激活工具名称列表
   * @returns 工具名称数组
   */
  getActiveToolNames(): string[] {
    const coreNames = Array.from(this.getCoreToolsMap().keys())
    const mcpNames = Array.from(this.loadedMCPTools.keys())

    return [...coreNames, ...mcpNames]
  }

  /**
   * 检查工具是否是MCP工具
   * @param name 工具名称
   * @returns 是否是MCP工具
   */
  isMCPTool(name: string): boolean {
    return parseMCPToolName(name) !== null
  }

  /**
   * 检查MCP工具是否已装载
   * @param fullName 完整工具名称
   * @returns 是否已装载
   */
  isMCPLoaded(fullName: string): boolean {
    return this.loadedMCPTools.has(fullName)
  }

  /**
   * 获取工具信息（包含类型和状态）
   * @param name 工具名称
   * @returns 工具信息，不存在返回 undefined
   */
  async getToolInfo(name: string): Promise<ToolInfo | undefined> {
    // 查核心工具
    const coreTool = this.getCoreToolsMap().get(name)
    if (coreTool) {
      return {
        tool: coreTool,
        type: ToolType.CORE,
        isActive: true,
      }
    }

    // 查已装载的MCP工具
    const mcpTool = this.loadedMCPTools.get(name)
    if (mcpTool) {
      return {
        tool: mcpTool,
        type: ToolType.MCP,
        isActive: true,
      }
    }

    // 查未装载的MCP工具
    const mcpParsed = parseMCPToolName(name)
    if (mcpParsed) {
      const tool = await mcpToolManager.getToolByName(mcpParsed.serverName, mcpParsed.toolName)
      if (tool) {
        return {
          tool,
          type: ToolType.MCP,
          isActive: false,
        }
      }
    }

    return undefined
  }

  /**
   * 列出所有可用的MCP服务器
   * @returns 服务器名称列表
   */
  listAvailableMCPServers(): string[] {
    return mcpToolManager.listAvailableServers()
  }

  /**
   * 列出指定MCP服务器的所有工具
   * @param serverName 服务器名称
   * @returns 工具名称列表
   */
  async listMCPServerTools(serverName: string): Promise<string[]> {
    return mcpToolManager.listServerTools(serverName)
  }

  /**
   * 清空所有已装载的MCP工具（会话重置时调用）
   */
  clearAllMCPTools(): void {
    this.loadedMCPTools.clear()
    logger.info('[ToolRegister] 已清空所有MCP工具')
  }
}

/** ToolRegister 全局单例 */
export const toolRegister = new ToolRegister()
