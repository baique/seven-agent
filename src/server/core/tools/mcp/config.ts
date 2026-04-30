import { EventEmitter } from 'events'
import { logger } from '../../../utils/logger'
import { paths, env } from '../../../config/env'
import { debounce } from '../../../utils/watch-debounce'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

/**
 * MCP 服务器 Stdio 传输配置
 */
export interface MCPServerStdioConfig {
  /** 命令（如 uvx, npx, node） */
  command: string
  /** 命令参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
}

/**
 * MCP 服务器 HTTP 传输配置
 */
export interface MCPServerHttpConfig {
  /** MCP 服务器 URL */
  baseUrl: string
  /** 认证 token（可选） */
  token?: string
}

/**
 * MCP 服务器配置
 */
export interface MCPServerConfig {
  /** 服务器名称 */
  name: string
  /** 传输类型 */
  transport: 'stdio' | 'http'
  /** Stdio 传输配置 */
  stdio?: MCPServerStdioConfig
  /** HTTP 传输配置 */
  http?: MCPServerHttpConfig
}

/**
 * MCP 配置文件结构
 */
export interface MCPConfig {
  /** MCP 服务器列表 */
  mcpServers: Record<string, MCPServerConfig>
  /** MCP 服务器分组 */
  mcpGroups?: Record<string, string[]>
  /** 默认加载的分组 */
  defaultGroup?: string
}

/**
 * 合并后的 MCP 配置
 */
interface MergedMCPConfig {
  /** 工作空间配置 */
  workspace: MCPConfig
  /** 系统级配置 */
  system: MCPConfig
  /** 合并后的服务器列表（去重后） */
  mergedServers: Record<string, MCPServerConfig>
}

/**
 * 获取默认的系统级 MCP 配置路径
 * 与 skills 保持一致，使用 ~/.agents/mcp.json
 * @returns 系统级配置路径
 */
function getDefaultSystemConfigPath(): string {
  return path.join(homedir(), '.agents', 'mcp.json')
}

/**
 * 获取系统级 MCP 配置路径
 * @returns 系统级配置路径
 */
function getSystemConfigPath(): string {
  return env.MCP_SYSTEM_CONFIG_PATH || getDefaultSystemConfigPath()
}

/**
 * 从指定路径加载 MCP 配置（无日志）
 * @param configPath 配置文件路径
 * @returns MCP 配置对象
 */
function loadConfigFromPath(configPath: string): MCPConfig {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      return JSON.parse(content) as MCPConfig
    }
  } catch {
    // 静默失败
  }
  return { mcpServers: {} }
}

/**
 * MCP 配置管理器
 * 提供配置热重载和变更事件通知
 * 支持系统级配置和工作空间配置的合并
 */
class MCPConfigManager extends EventEmitter {
  private workspaceConfigPath: string
  private systemConfigPath: string
  private isWorkspaceWatching = false
  private isSystemWatching = false

  constructor() {
    super()
    this.workspaceConfigPath = paths.MCP_CONFIG
    this.systemConfigPath = getSystemConfigPath()
  }

