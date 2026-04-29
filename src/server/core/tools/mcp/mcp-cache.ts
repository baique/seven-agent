import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../../utils/logger'
import { paths } from '../../../config/env'
import { mcpClientManager } from './client'
import { getMCPServers, type MCPServerConfig } from './config'

/**
 * MCP工具缓存项
 */
export interface MCPToolCacheItem {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description?: string
  /** 输入参数schema */
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

/**
 * MCP服务器工具缓存
 */
export interface MCPServerToolCache {
  /** 服务器名称 */
  serverName: string
  /** 缓存时间戳 */
  cachedAt: number
  /** 工具列表 */
  tools: MCPToolCacheItem[]
}

/**
 * 缓存操作结果
 */
export interface CacheResult {
  success: boolean
  message: string
  tools?: MCPToolCacheItem[]
  error?: string
}

/**
 * MCP工具缓存管理器
 */
class MCPToolCacheManager {
  private cacheDir: string

  constructor() {
    this.cacheDir = path.join(path.dirname(paths.MCP_CONFIG), '.mcp-cache')
  }

  /**
   * 获取缓存目录路径
   * @returns 缓存目录路径
   */
  getCacheDir(): string {
    return this.cacheDir
  }

  /**
   * 确保缓存目录存在
   */
  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  /**
   * 获取服务器缓存文件路径
   * @param serverName 服务器名称
   * @returns 缓存文件路径
   */
  private getCacheFilePath(serverName: string): string {
    // 处理特殊字符，确保文件名安全
    const safeName = serverName.replace(/[^a-zA-Z0-9_-]/g, '_')
    return path.join(this.cacheDir, `${safeName}.json`)
  }

  /**
   * 检查服务器缓存是否存在
   * @param serverName 服务器名称
   * @returns 是否存在缓存
   */
  hasCache(serverName: string): boolean {
    const cachePath = this.getCacheFilePath(serverName)
    return fs.existsSync(cachePath)
  }

  /**
   * 读取服务器工具缓存
   * @param serverName 服务器名称
   * @returns 缓存数据，不存在返回null
   */
  readCache(serverName: string): MCPServerToolCache | null {
    const cachePath = this.getCacheFilePath(serverName)

    try {
      if (!fs.existsSync(cachePath)) {
        return null
      }

      const content = fs.readFileSync(cachePath, 'utf-8')
      const cache = JSON.parse(content) as MCPServerToolCache

      // 验证缓存结构
      if (!cache.serverName || !Array.isArray(cache.tools)) {
        return null
      }

      return cache
    } catch {
      return null
    }
  }

  /**
   * 写入服务器工具缓存
   * @param serverName 服务器名称
   * @param tools 工具列表
   */
  writeCache(serverName: string, tools: MCPToolCacheItem[]): void {
    this.ensureCacheDir()

    const cachePath = this.getCacheFilePath(serverName)
    const cache: MCPServerToolCache = {
      serverName,
      cachedAt: Date.now(),
      tools,
    }

    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
    } catch {
      // 静默失败
    }
  }

