import {
  coreTools,
  baseToolsByName,
  fileSystemTools,
  pythonREPLTool,
  getSystemInfoTool,
  getCurrentTimeTool,
  getClipboardTool,
  setClipboardTool,
  searchMemoryTool,
  updateMemoryTool,
  memoryDeepSearchTools,
  skillsTools,
  showNotificationTool,
  taskTools,
  terminalTool,
  reminderTools,
  subAgentTools,
  screenshotTool,
} from './core-tools'
import { mcpToolManager, parseMCPToolName, mcpConfigManager, mcpToolCacheManager } from './mcp'
import { getMCPServers } from './mcp/config'
import { toolRegister } from './tool-register'

export {
  fileSystemTools,
  pythonREPLTool,
  getSystemInfoTool,
  getCurrentTimeTool,
  getClipboardTool,
  setClipboardTool,
  searchMemoryTool,
  updateMemoryTool,
  memoryDeepSearchTools,
  skillsTools,
  showNotificationTool as openWindowTool,
  taskTools,
  terminalTool,
  reminderTools,
  subAgentTools,
  screenshotTool,
  mcpToolManager,
  parseMCPToolName,
  coreTools,
  baseToolsByName,
}

/**
 * ToolRegister - 统一工具注册中心
 * 推荐使用此接口进行工具管理，替代分散的工具查询方法
 */
export { toolRegister, ToolType } from './tool-register'
export type { ToolInfo } from './tool-register'

/**
 * 初始化 MCP 配置管理
 * 启动配置监听和工具管理器监听，检查并创建缺失的缓存
 */
export async function initializeMCPConfig(): Promise<void> {
  mcpConfigManager.startWatching()

  // 监听配置变化，清除工具缓存
  mcpConfigManager.on('change', () => {
    import('../../utils/logger').then(({ logger }) => {
      logger.info('[Tools] 检测到 MCP 配置变化，清除工具缓存')
    })
    mcpToolManager.clearCache()
    toolRegister.clearMCPCache()
  })

  const { logger } = await import('../../utils/logger')

  // 检查并创建缺失的缓存
  const servers = getMCPServers()
  if (servers.length > 0) {
    logger.info(`[MCP] 检查 ${servers.length} 个服务器的工具缓存...`)
    let needRefreshCount = 0

    for (const serverConfig of servers) {
      // 检查缓存是否存在
      if (!mcpToolCacheManager.hasCache(serverConfig.name)) {
        needRefreshCount++
        logger.info(`[MCP] ${serverConfig.name} 缓存不存在，准备连接获取工具列表...`)
        try {
          const result = await mcpToolCacheManager.refreshCache(serverConfig.name)
          if (result.success) {
            logger.info(
              `[MCP] ${serverConfig.name} 缓存创建成功，共 ${result.tools?.length || 0} 个工具`,
            )
          } else {
            logger.warn(`[MCP] ${serverConfig.name} 缓存创建失败: ${result.message}`)
          }
        } catch (error) {
          logger.error(
            `[MCP] ${serverConfig.name} 连接失败: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    if (needRefreshCount === 0) {
      logger.info('[MCP] 所有服务器缓存已存在')
    } else {
      // 刷新应用内的工具元数据缓存
      mcpToolManager.clearCache()
      logger.info('[MCP] 已刷新应用工具缓存')
    }
  }

  logger.info('[Tools] MCP 配置管理已初始化')
}