  /**
   * 加载 MCP 配置（合并系统级和工作空间配置）
   * @returns 合并后的 MCP 配置
   */
  load(): MergedMCPConfig {
    const workspaceConfig = loadConfigFromPath(this.workspaceConfigPath)
    const systemConfig = loadConfigFromPath(this.systemConfigPath)

    // 合并服务器配置：工作空间配置优先
    const mergedServers: Record<string, MCPServerConfig> = {}
    const overriddenServers: string[] = []

    // 先添加系统级配置
    for (const [name, serverConfig] of Object.entries(systemConfig.mcpServers || {})) {
      mergedServers[name] = { ...serverConfig, name }
    }

    // 再添加工作空间配置（同名会覆盖系统级配置）
    for (const [name, serverConfig] of Object.entries(workspaceConfig.mcpServers || {})) {
      if (mergedServers[name]) {
        overriddenServers.push(name)
      }
      mergedServers[name] = { ...serverConfig, name }
    }

    // 精简日志：只输出去重后的服务器列表和来源
    const serverNames = Object.keys(mergedServers)
    if (serverNames.length > 0) {
      const sources: string[] = []
      if (Object.keys(systemConfig.mcpServers || {}).length > 0) {
        sources.push('系统级')
      }
      if (Object.keys(workspaceConfig.mcpServers || {}).length > 0) {
        sources.push('工作空间')
      }
      logger.info(
        `[MCP] 已加载 ${serverNames.length} 个服务器 (${sources.join('+')})：${serverNames.join(', ')}`,
      )
      if (overriddenServers.length > 0) {
        logger.info(`[MCP] 工作空间覆盖系统级：${overriddenServers.join(', ')}`)
      }
    }

    return {
      workspace: workspaceConfig,
      system: systemConfig,
      mergedServers,
    }
  }