  /**
   * 删除服务器缓存
   * @param serverName 服务器名称
   */
  deleteCache(serverName: string): void {
    const cachePath = this.getCacheFilePath(serverName)

    try {
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath)
      }
    } catch {
      // 静默失败
    }
  }

  /**
   * 获取所有缓存的服务器名称
   * @returns 服务器名称列表
   */
  listCachedServers(): string[] {
    this.ensureCacheDir()

    try {
      const files = fs.readdirSync(this.cacheDir)
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  /**
   * 连接服务器并获取工具列表
   * @param serverConfig 服务器配置
   * @returns 工具列表
   */
  private async fetchToolsFromServer(serverConfig: MCPServerConfig): Promise<MCPToolCacheItem[]> {
    logger.info(`[MCP] 正在连接 ${serverConfig.name} 服务器...`)

    try {
      const tools = await mcpClientManager.getToolList(serverConfig)
      logger.info(`[MCP] ${serverConfig.name} 连接成功，获取 ${tools.length} 个工具`)

      // 转换为缓存格式
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as MCPToolCacheItem['inputSchema'],
      }))
    } catch (error) {
      logger.error(`[MCP] ${serverConfig.name} 连接失败`)
      throw error
    }
  }

  /**
   * 刷新指定服务器的缓存
   * @param serverName 服务器名称
   * @returns 刷新结果
   */
  async refreshCache(serverName: string): Promise<CacheResult> {
    const servers = getMCPServers()
    const serverConfig = servers.find((s) => s.name === serverName)

    if (!serverConfig) {
      return {
        success: false,
        message: `未找到服务器配置: ${serverName}`,
        error: 'SERVER_NOT_FOUND',
      }
    }

    try {
      const tools = await this.fetchToolsFromServer(serverConfig)
      this.writeCache(serverName, tools)

      // 刷新应用内的工具元数据缓存
      this.notifyCacheUpdated()

      return {
        success: true,
        message: `成功刷新 ${serverName} 的缓存，共 ${tools.length} 个工具`,
        tools,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        message: `刷新缓存失败: ${serverName}`,
        error: errorMsg,
      }
    }
  }

  /**
   * 刷新所有服务器的缓存
   * @returns 刷新结果列表
   */
  async refreshAllCache(): Promise<CacheResult[]> {
    const servers = getMCPServers()
    const results: CacheResult[] = []

    if (servers.length === 0) {
      return results
    }

    logger.info(`[MCP] 开始缓存 ${servers.length} 个服务器...`)

    for (const serverConfig of servers) {
      const result = await this.refreshCache(serverConfig.name)
      results.push(result)
    }

    const successCount = results.filter((r) => r.success).length
    const totalTools = results
      .filter((r) => r.success)
      .reduce((sum, r) => sum + (r.tools?.length || 0), 0)
    logger.info(
      `[MCP] 缓存完成：${successCount}/${results.length} 个服务器成功，共 ${totalTools} 个工具`,
    )

    // 刷新应用内的工具元数据缓存（只需调用一次）
    this.notifyCacheUpdated()

    return results
  }

  /**
   * 获取或创建缓存
   * 如果缓存不存在，自动连接服务器获取并缓存
   * @param serverConfig 服务器配置
   * @returns 工具列表
   */
  async getOrCreateCache(serverConfig: MCPServerConfig): Promise<MCPToolCacheItem[]> {
    // 先尝试读取现有缓存
    const existingCache = this.readCache(serverConfig.name)
    if (existingCache) {
      return existingCache.tools
    }

    // 缓存不存在，获取并创建
    const result = await this.refreshCache(serverConfig.name)

    if (result.success && result.tools) {
      return result.tools
    }

    // 获取失败，返回空数组
    return []
  }

  /**
   * 获取所有缓存的工具（跨所有服务器）
   * @returns 所有工具列表，包含服务器名称
   */
  getAllCachedTools(): Array<MCPToolCacheItem & { serverName: string }> {
    const servers = getMCPServers()
    const allTools: Array<MCPToolCacheItem & { serverName: string }> = []

    for (const server of servers) {
      const cache = this.readCache(server.name)
      if (cache) {
        for (const tool of cache.tools) {
          allTools.push({
            ...tool,
            serverName: server.name,
          })
        }
      }
    }

    return allTools
  }

  /**
   * 清理不存在的服务器的缓存
   */
  cleanupStaleCache(): void {
    const servers = getMCPServers()
    const serverNames = new Set(servers.map((s) => s.name))
    const cachedServers = this.listCachedServers()

    for (const cachedName of cachedServers) {
      if (!serverNames.has(cachedName)) {
        this.deleteCache(cachedName)
        logger.info(`[MCP] 清理过期缓存: ${cachedName}`)
      }
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { totalServers: number; cachedServers: number; totalTools: number } {
    const servers = getMCPServers()
    const cachedServers = this.listCachedServers()
    let totalTools = 0

    for (const serverName of cachedServers) {
      const cache = this.readCache(serverName)
      if (cache) {
        totalTools += cache.tools.length
      }
    }

    return {
      totalServers: servers.length,
      cachedServers: cachedServers.length,
      totalTools,
    }
  }

  /**
   * 通知应用缓存已更新
   * 刷新 mcpToolManager 和 toolRegister 中的缓存
   */
  private notifyCacheUpdated(): void {
    // 动态导入以避免循环依赖
    import('./adapter')
      .then(({ mcpToolManager }) => {
        mcpToolManager.clearCache()
      })
      .catch(() => {
        // 静默失败
      })

    import('../../tools/tool-register')
      .then(({ toolRegister }) => {
        toolRegister.clearMCPCache()
      })
      .catch(() => {
        // 静默失败
      })
  }
}

/** MCP工具缓存管理器单例 */
export const mcpToolCacheManager = new MCPToolCacheManager()
