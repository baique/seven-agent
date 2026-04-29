import { join } from 'path'
import { appendFileSync, readFileSync, existsSync } from 'fs'
import { ensureDir, ensureFile } from '../utils/workspace'
import { logger, formatDate, formatDateDisplay } from '../utils'
import { paths, configManager } from '../config/env'
import { jsonMemoryManager } from './json-memory-manager'

export interface MemoryMessage {
  id: string
  type: 'human' | 'ai' | 'system' | 'tool'
  content: string
  toolCalls?: any[] | undefined
  toolCallId?: string
  /** 工具名称，仅tool类型消息使用 */
  name?: string
  timestamp: number
  summary?: boolean
  isSubagent?: boolean
  /** 工具执行状态，仅tool类型消息使用 */
  status?: 'success' | 'error'
}

export type MessageProcessor = (
  messages: MemoryMessage[],
) => MemoryMessage[] | Promise<MemoryMessage[]>

export interface MemoryOptions {
  workspaceRoot?: string
  messageProcessor?: MessageProcessor
}

interface CacheEntry {
  messages: MemoryMessage[]
  timestamp: number
}

const RECENT_MESSAGES_LIMIT = 50

export class Memory {
  private workspaceRoot: string
  private messageProcessor?: MessageProcessor
  private cache: Map<string, CacheEntry> = new Map()

  constructor(options?: MemoryOptions) {
    this.workspaceRoot = options?.workspaceRoot || paths.WORKSPACE_ROOT
    this.messageProcessor = options?.messageProcessor
  }

  async queryRecentMessages(): Promise<MemoryMessage[]> {
    const messages: MemoryMessage[] = []
    const todayStr = formatDate(new Date())
    const threeDaysAgo = new Date()
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)

    for (let i = 3; i >= 1; i--) {
      const checkDate = new Date()
      checkDate.setDate(checkDate.getDate() - i)
      const dateStr = formatDate(checkDate)

      if (dateStr === todayStr) continue

      const summaryFile = join(this.workspaceRoot, 'memory', dateStr, 'memory_summary.txt')
      try {
        if (existsSync(summaryFile)) {
          const summaryContent = readFileSync(summaryFile, 'utf-8').trim()
          if (summaryContent) {
            messages.push({
              id: `summary-${dateStr}`,
              type: 'system',
              content: `【${formatDateDisplay(checkDate)}】\n${summaryContent}`,
              timestamp: Date.now(),
              summary: true,
            })
          }
        }
      } catch (error) {}
    }

    const todayDir = join(this.workspaceRoot, 'memory', todayStr)
    const todayMemoryFile = join(todayDir, 'memory.jsonl')

    let todayMessages: MemoryMessage[] = []
    try {
      if (existsSync(todayMemoryFile)) {
        todayMessages = await this.readMessagesFromFile(todayMemoryFile, RECENT_MESSAGES_LIMIT)
      }
    } catch (error) {
      logger.error(`[Memory] 读取今日消息失败: ${error}`)
    }

    if (todayMessages.length < RECENT_MESSAGES_LIMIT) {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const yesterdayStr = formatDate(yesterday)
      const yesterdayDir = join(this.workspaceRoot, 'memory', yesterdayStr)
      const yesterdayMemoryFile = join(yesterdayDir, 'memory.jsonl')

      try {
        if (existsSync(yesterdayMemoryFile)) {
          const needCount = RECENT_MESSAGES_LIMIT - todayMessages.length
          const yesterdayMessages = await this.readMessagesFromFile(yesterdayMemoryFile, needCount)
          if (yesterdayMessages.length > 0) {
            messages.push({
              id: 'yesterday-conversation',
              type: 'system',
              content: '【昨日对话】',
              timestamp: Date.now(),
            })
            messages.push(...yesterdayMessages)
          }
        }
      } catch (error) {
        logger.error(`[Memory] 读取昨日消息失败: ${error}`)
      }
    }

    if (todayMessages.length > 0) {
      messages.push({
        id: 'recent-conversation',
        type: 'system',
        content: '【最近对话】',
        timestamp: Date.now(),
      })
      messages.push(...todayMessages)
    }

    logger.info(`[Memory] 共收集 ${messages.length} 条消息`)

