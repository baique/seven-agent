/**
 * MemorySyncManager - 记忆同步管理器
 * 职责：将 JSON 文件（长期记忆 + 对话记录）同步到 SQLite 索引
 * 同步策略：
 * 1. 强制同步（压缩摘要后触发）- 阻塞式，必须完成
 * 2. 异步同步（记忆变更后触发）- 非阻塞，失败可重试
 * 3. 批量同步（新消息写入）- 合并多次写入，批量处理
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { VectorMemoryDB } from './db'
import type { EmbeddingProviderManager } from './embedding'
import type { MemoryRecord, MemorySourceType, SyncReport, SyncStateRecord } from './types'
import { paths } from '../../config/env'

/**
 * 同步选项
 */
interface SyncOptions {
  /** 强制同步（忽略哈希检查） */
  force?: boolean
  /** 是否阻塞等待 */
  blocking?: boolean
}

/**
 * 长期记忆 JSON 结构
 */
interface LongTermMemoryJSON {
  id: string
  description: string
  importance: number
  eventId?: string
  createdAt: string
  updatedAt?: string
  eventType?: string
  tags?: string[]
}

/**
 * 对话消息 JSON 结构
 */
interface DialogMessageJSON {
  id: string
  type: string
  content: string
  timestamp: number
  tool_calls?: any[]
}

/**
 * 记忆同步管理器
 */
export class MemorySyncManager {
  private db: VectorMemoryDB
  private embeddingProvider: EmbeddingProviderManager
  private initialized = false

  // 异步同步队列
  private pendingSyncs = new Map<string, Promise<void>>()
  
  // 批量同步队列
  private batchQueue = new Map<string, DialogMessageJSON[]>()
  private batchTimer: NodeJS.Timeout | null = null
  private readonly BATCH_SIZE = 10
  private readonly BATCH_TIMEOUT_MS = 5000

  constructor(db: VectorMemoryDB, embeddingProvider: EmbeddingProviderManager) {
    this.db = db
    this.embeddingProvider = embeddingProvider
  }

  /**
   * 初始化同步管理器
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // 确保数据库已初始化
    if (!this.db.isVectorEnabled() && !this.db.getDatabase()) {
      throw new Error('数据库未初始化')
    }

    this.initialized = true
    console.log('[MemorySyncManager] 初始化完成')
  }

  /**
   * 【P0】强制同步 - 压缩摘要后调用
   * 特点：阻塞式，必须完成，失败则重试
   */
  async forceSync(): Promise<SyncReport> {
    console.log('[Sync] 开始强制同步（压缩摘要触发）')
    const startTime = Date.now()

    const report: SyncReport = {
      timestamp: startTime,
      duration: 0,
      memoryFiles: { total: 0, synced: 0, failed: 0, added: 0, updated: 0, deleted: 0 },
      dialogFiles: { total: 0, synced: 0, failed: 0, added: 0 },
    }

    try {
      // 1. 同步所有长期记忆文件
      const memoryFiles = await this.listMemoryFiles()
      report.memoryFiles.total = memoryFiles.length

      for (const file of memoryFiles) {
        try {
          const result = await this.syncMemoryFile(file, { force: true })
          report.memoryFiles.synced++
          report.memoryFiles.added += result.added
          report.memoryFiles.updated += result.updated
          report.memoryFiles.deleted += result.deleted
        } catch (err) {
          console.error(`[Sync] 同步失败 ${file}: ${err}`)
          report.memoryFiles.failed++
        }
      }

      // 2. 同步所有对话文件
      const dialogFiles = await this.listDialogFiles()
      report.dialogFiles.total = dialogFiles.length

      for (const file of dialogFiles) {
        try {
          const result = await this.syncDialogFile(file, { force: true })
          report.dialogFiles.synced++
          report.dialogFiles.added += result.added
        } catch (err) {
          console.error(`[Sync] 同步失败 ${file}: ${err}`)
          report.dialogFiles.failed++
        }
      }

      // 3. 清理已删除的数据
      await this.cleanupDeletedRecords()

      report.duration = Date.now() - startTime
      console.log(`[Sync] 强制同步完成: ${JSON.stringify(report)}`)
      return report

    } catch (err) {
      console.error(`[Sync] 强制同步失败: ${err}`)
      throw err
    }
  }

  /**
   * 【P1】异步同步 - 记忆变更后调用
   * 特点：非阻塞，失败可重试
   */
  asyncSync(sourceFile: string): void {
    // 防重复：如果该文件正在同步，等待完成后再触发新的
    const existing = this.pendingSyncs.get(sourceFile)
    if (existing) {
      existing.then(() => this.scheduleAsyncSync(sourceFile))
      return
    }

    this.scheduleAsyncSync(sourceFile)
  }

