import { readdir, readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { logger } from '../../utils/logger'
import { paths } from '../../config/env'

/**
 * 工具引用类型
 */
export interface ToolReference {
  /** 引用类型：builtin-内置工具，mcp_server-MCP服务器所有工具，mcp_tool-MCP特定工具 */
  type: 'builtin' | 'mcp_server' | 'mcp_tool'
  /** 原始引用字符串 */
  raw: string
  /** 内置工具名称 */
  toolName?: string
  /** MCP 服务器名称 */
  serverName?: string
  /** MCP 工具名称（仅 mcp_tool 类型） */
  mcpToolName?: string
}

/**
 * 解析工具引用字符串
 * 支持格式：
 * - read_file -> 内置工具
 * - mcp:filesystem -> MCP 服务器所有工具
 * - mcp:filesystem/read_file -> MCP 特定工具
 * @param ref 工具引用字符串
 * @returns 解析后的工具引用
 */
export function parseToolReference(ref: string): ToolReference {
  if (ref.startsWith('mcp:')) {
    const mcpPart = ref.slice(4)
    const slashIndex = mcpPart.indexOf('/')

    if (slashIndex === -1) {
      return {
        type: 'mcp_server',
        raw: ref,
        serverName: mcpPart,
      }
    }

    return {
      type: 'mcp_tool',
      raw: ref,
      serverName: mcpPart.slice(0, slashIndex),
      mcpToolName: mcpPart.slice(slashIndex + 1),
    }
  }

  return {
    type: 'builtin',
    raw: ref,
    toolName: ref,
  }
}

/**
 * Agent配置元数据
 */
export interface AgentMetadata {
  name: string
  description: string
  tools?: string[]
  modelParams?: {
    temperature?: number
    maxTokens?: number
  }
  maxIterations?: number
}

/**
 * Agent定义
 */
export interface Agent extends AgentMetadata {
  /** 系统提示词（AGENT.md frontmatter后的内容） */
  systemPrompt: string
  /** Agent文件基础路径 */
  basePath: string
}

/**
 * 解析AGENT.md文件
 * 格式：YAML frontmatter + Markdown内容
 */
function parseAgentMd(content: string): { metadata: AgentMetadata; body: string } | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)

  if (!frontmatterMatch) {
    return null
  }

  try {
    const frontmatter = frontmatterMatch[1]
    const body = frontmatterMatch[2].trim()

    const metadata = parseSimpleYaml(frontmatter)

    const agentMetadata: AgentMetadata = {
      name: metadata.name as string,
      description: metadata.description as string,
      tools: metadata.tools as string[] | undefined,
      modelParams: metadata.modelParams as AgentMetadata['modelParams'],
      maxIterations: metadata.maxIterations as number | undefined,
    }

    return { metadata: agentMetadata, body }
  } catch (error) {
    logger.error(`[Agents] 解析AGENT.md失败: ${error}`)
    return null
  }
}

/**
 * 简单的YAML解析器（复用skills-loader）
 */
function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yamlStr.split('\n')
  let currentIndent = 0
  let inNestedObject = false
  let nestedObject: Record<string, unknown> | null = null
  let currentArray: string[] | null = null
  let arrayKey = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue

    const indent = line.search(/\S|$/)
    const trimmedLine = line.trim()

    // 数组元素
    if (trimmedLine.startsWith('- ')) {
      if (currentArray) {
        currentArray.push(trimmedLine.slice(2).trim())
      }
      continue
    }

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) continue

    const key = trimmedLine.slice(0, colonIndex).trim()
    let value = trimmedLine.slice(colonIndex + 1).trim()

    // 重置数组状态
    if (currentArray && indent <= currentIndent) {
      result[arrayKey] = currentArray
      currentArray = null
      arrayKey = ''
    }

    if (indent === 0) {
      inNestedObject = false
      nestedObject = null

      // 检查是否是数组开始
      if (value === '' && i + 1 < lines.length) {
        const nextLine = lines[i + 1]
        const nextTrimmed = nextLine.trim()
        if (nextTrimmed.startsWith('- ')) {
          currentArray = []
          arrayKey = key
          currentIndent = indent
          continue
        }

        const nextIndent = nextLine.search(/\S|$/)
        if (nextIndent > 0 && nextLine.trim().includes(':')) {
          result[key] = {}
          nestedObject = result[key] as Record<string, unknown>
          inNestedObject = true
          currentIndent = nextIndent
          continue
        }
      }

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1)
      }

      // 尝试转换为数字
      if (value !== '' && !isNaN(Number(value))) {
        result[key] = Number(value)
      } else {
        result[key] = value
      }
    } else if (inNestedObject && nestedObject && indent >= currentIndent) {
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1)
      }

      // 尝试转换为数字
      if (value !== '' && !isNaN(Number(value))) {
        nestedObject[key] = Number(value)
      } else {
        nestedObject[key] = value
      }
    }
  }

  // 处理未闭合的数组
  if (currentArray && arrayKey) {
    result[arrayKey] = currentArray
  }

  return result
}

/**
 * 从目录加载单个Agent
 */