    return messages
  }

  /**
   * 从今日向前读取N天摘要
   * @param days 要读取的天数，默认3天
   * @returns 摘要消息数组
   */
  async queryDaySummaries(days: number = 3): Promise<MemoryMessage[]> {
    const messages: MemoryMessage[] = []
    const todayStr = formatDate(new Date())

    for (let i = days; i >= 1; i--) {
      const checkDate = new Date()
      checkDate.setDate(checkDate.getDate() - i)
      const dateStr = formatDate(checkDate)

      if (dateStr === todayStr) continue

      const summaryFile = join(this.workspaceRoot, 'memory', dateStr, 'memory_summary.txt')
      try {
        if (existsSync(summaryFile)) {
          const summaryContent = readFileSync(summaryFile, 'utf-8').trim()
          if (summaryContent) {
            messages.push({
              id: `summary-${dateStr}`,
              type: 'ai',
              content: `【${formatDateDisplay(checkDate)}发生的事情】\n${summaryContent}`,
              timestamp: Date.now(),
              summary: true,
            })
          }
        }
      } catch (error) {}
    }

    return messages
  }

  /**
   * 读取近期记忆指定N条，不足从前一天补
   * @param limit 要读取的消息条数，默认50条
   * @returns 消息数组
   */
  async queryRecentMessagesByLimit(limit: number = 50): Promise<MemoryMessage[]> {
    const result = await this.queryMessagesWithPagination({ limit })
    return result.messages
  }

  /**
   * 分页查询消息
   * @param params 分页参数
   * @returns 消息数组和是否有更多
   */
  async queryMessagesWithPagination(params: {
    limit?: number
    beforeId?: string
  }): Promise<{ messages: MemoryMessage[]; hasMore: boolean }> {
    const limit = params.limit || 50
    const beforeId = params.beforeId

    const todayStr = formatDate(new Date())
    const todayDir = join(this.workspaceRoot, 'memory', todayStr)
    const todayMemoryFile = join(todayDir, 'memory.jsonl')

    let allMessages: MemoryMessage[] = []

    // 读取今日消息
    try {
      if (existsSync(todayMemoryFile)) {
        allMessages = await this.readMessagesFromFile(todayMemoryFile)
      }
    } catch (error) {
      logger.error(`[Memory] 读取今日消息失败: ${error}`)
    }

    // 如果今日消息不足，从之前日期补充
    if (allMessages.length < limit * 2) {
      const checkDate = new Date()
      let day = 1
      while (day <= 14 && allMessages.length < limit * 2) {
        checkDate.setDate(checkDate.getDate() - 1)
        const dateStr = formatDate(checkDate)
        const dayDir = join(this.workspaceRoot, 'memory', dateStr)
        const dayMemoryFile = join(dayDir, 'memory.jsonl')

        try {
          if (existsSync(dayMemoryFile)) {
            const dayMessages = await this.readMessagesFromFile(dayMemoryFile)
            allMessages.unshift(...dayMessages)
          }
        } catch (error) {
          logger.error(`[Memory] 读取 ${dateStr} 消息失败: ${error}`)
        }
        day++
      }
    }

    // 消息按时间正序排列（旧 -> 新）
    // 首次加载：返回最新的 limit 条消息
    // 分页加载：返回 beforeId 之前的 limit 条消息
    let messages: MemoryMessage[]
    let hasMore: boolean

    if (!beforeId) {
      // 首次加载：返回最新的 limit 条消息
      const startIndex = Math.max(0, allMessages.length - limit)
      messages = allMessages.slice(startIndex)
      hasMore = startIndex > 0
    } else {
      // 分页加载：找到 beforeId 的位置，返回之前的 limit 条消息
      const idIndex = allMessages.findIndex((m) => m.id === beforeId)
      if (idIndex === -1 || idIndex === 0) {
        // 未找到或已是第一条
        messages = []
        hasMore = false
      } else {
        const endIndex = idIndex
        const startIndex = Math.max(0, endIndex - limit)
        messages = allMessages.slice(startIndex, endIndex)
        hasMore = startIndex > 0
      }
    }

    return { messages, hasMore }
  }

  /**
   * 读取长期记忆
   * 从 main.json 获取核心记忆
   * @returns 长期记忆消息数组
   */
  async queryLongTermMemory(): Promise<MemoryMessage[]> {
    const messages: MemoryMessage[] = []

    try {
      // 获取长期记忆
      const longTermMemories = await jsonMemoryManager.getAllLongTermMemories()

      if (longTermMemories.length > 0) {
        const content = longTermMemories
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 10)
          .map((m) => `- ${m.description} (重要性:${m.importance.toFixed(2)})`)
          .join('\n')

        messages.push({
          id: 'long-term-memory',
          type: 'system',
          content: `【核心记忆】\n${content}`,
          timestamp: Date.now(),
        })
      }

      // 获取近72小时碎片记忆（可配置）
      const retentionHours = configManager.get('FRAGMENT_MEMORY_RETENTION_HOURS')
      const recentFragments =
        await jsonMemoryManager.getRecentFragmentMemoriesByHours(retentionHours)
      const validFragments = recentFragments.filter((m) => new Date(m.expireAt) > new Date())

      if (validFragments.length > 0) {
        const content = validFragments
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 10)
          .map((m) => `- ${m.description} (重要性:${m.importance.toFixed(2)})`)
          .join('\n')

        messages.push({
          id: 'recent-memory',
          type: 'system',
          content: `【近期记忆】\n${content}`,
          timestamp: Date.now(),
        })
      }
    } catch (error) {
      logger.error({ error }, '[Memory] 获取长期记忆失败')
    }

    return messages
  }

  async queryRecentDaysMessages(days: number = 1): Promise<MemoryMessage[]> {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days + 1)

    for (let i = 0; i < days; i++) {
      const checkDate = new Date(startDate)
      checkDate.setDate(checkDate.getDate() + i)
      const dateStr = formatDate(checkDate)
      logger.info(`Reading ${dateStr} messages from memory`)

      const todayDir = join(this.workspaceRoot, 'memory', dateStr)
      const todayMemoryFile = join(todayDir, 'memory.jsonl')

      try {
        return await this.readMessagesFromFile(todayMemoryFile)
      } catch (error) {
        logger.error({ error }, `[Memory] 读取 ${dateStr} 消息失败`)
        continue
      }
    }

    return []
  }

  private async readMessagesFromFile(filePath: string, limit?: number): Promise<MemoryMessage[]> {
    const { open } = await import('fs/promises')
    const fileHandle = await open(filePath, 'r')
    const messages: MemoryMessage[] = []

    try {
      const stats = await fileHandle.stat()
      const fileSize = stats.size

      if (fileSize === 0) {
        return messages
      }

      const bufferSize = Math.min(65536, fileSize)
      let position = fileSize
      let leftover = ''

      while (position > 0 && (!limit || messages.length < limit)) {
        const chunkSize = Math.min(bufferSize, position)
        position -= chunkSize

        const buffer = Buffer.alloc(chunkSize)
        await fileHandle.read(buffer, 0, chunkSize, position)

        const chunk = buffer.toString('utf-8') + leftover
        const lines = chunk.split('\n')

        leftover = lines[0]

        for (let i = lines.length - 1; i >= 1; i--) {
          const line = lines[i].trim()
          if (line) {
            try {
              const message = JSON.parse(line) as MemoryMessage
              messages.push(message)

              if (limit && messages.length >= limit) {
                return messages.reverse()
              }
            } catch (e) {
              // 忽略解析错误的行
            }
          }
        }
      }

      if (leftover.trim()) {
        try {
          const message = JSON.parse(leftover.trim()) as MemoryMessage
          messages.push(message)
        } catch (e) {
          // 忽略解析错误的行
        }
      }

      return messages.reverse()
    } finally {
      await fileHandle.close()
    }
  }

  async appendMessages(msgs: MemoryMessage[]): Promise<void> {
    this.cache.clear()

    let messagesToStore = msgs
    if (this.messageProcessor) {
      messagesToStore = await this.messageProcessor(msgs)
    }

    const date = formatDate(new Date())
    const dir = join(this.workspaceRoot, 'memory', date)
    await ensureDir(dir)
    const memoryFile = join(dir, 'memory.jsonl')
    await ensureFile(memoryFile, '')

    const line = messagesToStore.map((f) => JSON.stringify(f))
    appendFileSync(memoryFile, line.join('\n') + '\n', 'utf-8')
  }

  setMessageProcessor(processor: MessageProcessor): void {
    this.messageProcessor = processor
  }

  clearMessageProcessor(): void {
    this.messageProcessor = undefined
  }

  /**
   * 根据消息ID范围读取消息
   * 从所有历史消息中查找指定ID范围的消息
   * @param startId 起始消息ID（包含）
   * @param endId 结束消息ID（包含）
   * @returns 指定范围内的消息数组，按时间正序排列
   */
  async getMessagesByIdRange(startId: string, endId: string): Promise<MemoryMessage[]> {
    const result: MemoryMessage[] = []
    let collecting = false

    // 从最近14天的消息中查找
    const checkDate = new Date()
    for (let day = 0; day <= 14; day++) {
      const dateStr = formatDate(checkDate)
      const dayDir = join(this.workspaceRoot, 'memory', dateStr)
      const dayMemoryFile = join(dayDir, 'memory.jsonl')

      try {
        if (existsSync(dayMemoryFile)) {
          const dayMessages = await this.readMessagesFromFile(dayMemoryFile)

          for (const msg of dayMessages) {
            // 开始收集
            if (msg.id === startId) {
              collecting = true
            }

            // 收集中的消息加入结果
            if (collecting) {
              result.push(msg)
            }

            // 到达结束ID，停止收集
            if (msg.id === endId) {
              return result
            }
          }
        }
      } catch (error) {
        logger.error(`[Memory] 读取 ${dateStr} 消息失败: ${error}`)
      }

      checkDate.setDate(checkDate.getDate() - 1)
    }

    // 如果没找到结束ID，但找到了开始ID，返回已收集的消息
    if (collecting) {
      return result
    }

    // 都没找到，返回空数组
    return []
  }
}

export const GLOBAL_MEMORY = new Memory()
export { jsonMemoryManager }
