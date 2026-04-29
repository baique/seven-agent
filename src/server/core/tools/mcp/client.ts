import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import path from 'node:path'
import fs from 'node:fs'
import { logger } from '../../../utils/logger'
import { paths } from '../../../config/env'
import { MCPServerConfig } from './config'

/**
 * MCP 客户端连接状态
 */
type MCPClientState = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * 获取 MCP 运行时目录路径
 * 确保目录存在
 * @returns MCP 运行时目录绝对路径
 */
function getMCPRuntimeDir(): string {
  // 临时修改：返回当前工作目录以便测试
  return paths.WORKSPACE_ROOT
}

/**
 * MCP 客户端实例
 */
interface MCPClientInstance {
  /** 客户端实例 */
  client: Client
  /** 连接状态 */
  state: MCPClientState
  /** 可用工具列表 */
  tools: Awaited<ReturnType<Client['listTools']>>['tools']
  /** 最后使用时间 */
  lastUsedAt: number
  /** 空闲超时定时器 */
  idleTimeoutId?: NodeJS.Timeout
}

/**
 * MCP 客户端管理器
 * 按需连接，首次调用工具时才建立连接
 * 支持空闲自动断开（默认10分钟）
 */
class MCPClientManager {
  private clients: Map<string, MCPClientInstance> = new Map()
  private connecting: Set<string> = new Set()
  /** 空闲超时时间（毫秒），默认10分钟 */
  private readonly idleTimeoutMs: number = 10 * 60 * 1000

  /**
   * 获取或创建 MCP 客户端
   * @param serverConfig 服务器配置
   * @returns MCP 客户端实例
   */
  async getClient(serverConfig: MCPServerConfig): Promise<MCPClientInstance> {
    const existing = this.clients.get(serverConfig.name)
    if (existing && existing.state === 'connected') {
      // 更新最后使用时间并重置空闲超时
      this.refreshIdleTimeout(serverConfig.name, existing)
      return existing
    }

    if (this.connecting.has(serverConfig.name)) {
      logger.info(`[MCP] 等待客户端连接中: ${serverConfig.name}`)
      await this.waitForConnection(serverConfig.name)
      const client = this.clients.get(serverConfig.name)!
      this.refreshIdleTimeout(serverConfig.name, client)
      return client
    }

    const client = await this.connectClient(serverConfig)
    this.refreshIdleTimeout(serverConfig.name, client)
    return client
  }

  /**
   * 刷新空闲超时定时器
   * @param serverName 服务器名称
   * @param instance 客户端实例
   */
  private refreshIdleTimeout(serverName: string, instance: MCPClientInstance): void {
    // 清除现有定时器
    if (instance.idleTimeoutId) {
      clearTimeout(instance.idleTimeoutId)
    }

    // 更新最后使用时间
    instance.lastUsedAt = Date.now()

    // 设置新的空闲超时定时器
    instance.idleTimeoutId = setTimeout(() => {
      logger.info(`[MCP] 服务器 ${serverName} 空闲超时，自动断开连接`)
      this.disconnect(serverName)
    }, this.idleTimeoutMs)

    logger.debug(
      `[MCP] 刷新服务器 ${serverName} 空闲超时，将在 ${this.idleTimeoutMs / 1000 / 60} 分钟后断开`,
    )
  }

  /**
   * 连接 MCP 服务器
   * @param serverConfig 服务器配置
   * @returns MCP 客户端实例
   */
  private async connectClient(serverConfig: MCPServerConfig): Promise<MCPClientInstance> {
    this.connecting.add(serverConfig.name)
    logger.info(`[MCP] 连接服务器: ${serverConfig.name}, transport=${serverConfig.transport}`)

    try {
      let transport: StdioClientTransport | StreamableHTTPClientTransport

      if (serverConfig.transport === 'http' && serverConfig.http) {
        transport = new StreamableHTTPClientTransport(new URL(serverConfig.http.baseUrl))
      } else if (serverConfig.transport === 'stdio' && serverConfig.stdio) {
        const { command, args = [], env } = serverConfig.stdio
        transport = new StdioClientTransport({
          command,
          args,
          env: env || undefined,
          cwd: getMCPRuntimeDir(),
        })
      } else {
        throw new Error(`无效的传输配置: ${JSON.stringify(serverConfig)}`)
      }

      const client = new Client({
        name: `77-agent-${serverConfig.name}`,
        version: '1.0.0',
      })

      await client.connect(transport)

      const { tools } = await client.listTools()

      const instance: MCPClientInstance = {
        client,
        state: 'connected',
        tools,
        lastUsedAt: Date.now(),
      }

      this.clients.set(serverConfig.name, instance)
      this.connecting.delete(serverConfig.name)

      logger.info(`[MCP] 已连接服务器: ${serverConfig.name}, 工具数量: ${tools.length}`)

      return instance
    } catch (error) {
      this.connecting.delete(serverConfig.name)
      const instance = this.clients.get(serverConfig.name)
      if (instance) {
        instance.state = 'error'
      }
      logger.error(`[MCP] 连接服务器失败: ${serverConfig.name}`)
      throw error
    }
  }