  private scheduleAsyncSync(sourceFile: string): void {
    const syncPromise = this.doAsyncSync(sourceFile)
      .catch(err => {
        console.error(`[Sync] 异步同步失败 ${sourceFile}: ${err}`)
        // 标记失败状态
        this.markSyncFailed(sourceFile, String(err))
      })
      .finally(() => {
        this.pendingSyncs.delete(sourceFile)
      })

    this.pendingSyncs.set(sourceFile, syncPromise)
  }

  private async doAsyncSync(sourceFile: string): Promise<void> {
    const isMemory = sourceFile.includes('remember')
    
    if (isMemory) {
      await this.syncMemoryFile(sourceFile, { force: false })
    } else {
      await this.syncDialogFile(sourceFile, { force: false })
    }
  }

  /**
   * 【P1】批量同步 - 新消息写入
   * 特点：合并多次写入，批量处理
   */
  batchSync(dialogFile: string, messages: DialogMessageJSON[]): void {
    // 添加到批量队列
    const existing = this.batchQueue.get(dialogFile) || []
    this.batchQueue.set(dialogFile, [...existing, ...messages])

    // 重置定时器
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
    }

    // 触发条件：队列满N条 或 超时M秒
    const totalMessages = Array.from(this.batchQueue.values())
      .reduce((sum, msgs) => sum + msgs.length, 0)

