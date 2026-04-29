/**
 * JSON文件存储的长期记忆管理器
 * 替代DuckDB，使用context/remember目录下的JSON文件存储
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { paths } from '../config/env'
import { logger } from '../utils/logger'
import { ensureDir } from '../utils/workspace'
import { nanoid } from 'nanoid'

/** 碎片记忆项 */
export interface FragmentMemory {
  /** 记忆唯一ID */
  id: string
  /** 关联的消息ID */
  eventId: string
  /** 记忆描述 */
  description: string
  /** 重要性 0-1 */
  importance: number
  /** 过期时间 ISO格式 */
  expireAt: string
  /** 创建时间 ISO格式 */
  createdAt: string
}

/** 长期记忆项 */
export interface LongTermMemoryItem {
  /** 记忆唯一ID */
  id: string
  /** 关联的消息ID */
  eventId: string
  /** 记忆描述 */
  description: string
  /** 重要性 0-1 */
  importance: number
  /** 创建时间 ISO格式 */
  createdAt: string
  /** 更新时间 ISO格式 */
  updatedAt: string
}

/** 记忆查询结果 */
export interface MemoryQueryResult {
  /** 记忆列表 */
  memories: (FragmentMemory | LongTermMemoryItem)[]
  /** 是否还有更多 */
  hasMore: boolean
  /** 总数 */
  total: number
}

/** 记忆搜索选项 */
export interface MemorySearchOptions {
  /** 搜索关键词 */
  keywords?: string[]
  /** 最低重要性 */
  minImportance?: number
  /** 跳过前N条 */
  offset?: number
  /** 最大返回数量 */
  limit?: number
  /** 是否包含过期记忆 */
  includeExpired?: boolean
}

/** 操作队列，确保串行执行 */
let operationQueue: Promise<void> = Promise.resolve()

/**
 * JSON文件记忆管理器
 * 管理碎片记忆（按日期存储）和长期记忆（main.json）
 */
export class JsonMemoryManager {
  private baseDir: string = ''

  constructor() {}

  async initialize(workspaceRoot: string): Promise<void> {
    this.baseDir = path.join(workspaceRoot, 'context', 'remember')
    await ensureDir(this.baseDir)
    await ensureDir(this.getFragmentsDir())

    const mainFile = this.getMainFilePath()
    try {
      await fs.access(mainFile)
    } catch {
      await fs.writeFile(mainFile, JSON.stringify([], null, 2), 'utf-8')
      logger.info(`[JsonMemoryManager] 创建长期记忆文件: ${mainFile}`)
    }

    logger.info(`[JsonMemoryManager] 初始化完成: ${this.baseDir}`)
  }

  private getFragmentsDir(): string {
    return path.join(this.baseDir, 'fragments')
  }

  private getMainFilePath(): string {
    return path.join(this.baseDir, 'main.json')
  }

  private getFragmentFilePath(dateStr: string): string {
    return path.join(this.getFragmentsDir(), `${dateStr}.json`)
  }