  /**
   * 等待连接完成
   * @param serverName 服务器名称
   */
  private async waitForConnection(serverName: string): Promise<void> {
    const maxWait = 30000
    const interval = 100
    let waited = 0

    while (this.connecting.has(serverName) && waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      waited += interval
    }

    if (waited >= maxWait) {
      throw new Error(`[MCP] 连接超时: ${serverName}`)
    }
  }

  /**
   * 断开指定服务器连接
   * @param serverName 服务器名称
   */
  async disconnect(serverName: string): Promise<void> {
    const instance = this.clients.get(serverName)
    if (instance) {
      // 清除空闲超时定时器
      if (instance.idleTimeoutId) {
        clearTimeout(instance.idleTimeoutId)
        instance.idleTimeoutId = undefined
      }

      try {
        await instance.client.close()
        logger.info(`[MCP] 已断开服务器: ${serverName}`)
      } catch (error) {
        logger.warn(`[MCP] 断开服务器时出错: ${serverName}`)
      }
      this.clients.delete(serverName)
    }
  }

  /**
   * 断开所有服务器连接
   */
  async disconnectAll(): Promise<void> {
    for (const serverName of this.clients.keys()) {
      await this.disconnect(serverName)
    }
  }

  /**
   * 获取客户端连接状态
   * @param serverName 服务器名称
   * @returns 连接状态
   */
  getState(serverName: string): MCPClientState {
    const instance = this.clients.get(serverName)
    return instance?.state ?? 'disconnected'
  }

  /**
   * 轻量级获取服务器工具列表（仅用于搜索/展示，不保持连接）
   * @param serverConfig 服务器配置
   * @returns 工具元数据列表
   */
  async getToolList(serverConfig: MCPServerConfig): Promise<MCPToolMetadata[]> {
    // 如果已有连接，直接返回缓存的工具列表
    const existing = this.clients.get(serverConfig.name)
    if (existing && existing.state === 'connected') {
      return existing.tools
    }

    // 否则建立临时连接获取工具列表后立即断开
    logger.info(`[MCP] 临时连接获取工具列表: ${serverConfig.name}`)

    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined

    try {
      if (serverConfig.transport === 'http' && serverConfig.http) {
        transport = new StreamableHTTPClientTransport(new URL(serverConfig.http.baseUrl))
      } else if (serverConfig.transport === 'stdio' && serverConfig.stdio) {
        const { command, args = [], env } = serverConfig.stdio
        transport = new StdioClientTransport({
          command,
          args,
          env: env || undefined,
          cwd: getMCPRuntimeDir(),
        })
      } else {
        throw new Error(`无效的传输配置: ${JSON.stringify(serverConfig)}`)
      }

      const client = new Client({
        name: `77-agent-${serverConfig.name}-probe`,
        version: '1.0.0',
      })

      await client.connect(transport)

      const { tools } = await client.listTools()

      // 获取工具列表后立即断开连接
      await client.close()

      logger.info(`[MCP] 临时连接完成: ${serverConfig.name}, 获取 ${tools.length} 个工具`)

      return tools
    } catch (error) {
      logger.warn(`[MCP] 临时连接失败: ${serverConfig.name}`)
      // 确保清理资源
      if (transport) {
        try {
          await transport.close()
        } catch {
          // 忽略关闭错误
        }
      }
      return []
    }
  }
}

/** MCP 客户端管理器单例 */
export const mcpClientManager = new MCPClientManager()

/**
 * MCP 工具调用结果
 */
export interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * MCP 工具元数据（轻量级，无需保持连接）
 */
export interface MCPToolMetadata {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

/**
 * 调用 MCP 工具
 * @param serverName 服务器名称
 * @param toolName 工具名称
 * @param args 工具参数
 * @returns 工具调用结果
 */
export async function callMCPTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const servers = (await import('./config')).getMCPServers()
  const serverConfig = servers.find((s) => s.name === serverName)

  if (!serverConfig) {
    throw new Error(`[MCP] 未找到服务器配置: ${serverName}`)
  }

  const client = await mcpClientManager.getClient(serverConfig)

  const result = await client.client.callTool({
    name: toolName,
    arguments: args,
  })

  return {
    content: Array.isArray(result.content)
      ? (result.content as { type: 'text'; text: string }[])
      : [{ type: 'text', text: String(result.content) }],
    isError: Boolean(result.isError),
  }
}