    if (totalMessages >= this.BATCH_SIZE) {
      this.flushBatchQueue()
    } else {
      this.batchTimer = setTimeout(() => {
        this.flushBatchQueue()
      }, this.BATCH_TIMEOUT_MS)
    }
  }

  /**
   * 立即刷新批量队列
   */
  async flushBatchQueue(): Promise<void> {
    if (this.batchQueue.size === 0) return

    // 清空定时器
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }

    // 复制队列并清空
    const queue = new Map(this.batchQueue)
    this.batchQueue.clear()

    // 处理队列
    for (const [dialogFile, messages] of queue) {
      try {
        await this.syncDialogBatch(dialogFile, messages)
      } catch (err) {
        console.error(`[Sync] 批量同步失败 ${dialogFile}: ${err}`)
      }
    }
  }

  /**
   * 同步单个长期记忆文件
   */
  private async syncMemoryFile(
    filePath: string,
    options: { force?: boolean } = {}
  ): Promise<{ added: number; updated: number; deleted: number }> {
    const result = { added: 0, updated: 0, deleted: 0 }

    // 1. 读取文件内容
    const fileContent = await fs.readFile(filePath, 'utf-8')
    const fileHash = crypto.createHash('md5').update(fileContent).digest('hex')
    const fileStat = await fs.stat(filePath)

    // 2. 检查是否需要同步
    if (!options.force) {
      const syncState = this.db.getSyncState(filePath)
      if (syncState?.fileHash === fileHash) {
        console.log(`[Sync] 文件未变更，跳过: ${filePath}`)
        return result
      }
    }

    // 3. 解析JSON内容
    let memories: LongTermMemoryJSON[]
    try {
      memories = JSON.parse(fileContent)
      if (!Array.isArray(memories)) {
        // 可能是单条记录
        memories = [memories]
      }
    } catch (err) {
      console.error(`[Sync] JSON解析失败 ${filePath}: ${err}`)
      throw err
    }

    const currentIds = new Set(memories.map(m => m.id))

    // 4. 获取SQLite中该文件的现有记录
    const existingRows = this.db.getMemoriesBySourceFile(filePath)
    const existingIdMap = new Map(existingRows.map(r => [r.sourceId, r]))

    // 5. 分类处理
    const toInsert: LongTermMemoryJSON[] = []
    const toUpdate: Array<{ memory: LongTermMemoryJSON; existingId: string }> = []

    for (const memory of memories) {
      const existing = existingIdMap.get(memory.id)
      if (!existing) {
        toInsert.push(memory)
      } else if (existing.content !== memory.description) {
        toUpdate.push({ memory, existingId: existing.id })
      }
      existingIdMap.delete(memory.id)
    }

    // 剩余的就是已删除的
    const toDelete = Array.from(existingIdMap.values())

    // 6. 执行数据库操作
    const db = this.db.getDatabase()
    db.exec('BEGIN TRANSACTION')

    try {
      // 6.1 插入新记录
      for (const memory of toInsert) {
        const recordId = `mem-${memory.id}`
        const embedding = await this.embeddingProvider.embed(memory.description)

        const record: MemoryRecord = {
          id: recordId,
          content: memory.description,
          sourceType: 'memory',
          sourceId: memory.id,
          sourceFile: filePath,
          sourcePosition: memories.indexOf(memory),
          metadata: JSON.stringify({
            importance: memory.importance,
            eventType: memory.eventType,
            tags: memory.tags,
          }),
          createdAt: new Date(memory.createdAt).getTime(),
          updatedAt: memory.updatedAt ? new Date(memory.updatedAt).getTime() : null,
          isDeleted: 0,
        }

        this.db.insertMemory(record)
        if (this.db.isVectorEnabled()) {
          this.db.insertVector(recordId, embedding)
        }
        result.added++
      }

      // 6.2 更新现有记录
      for (const { memory, existingId } of toUpdate) {
        const newEmbedding = await this.embeddingProvider.embed(memory.description)

        this.db.updateMemory(
          existingId,
          memory.description,
          JSON.stringify({
            importance: memory.importance,
            eventType: memory.eventType,
            tags: memory.tags,
          }),
          new Date(memory.updatedAt || memory.createdAt).getTime()
        )
        if (this.db.isVectorEnabled()) {
          this.db.updateVector(existingId, newEmbedding)
        }
        result.updated++
      }

      // 6.3 软删除
      for (const existing of toDelete) {
        this.db.softDeleteMemory(existing.id)
        result.deleted++
      }

      // 6.4 更新同步状态
      const syncState: SyncStateRecord = {
        sourceFile: filePath,
        sourceType: 'memory',
        fileHash,
        fileSize: fileStat.size,
        fileMtime: fileStat.mtimeMs,
        lastSyncAt: Date.now(),
        syncStatus: 'synced',
        syncError: null,
      }
      this.db.upsertSyncState(syncState)

      db.exec('COMMIT')

      console.log(
        `[Sync] 长期记忆同步完成: ${filePath} (+${result.added} ~${result.updated} -${result.deleted})`
      )
      return result

    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 同步对话文件
   */
  private async syncDialogFile(
    filePath: string,
    options: { force?: boolean } = {}
  ): Promise<{ added: number }> {
    const result = { added: 0 }

    // 1. 获取当前已同步的最大位置
    const db = this.db.getDatabase()
    const lastSyncResult = db.prepare(`
      SELECT MAX(source_position) as last_pos 
      FROM memories 
      WHERE source_file = ? AND source_type = 'dialog'
    `).get(filePath) as { last_pos: number | null }

    const startPosition = (lastSyncResult?.last_pos ?? -1) + 1

    // 2. 读取文件内容
    const fileContent = await fs.readFile(filePath, 'utf-8')
    const lines = fileContent.split('\n').filter(line => line.trim())

    // 3. 只处理新消息
    const newLines = lines.slice(startPosition)
    if (newLines.length === 0) {
      console.log(`[Sync] 对话文件无新内容: ${filePath}`)
      return result
    }

    // 4. 解析新消息
    const newMessages: DialogMessageJSON[] = []
    for (const line of newLines) {
      try {
        const msg = JSON.parse(line)
        newMessages.push(msg)
      } catch (err) {
        console.warn(`[Sync] 解析消息失败: ${line}`)
      }
    }

    // 5. 批量生成嵌入
    const embeddings = await this.embeddingProvider.embedBatch(
      newMessages.map(m => m.content)
    )

    // 6. 批量插入
    db.exec('BEGIN TRANSACTION')

    try {
      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i]
        const position = startPosition + i
        const recordId = `dlg-${msg.id}`

        const record: MemoryRecord = {
          id: recordId,
          content: msg.content,
          sourceType: 'dialog',
          sourceId: msg.id,
          sourceFile: filePath,
          sourcePosition: position,
          metadata: JSON.stringify({
            role: msg.type,
            hasToolCalls: !!msg.tool_calls,
          }),
          createdAt: msg.timestamp,
          updatedAt: null,
          isDeleted: 0,
        }

        this.db.insertMemory(record)
        if (this.db.isVectorEnabled()) {
          this.db.insertVector(recordId, embeddings[i])
        }
        result.added++
      }

      // 7. 更新同步状态
      const fileStat = await fs.stat(filePath)
      const fileHash = crypto.createHash('md5').update(fileContent).digest('hex')

      const syncState: SyncStateRecord = {
        sourceFile: filePath,
        sourceType: 'dialog',
        fileHash,
        fileSize: fileStat.size,
        fileMtime: fileStat.mtimeMs,
        lastSyncAt: Date.now(),
        syncStatus: 'synced',
        syncError: null,
      }
      this.db.upsertSyncState(syncState)

      db.exec('COMMIT')

      console.log(`[Sync] 对话文件同步完成: ${filePath} (+${result.added})`)
      return result

    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 批量同步对话消息（用于 batchSync）
   */
  private async syncDialogBatch(
    filePath: string,
    messages: DialogMessageJSON[]
  ): Promise<void> {
    // 获取当前位置
    const db = this.db.getDatabase()
    const lastSyncResult = db.prepare(`
      SELECT MAX(source_position) as last_pos 
      FROM memories 
      WHERE source_file = ? AND source_type = 'dialog'
    `).get(filePath) as { last_pos: number | null }

    const startPosition = (lastSyncResult?.last_pos ?? -1) + 1

    // 生成嵌入
    const embeddings = await this.embeddingProvider.embedBatch(
      messages.map(m => m.content)
    )

    // 插入
    db.exec('BEGIN TRANSACTION')

    try {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const recordId = `dlg-${msg.id}`

        const record: MemoryRecord = {
          id: recordId,
          content: msg.content,
          sourceType: 'dialog',
          sourceId: msg.id,
          sourceFile: filePath,
          sourcePosition: startPosition + i,
          metadata: JSON.stringify({
            role: msg.type,
            hasToolCalls: !!msg.tool_calls,
          }),
          createdAt: msg.timestamp,
          updatedAt: null,
          isDeleted: 0,
        }

        this.db.insertMemory(record)
        if (this.db.isVectorEnabled()) {
          this.db.insertVector(recordId, embeddings[i])
        }
      }

      // 更新同步状态
      const fileStat = await fs.stat(filePath)
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const fileHash = crypto.createHash('md5').update(fileContent).digest('hex')

      const syncState: SyncStateRecord = {
        sourceFile: filePath,
        sourceType: 'dialog',
        fileHash,
        fileSize: fileStat.size,
        fileMtime: fileStat.mtimeMs,
        lastSyncAt: Date.now(),
        syncStatus: 'synced',
        syncError: null,
      }
      this.db.upsertSyncState(syncState)

      db.exec('COMMIT')

      console.log(`[Sync] 批量同步完成: ${filePath} (+${messages.length})`)

    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 清理已删除的记录
   */
  private async cleanupDeletedRecords(): Promise<void> {
    // 软删除超过30天的记录可以物理删除
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    
    const db = this.db.getDatabase()
    const result = db.prepare(`
      SELECT id FROM memories 
      WHERE is_deleted = 1 AND updated_at < ?
    `).all(thirtyDaysAgo) as Array<{ id: string }>

    for (const row of result) {
      this.db.deleteMemory(row.id)
    }

    if (result.length > 0) {
      console.log(`[Sync] 清理 ${result.length} 条已删除记录`)
    }
  }

  /**
   * 标记同步失败
   */
  private markSyncFailed(sourceFile: string, error: string): void {
    const syncState: SyncStateRecord = {
      sourceFile,
      sourceType: sourceFile.includes('remember') ? 'memory' : 'dialog',
      fileHash: null,
      fileSize: 0,
      fileMtime: 0,
      lastSyncAt: Date.now(),
      syncStatus: 'failed',
      syncError: error,
    }
    this.db.upsertSyncState(syncState)
  }

  /**
   * 列出所有长期记忆文件
   */
  private async listMemoryFiles(): Promise<string[]> {
    const files: string[] = []
    const memoryDir = path.join(paths.WORKSPACE_ROOT, 'context', 'remember')

    try {
      // 主文件
      const mainFile = path.join(memoryDir, 'main.json')
      if (await this.fileExists(mainFile)) {
        files.push(mainFile)
      }

      // 碎片文件
      const fragmentsDir = path.join(memoryDir, 'fragments')
      if (await this.fileExists(fragmentsDir)) {
        const entries = await fs.readdir(fragmentsDir)
        for (const entry of entries) {
          if (entry.endsWith('.json')) {
            files.push(path.join(fragmentsDir, entry))
          }
        }
      }
    } catch (err) {
      console.error(`[Sync] 列出记忆文件失败: ${err}`)
    }

    return files
  }

  /**
   * 列出所有对话文件
   */
  private async listDialogFiles(): Promise<string[]> {
    const files: string[] = []
    const memoryDir = path.join(paths.WORKSPACE_ROOT, 'memory')

    try {
      if (!(await this.fileExists(memoryDir))) {
        return files
      }

      const entries = await fs.readdir(memoryDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dialogFile = path.join(memoryDir, entry.name, 'memory.jsonl')
          if (await this.fileExists(dialogFile)) {
            files.push(dialogFile)
          }
        }
      }
    } catch (err) {
      console.error(`[Sync] 列出对话文件失败: ${err}`)
    }

    return files
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

/**
 * 创建同步管理器
 */
export function createMemorySyncManager(
  db: VectorMemoryDB,
  embeddingProvider: EmbeddingProviderManager
): MemorySyncManager {
  return new MemorySyncManager(db, embeddingProvider)
}