  /**
   * 创建默认的 MCP 配置文件
   */
  private createDefaultConfig(): void {
    try {
      const dir = path.dirname(this.workspaceConfigPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const defaultConfig: MCPConfig = {
        mcpServers: {},
        mcpGroups: {
          core: [],
          extended: [],
        },
        defaultGroup: 'core',
      }
      fs.writeFileSync(this.workspaceConfigPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
      logger.info(`[MCP] 已创建默认配置文件`)
    } catch (error) {
      logger.error(`[MCP] 创建默认配置文件失败`)
    }
  }

  /**
   * 启动文件监听
   */
  startWatching(): void {
    this.startWorkspaceWatching()
    this.startSystemWatching()
  }

  /**
   * 启动工作空间配置监听
   */
  private startWorkspaceWatching(): void {
    if (this.isWorkspaceWatching) return

    try {
      if (!fs.existsSync(this.workspaceConfigPath)) {
        this.createDefaultConfig()
      }

      const debouncedReload = debounce(
        () => {
          logger.info('[MCP] 工作空间配置已变更')
          this.emit('change')
        },
        { debounceMs: 500 },
      )

      fs.watchFile(this.workspaceConfigPath, { interval: 1000 }, (curr, prev) => {
        if (curr.mtime.getTime() !== prev.mtime.getTime()) {
          debouncedReload()
        }
      })
      this.isWorkspaceWatching = true
    } catch (error) {
      logger.error(`[MCP] 监听工作空间配置失败`)
    }
  }

  /**
   * 启动系统级配置监听
   */
  private startSystemWatching(): void {
    if (this.isSystemWatching) return

    try {
      if (!fs.existsSync(this.systemConfigPath)) return

      const debouncedReload = debounce(
        () => {
          logger.info('[MCP] 系统级配置已变更')
          this.emit('change')
        },
        { debounceMs: 500 },
      )

      fs.watchFile(this.systemConfigPath, { interval: 1000 }, (curr, prev) => {
        if (curr.mtime.getTime() !== prev.mtime.getTime()) {
          debouncedReload()
        }
      })
      this.isSystemWatching = true
    } catch (error) {
      logger.error(`[MCP] 监听系统级配置失败`)
    }
  }

  /**
   * 停止文件监听
   */
  stopWatching(): void {
    this.stopWorkspaceWatching()
    this.stopSystemWatching()
  }

  /**
   * 停止工作空间配置监听
   */
  private stopWorkspaceWatching(): void {
    if (!this.isWorkspaceWatching) return
    fs.unwatchFile(this.workspaceConfigPath)
    this.isWorkspaceWatching = false
  }

  /**
   * 停止系统级配置监听
   */
  private stopSystemWatching(): void {
    if (!this.isSystemWatching) return
    fs.unwatchFile(this.systemConfigPath)
    this.isSystemWatching = false
  }

  /**
   * 获取系统级配置路径
   * @returns 系统级配置路径
   */
  getSystemConfigPath(): string {
    return this.systemConfigPath
  }

  /**
   * 获取工作空间配置路径
   * @returns 工作空间配置路径
   */
  getWorkspaceConfigPath(): string {
    return this.workspaceConfigPath
  }
}

/** MCP 配置管理器单例 */
export const mcpConfigManager = new MCPConfigManager()

/**
 * 解析服务器配置
 * @param name 服务器名称
 * @param serverConfig 原始配置
 * @returns 标准化的服务器配置
 */
function parseServerConfig(name: string, serverConfig: unknown): MCPServerConfig | null {
  // 兼容旧格式：如果直接有 baseUrl 则转换为 http 传输
  if (typeof serverConfig === 'object' && serverConfig !== null && 'baseUrl' in serverConfig) {
    const httpConfig = serverConfig as unknown as MCPServerHttpConfig
    return {
      name,
      transport: 'http',
      http: {
        baseUrl: httpConfig.baseUrl,
        token: httpConfig.token,
      },
    }
  }

  // 新格式：检查 stdio 配置
  if (typeof serverConfig === 'object' && serverConfig !== null && 'command' in serverConfig) {
    const stdioConfig = serverConfig as unknown as MCPServerStdioConfig
    return {
      name,
      transport: 'stdio',
      stdio: {
        command: stdioConfig.command,
        args: stdioConfig.args,
        env: stdioConfig.env,
      },
    }
  }

  return null
}

/**
 * 获取已配置的 MCP 服务器列表（合并系统级和工作空间配置，去重）
 * @returns MCP 服务器配置数组
 */
export function getMCPServers(): MCPServerConfig[] {
  const mergedConfig = mcpConfigManager.load()
  const servers: MCPServerConfig[] = []

  for (const [name, serverConfig] of Object.entries(mergedConfig.mergedServers)) {
    const parsed = parseServerConfig(name, serverConfig)
    if (parsed) {
      servers.push(parsed)
    } else {
      logger.warn(`[MCP] 服务器 ${name} 配置格式无效`)
    }
  }

  return servers
}

/**
 * 获取所有分组名称（仅工作空间配置）
 * @returns 分组名称列表
 */
export function getMCPGroups(): string[] {
  const mergedConfig = mcpConfigManager.load()
  return Object.keys(mergedConfig.workspace.mcpGroups || {})
}

/**
 * 获取指定分组的服务器名称列表（仅工作空间配置）
 * @param groupName 分组名称
 * @returns 服务器名称列表
 */
export function getMCPServersByGroup(groupName: string): string[] {
  const mergedConfig = mcpConfigManager.load()
  return mergedConfig.workspace.mcpGroups?.[groupName] || []
}

/**
 * 获取默认分组的服务器列表（仅工作空间配置）
 * @returns 默认分组的服务器配置数组
 */
export function getDefaultMCPServers(): MCPServerConfig[] {
  const mergedConfig = mcpConfigManager.load()
  const defaultGroup = mergedConfig.workspace.defaultGroup || 'core'
  const serverNames = mergedConfig.workspace.mcpGroups?.[defaultGroup] || []

  const allServers = getMCPServers()
  return allServers.filter((s) => serverNames.includes(s.name))
}

/**
 * 获取完整配置（包含系统级和工作空间配置）
 * @returns 完整 MCP 配置
 */
export function getFullMCPConfig(): MergedMCPConfig {
  return mcpConfigManager.load()
}

/**
 * 获取系统级 MCP 配置
 * @returns 系统级 MCP 配置
 */
export function getSystemMCPConfig(): MCPConfig {
  return mcpConfigManager.load().system
}

/**
 * 获取工作空间 MCP 配置
 * @returns 工作空间 MCP 配置
 */
export function getWorkspaceMCPConfig(): MCPConfig {
  return mcpConfigManager.load().workspace
}