  private getTodayStr(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}${month}${day}`
  }

  /**
   * 执行操作，通过队列确保串行执行
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      operationQueue = operationQueue.then(async () => {
        try {
          const result = await fn()
          resolve(result)
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  /**
   * 读取JSON文件
   */
  private async readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content) as T
    } catch (error) {
      return defaultValue
    }
  }

  /**
   * 写入JSON文件
   */
  private async writeJsonFile<T>(filePath: string, data: T): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  /**
   * 添加碎片记忆
   * @param description 记忆描述
   * @param importance 重要性 0-1
   * @param expireAt 过期时间字符串（年月日时分秒格式或ISO格式）
   * @param eventId 关联的消息ID（可选，自动生成）
   * @returns 创建的记忆项
   */
  async addFragmentMemory(
    description: string,
    importance: number,
    expireAt: string,
    eventId?: string,
  ): Promise<FragmentMemory> {
    return this.withLock(async () => {
      // 解析过期时间
      const parsedExpireAt = this.parseExpireTime(expireAt)

      const todayStr = this.getTodayStr()

      const memory: FragmentMemory = {
        id: `frag-${todayStr}-${nanoid(6)}`,
        eventId: eventId || `msg-${nanoid(8)}`,
        description,
        importance: Math.max(0, Math.min(1, importance)),
        expireAt: parsedExpireAt,
        createdAt: new Date().toISOString(),
      }
      const filePath = this.getFragmentFilePath(todayStr)

      // 读取现有记忆
      const memories = await this.readJsonFile<FragmentMemory[]>(filePath, [])

      // 添加新记忆
      memories.push(memory)

      // 保存
      await this.writeJsonFile(filePath, memories)

      logger.info(`[JsonMemoryManager] 添加碎片记忆: ${memory.id}, 重要性: ${memory.importance}`)
      return memory
    })
  }

  /**
   * 解析过期时间字符串
   * 支持格式：
   * - 2026年04月24日15时30分45秒
   * - 2026-04-24 15:30:45
   * - ISO格式
   */
  private parseExpireTime(timeStr: string): string {
    // 尝试解析中文格式：2026年04月24日15时30分45秒
    const chineseMatch = timeStr.match(
      /^(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分(\d{1,2})秒$/,
    )
    if (chineseMatch) {
      const date = new Date(
        parseInt(chineseMatch[1], 10),
        parseInt(chineseMatch[2], 10) - 1,
        parseInt(chineseMatch[3], 10),
        parseInt(chineseMatch[4], 10),
        parseInt(chineseMatch[5], 10),
        parseInt(chineseMatch[6], 10),
      )
      return date.toISOString()
    }

    // 尝试解析标准格式：2026-04-24 15:30:45
    const standardMatch = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
    if (standardMatch) {
      const date = new Date(
        parseInt(standardMatch[1], 10),
        parseInt(standardMatch[2], 10) - 1,
        parseInt(standardMatch[3], 10),
        parseInt(standardMatch[4], 10),
        parseInt(standardMatch[5], 10),
        parseInt(standardMatch[6], 10),
      )
      return date.toISOString()
    }

    // 尝试直接解析为Date
    const date = new Date(timeStr)
    if (!isNaN(date.getTime())) {
      return date.toISOString()
    }

    // 默认一年后过期
    const defaultDate = new Date()
    defaultDate.setFullYear(defaultDate.getFullYear() + 1)
    return defaultDate.toISOString()
  }

  /**
   * 添加长期记忆
   * @param description 记忆描述
   * @param importance 重要性 0-1
   * @param eventId 关联的消息ID
   * @returns 创建的记忆项
   */
  async addLongTermMemory(
    description: string,
    importance: number,
    eventId?: string,
  ): Promise<LongTermMemoryItem> {
    return this.withLock(async () => {
      const memory: LongTermMemoryItem = {
        id: `ltm-${nanoid(8)}`,
        eventId: eventId || `msg-${nanoid(8)}`,
        description,
        importance: Math.max(0, Math.min(1, importance)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const filePath = this.getMainFilePath()
      const memories = await this.readJsonFile<LongTermMemoryItem[]>(filePath, [])

      memories.push(memory)
      await this.writeJsonFile(filePath, memories)

      logger.info(`[JsonMemoryManager] 添加长期记忆: ${memory.id}, 重要性: ${memory.importance}`)
      return memory
    })
  }

  /**
   * 获取所有碎片记忆文件日期列表（按时间倒序）
   */
  async getFragmentDates(): Promise<string[]> {
    try {
      const fragmentsDir = this.getFragmentsDir()
      const files = await fs.readdir(fragmentsDir)
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort((a, b) => b.localeCompare(a))
    } catch {
      return []
    }
  }

  /**
   * 获取指定日期的碎片记忆
   */
  async getFragmentMemoriesByDate(dateStr: string): Promise<FragmentMemory[]> {
    const filePath = this.getFragmentFilePath(dateStr)
    return this.readJsonFile<FragmentMemory[]>(filePath, [])
  }

  /**
   * 获取近N天的碎片记忆
   */
  async getRecentFragmentMemories(days: number): Promise<FragmentMemory[]> {
    const dates = await this.getFragmentDates()
    const recentDates = dates.slice(0, days)

    const allMemories: FragmentMemory[] = []
    for (const dateStr of recentDates) {
      const memories = await this.getFragmentMemoriesByDate(dateStr)
      allMemories.push(...memories)
    }

    return allMemories.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  /**
   * 获取近N小时的碎片记忆
   */
  async getRecentFragmentMemoriesByHours(hours: number): Promise<FragmentMemory[]> {
    const now = new Date()
    const cutoffTime = new Date(now.getTime() - hours * 60 * 60 * 1000)

    const dates = await this.getFragmentDates()
    const allMemories: FragmentMemory[] = []

    for (const dateStr of dates) {
      // 检查日期是否在时间范围内
      const year = parseInt(dateStr.slice(0, 4), 10)
      const month = parseInt(dateStr.slice(4, 6), 10) - 1
      const day = parseInt(dateStr.slice(6, 8), 10)
      const fileDate = new Date(year, month, day)

      // 如果文件日期早于截止时间，跳过
      if (
        fileDate < new Date(cutoffTime.getFullYear(), cutoffTime.getMonth(), cutoffTime.getDate())
      ) {
        continue
      }

      const memories = await this.getFragmentMemoriesByDate(dateStr)
      // 过滤出在时间范围内的记忆
      const filteredMemories = memories.filter((m) => new Date(m.createdAt) >= cutoffTime)
      allMemories.push(...filteredMemories)
    }

    return allMemories.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  /**
   * 获取所有长期记忆
   */
  async getAllLongTermMemories(): Promise<LongTermMemoryItem[]> {
    const filePath = this.getMainFilePath()
    return this.readJsonFile<LongTermMemoryItem[]>(filePath, [])
  }

  /**
   * 根据重要性获取长期记忆
   */
  async getLongTermMemoriesByImportance(minImportance: number): Promise<LongTermMemoryItem[]> {
    const memories = await this.getAllLongTermMemories()
    return memories.filter((m) => m.importance >= minImportance)
  }

  /**
   * 搜索记忆（同时搜索长期记忆和碎片记忆）
   */
  async searchMemories(options: MemorySearchOptions): Promise<MemoryQueryResult> {
    const {
      keywords = [],
      minImportance = 0,
      offset = 0,
      limit = 20,
      includeExpired = false,
    } = options

    const now = new Date().toISOString()
    const results: (FragmentMemory | LongTermMemoryItem)[] = []

    // 搜索长期记忆
    const longTermMemories = await this.getAllLongTermMemories()
    for (const memory of longTermMemories) {
      if (memory.importance < minImportance) continue
      if (this.matchesKeywords(memory, keywords)) {
        results.push(memory)
      }
    }

    // 搜索碎片记忆
    const dates = await this.getFragmentDates()
    for (const dateStr of dates) {
      const memories = await this.getFragmentMemoriesByDate(dateStr)
      for (const memory of memories) {
        if (memory.importance < minImportance) continue
        if (!includeExpired && memory.expireAt < now) continue
        if (this.matchesKeywords(memory, keywords)) {
          results.push(memory)
        }
      }
    }

    // 按重要性排序
    results.sort((a, b) => b.importance - a.importance)

    const total = results.length
    const paginatedResults = results.slice(offset, offset + limit)
    const hasMore = offset + paginatedResults.length < total

    return {
      memories: paginatedResults,
      hasMore,
      total,
    }
  }

  /**
   * 检查记忆是否匹配关键词
   */
  private matchesKeywords(
    memory: FragmentMemory | LongTermMemoryItem,
    keywords: string[],
  ): boolean {
    if (keywords.length === 0) return true

    const text = memory.description.toLowerCase()
    return keywords.every((k) => text.includes(k.toLowerCase()))
  }

  /**
   * 删除长期记忆
   */
  async deleteLongTermMemory(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const filePath = this.getMainFilePath()
      const memories = await this.readJsonFile<LongTermMemoryItem[]>(filePath, [])
      const index = memories.findIndex((m) => m.id === id)

      if (index !== -1) {
        memories.splice(index, 1)
        await this.writeJsonFile(filePath, memories)
        logger.info(`[JsonMemoryManager] 删除长期记忆: ${id}`)
        return true
      }

      return false
    })
  }

  /**
   * 更新长期记忆
   */
  async updateLongTermMemory(
    id: string,
    updates: Partial<Pick<LongTermMemoryItem, 'description' | 'importance'>>,
  ): Promise<boolean> {
    return this.withLock(async () => {
      const filePath = this.getMainFilePath()
      const memories = await this.readJsonFile<LongTermMemoryItem[]>(filePath, [])
      const memory = memories.find((m) => m.id === id)

      if (!memory) return false

      if (updates.description !== undefined) {
        memory.description = updates.description
      }
      if (updates.importance !== undefined) {
        memory.importance = Math.max(0, Math.min(1, updates.importance))
      }
      memory.updatedAt = new Date().toISOString()

      await this.writeJsonFile(filePath, memories)
      logger.info(`[JsonMemoryManager] 更新长期记忆: ${id}`)
      return true
    })
  }

  /**
   * 从碎片记忆ID解析日期
   * ID格式: frag-YYYYMMDD-xxxxxx
   * @returns 日期字符串 YYYYMMDD
   */
  private parseFragmentIdDate(id: string): string | null {
    const match = id.match(/^frag-(\d{8})-/)
    return match ? match[1] : null
  }

  /**
   * 根据ID查找碎片记忆
   * 利用ID中的日期信息直接定位文件
   * @returns 记忆项和所在日期，未找到返回null
   */
  async findFragmentMemoryById(
    id: string,
  ): Promise<{ memory: FragmentMemory; dateStr: string } | null> {
    const dateStr = this.parseFragmentIdDate(id)
    if (!dateStr) return null

    const filePath = this.getFragmentFilePath(dateStr)
    const memories = await this.readJsonFile<FragmentMemory[]>(filePath, [])
    const memory = memories.find((m) => m.id === id)

    if (memory) {
      return { memory, dateStr }
    }

    return null
  }

  /**
   * 更新碎片记忆
   * 利用ID中的日期信息直接定位文件
   */
  async updateFragmentMemory(
    id: string,
    updates: Partial<Pick<FragmentMemory, 'description' | 'importance' | 'expireAt'>>,
  ): Promise<boolean> {
    return this.withLock(async () => {
      const dateStr = this.parseFragmentIdDate(id)
      if (!dateStr) return false

      const filePath = this.getFragmentFilePath(dateStr)
      const memories = await this.readJsonFile<FragmentMemory[]>(filePath, [])
      const memory = memories.find((m) => m.id === id)

      if (!memory) return false

      if (updates.description !== undefined) {
        memory.description = updates.description
      }
      if (updates.importance !== undefined) {
        memory.importance = Math.max(0, Math.min(1, updates.importance))
      }
      if (updates.expireAt !== undefined) {
        memory.expireAt = this.parseExpireTime(updates.expireAt)
      }

      await this.writeJsonFile(filePath, memories)
      logger.info(`[JsonMemoryManager] 更新碎片记忆: ${id}`)
      return true
    })
  }

  /**
   * 删除碎片记忆
   * 利用ID中的日期信息直接定位文件
   */
  async deleteFragmentMemory(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const dateStr = this.parseFragmentIdDate(id)
      if (!dateStr) return false

      const filePath = this.getFragmentFilePath(dateStr)
      const memories = await this.readJsonFile<FragmentMemory[]>(filePath, [])
      const index = memories.findIndex((m) => m.id === id)

      if (index !== -1) {
        memories.splice(index, 1)
        await this.writeJsonFile(filePath, memories)
        logger.info(`[JsonMemoryManager] 删除碎片记忆: ${id}`)
        return true
      }

      return false
    })
  }

  /**
   * 获取本日碎片记忆 + 近72小时碎片记忆（用于提示词注入和更新响应，可配置）
   * 返回格式化的记忆列表
   */
  async getTodayAndRecentFragments(): Promise<{
    todayMemories: FragmentMemory[]
    recentFragments: FragmentMemory[]
  }> {
    const { configManager } = await import('../config/env')
    const retentionHours = configManager.get('FRAGMENT_MEMORY_RETENTION_HOURS')

    const todayStr = this.getTodayStr()
    const todayMemories = await this.getFragmentMemoriesByDate(todayStr)
    const validTodayMemories = todayMemories.filter((m) => new Date(m.expireAt) > new Date())

    const recentFragments = await this.getRecentFragmentMemoriesByHours(retentionHours)
    const validRecentFragments = recentFragments.filter((m) => new Date(m.expireAt) > new Date())

    return {
      todayMemories: validTodayMemories.sort((a, b) => b.importance - a.importance),
      recentFragments: validRecentFragments.sort((a, b) => b.importance - a.importance),
    }
  }

  /**
   * 清理过期碎片记忆
   */
  async cleanupExpiredFragments(): Promise<number> {
    return this.withLock(async () => {
      const now = new Date().toISOString()
      const dates = await this.getFragmentDates()
      let deletedCount = 0

      for (const dateStr of dates) {
        const filePath = this.getFragmentFilePath(dateStr)
        const memories = await this.readJsonFile<FragmentMemory[]>(filePath, [])
        const validMemories = memories.filter((m) => {
          if (m.expireAt < now) {
            logger.info(`[JsonMemoryManager] 清理过期碎片记忆: ${m.id} ${m.description}`)
            deletedCount++
            return false
          }
          return true
        })

        if (validMemories.length !== memories.length) {
          await this.writeJsonFile(filePath, validMemories)
        }
      }

      return deletedCount
    })
  }
}

/** 全局JSON记忆管理器实例 */
export const jsonMemoryManager = new JsonMemoryManager()