async function loadAgent(agentDir: string): Promise<Agent | null> {
  const agentMdPath = path.join(agentDir, 'AGENT.md')

  try {
    const content = await readFile(agentMdPath, 'utf-8')
    const parsed = parseAgentMd(content)

    if (!parsed) {
      logger.warn(`[Agents] 无法解析 ${agentMdPath}`)
      return null
    }

    return {
      ...parsed.metadata,
      systemPrompt: parsed.body,
      basePath: agentDir,
    }
  } catch (error) {
    logger.warn(`[Agents] 读取 ${agentMdPath} 失败: ${error}`)
    return null
  }
}

/**
 * 从目录加载所有Agents
 * 从用户工作空间的 agents 目录加载
 * （初始化时已从 resources/workspace/agents 复制）
 */
export async function loadAgents(agentsDir?: string): Promise<Agent[]> {
  const agentsPath = agentsDir
    ? path.isAbsolute(agentsDir)
      ? agentsDir
      : path.resolve(paths.WORKSPACE_ROOT, agentsDir)
    : path.join(paths.WORKSPACE_ROOT, 'agents')

  const agents: Agent[] = []

  let entries: string[]
  try {
    entries = await readdir(agentsPath)
  } catch {
    return agents
  }

  for (const entry of entries) {
    const agentDir = path.join(agentsPath, entry)
    try {
      const stats = await stat(agentDir)
      if (stats.isDirectory()) {
        const agent = await loadAgent(agentDir)
        if (agent) {
          agents.push(agent)
        }
      }
    } catch {}
  }

  return agents
}

/**
 * 格式化agents为提示词格式
 */
export function formatAgentsForPrompt(agents: Agent[]): string {
  if (agents.length === 0) {
    return '（暂无可用子代理）'
  }

  const lines: string[] = ['## 可用SubAgent列表', '']

  for (const agent of agents) {
    lines.push(`- **${agent.name}**：${agent.description}`)
  }

  return lines.join('\n')
}

// ==================== 缓存机制 ====================

let agentsCache: Agent[] | null = null
let isLoading = false
let isInitialized = false

/**
 * 获取所有Agents（带缓存）
 * 缓存只在文件变化时通过 clearAgentsCache() 清除，不会自动过期
 */
export async function getAgents(): Promise<Agent[]> {
  // 使用缓存（不在加载中时）
  if (agentsCache && !isLoading) {
    return agentsCache
  }

  // 防止并发加载
  if (isLoading) {
    while (isLoading) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return agentsCache || []
  }

  isLoading = true

  try {
    const prevAgents = agentsCache
    agentsCache = await loadAgents()

    // 只在初始化或真正变化时输出日志
    if (!isInitialized || hasAgentsChanged(prevAgents, agentsCache)) {
      const agentNames = agentsCache.map((a) => a.name).join(', ')
      logger.info(`[Agents] 加载了 ${agentsCache.length} 个子代理: ${agentNames}`)
      isInitialized = true
    }

    return agentsCache
  } catch (error) {
    logger.error(`[Agents] 加载子代理失败: ${error}`)
    return agentsCache || []
  } finally {
    isLoading = false
  }
}

/**
 * 检查agents列表是否发生变化
 */
function hasAgentsChanged(prev: Agent[] | null, current: Agent[]): boolean {
  if (!prev || prev.length !== current.length) {
    return true
  }

  const prevNames = new Set(prev.map((a) => a.name).sort())
  const currentNames = new Set(current.map((a) => a.name).sort())

  if (prevNames.size !== currentNames.size) {
    return true
  }

  for (const name of prevNames) {
    if (!currentNames.has(name)) {
      return true
    }
  }

  return false
}

/**
 * 根据名称获取Agent
 */
export async function getAgentByName(name: string): Promise<Agent | undefined> {
  const agents = await getAgents()
  return agents.find((a) => a.name.toLowerCase() === name.toLowerCase() || a.name.includes(name))
}

/**
 * 清除Agents缓存
 * 在Agent文件变化时调用
 */
export function clearAgentsCache(): void {
  agentsCache = null
  logger.info('[Agents] 子代理缓存已清除')
}

// ==================== 文件监听 ====================

let agentsWatcher: FSWatcher | null = null
let isWatching = false
let debounceTimer: NodeJS.Timeout | null = null
const DEBOUNCE_MS = 500

/**
 * 防抖清除缓存
 */
function debouncedClearAgentsCache(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    clearAgentsCache()
    debounceTimer = null
  }, DEBOUNCE_MS)
}

/**
 * 监听agents目录变化
 */
export function startAgentsWatcher(): void {
  if (isWatching) {
    return
  }

  const agentsDir = path.join(paths.WORKSPACE_ROOT, 'agents')

  try {
    agentsWatcher = watch(agentsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return

      // 只监听AGENT.md文件的变化
      if (filename.endsWith('AGENT.md')) {
        debouncedClearAgentsCache()
      }
    })

    isWatching = true
    logger.info(`[Agents] 开始监听目录: ${agentsDir}`)

    // 监听错误
    agentsWatcher.on('error', (error) => {
      logger.error(`[Agents] 监听出错: ${error}`)
    })
  } catch (error) {
    logger.error(`[Agents] 启动监听失败: ${error}`)
  }
}

/**
 * 停止监听agents目录
 */
export function stopAgentsWatcher(): void {
  if (agentsWatcher) {
    agentsWatcher.close()
    agentsWatcher = null
    isWatching = false
    logger.info('[Agents] 已停止监听')
  }
}
