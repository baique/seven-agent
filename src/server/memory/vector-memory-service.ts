/**
 * VectorMemoryService - 向量记忆系统服务
 * 负责初始化和管理向量记忆系统的生命周期
 */

import {
  vectorMemoryDB,
  createEmbeddingProvider,
  createMemorySyncManager,
  createHybridSearcher,
  type EmbeddingProviderManager,
  type MemorySyncManager,
  type HybridSearcher,
} from './vector/index'
import { logger } from '../utils/logger'

/**
 * 向量记忆服务配置
 */
export interface VectorMemoryServiceConfig {
  /** 向量维度（默认768） */
  vectorDimensions?: number
  /** 嵌入提供者配置 */
  embedding?: {
    local?: {
      enabled?: boolean
      modelName?: string
      modelPath?: string
      dimensions?: number
    }
    remote?: {
      enabled?: boolean
      apiKey?: string
      baseUrl?: string
      model?: string
      dimensions?: number
    }
  }
}

/**
 * 向量记忆服务
 */
class VectorMemoryService {
  private initialized = false
  private embeddingProvider: EmbeddingProviderManager | null = null
  private syncManager: MemorySyncManager | null = null
  private searcher: HybridSearcher | null = null

  /**
   * 初始化向量记忆服务
   */
  async initialize(config: VectorMemoryServiceConfig = {}): Promise<void> {
    if (this.initialized) {
      logger.info('[VectorMemoryService] 服务已初始化，跳过')
      return
    }

    logger.info('[VectorMemoryService] 开始初始化...')

    try {
      // 1. 初始化数据库
      await vectorMemoryDB.initialize({
        vectorDimensions: config.vectorDimensions || 768,
      })

      // 2. 初始化嵌入提供者
      const remoteConfig = config.embedding?.remote?.apiKey
        ? (config.embedding.remote as {
            apiKey: string
            baseUrl?: string
            model?: string
            dimensions?: number
          })
        : undefined
      this.embeddingProvider = createEmbeddingProvider({
        local: config.embedding?.local,
        remote: remoteConfig,
        preferLocal: config.embedding?.local?.enabled !== false,
      })
      await this.embeddingProvider.initialize()

      const providerInfo = this.embeddingProvider.getProviderInfo()
      logger.info(
        `[VectorMemoryService] 嵌入提供者: ${providerInfo?.id} (${providerInfo?.model}, ${providerInfo?.dimensions}维)`,
      )

      // 3. 初始化同步管理器
      this.syncManager = createMemorySyncManager(vectorMemoryDB, this.embeddingProvider)
      await this.syncManager.initialize()

      // 4. 初始化搜索器
      this.searcher = createHybridSearcher(
        vectorMemoryDB.getDatabase(),
        this.embeddingProvider,
        vectorMemoryDB.isVectorEnabled(),
      )

      this.initialized = true
      logger.info('[VectorMemoryService] 初始化完成')

      // 打印统计信息
      const stats = vectorMemoryDB.getStats()
      logger.info(
        `[VectorMemoryService] 当前记忆统计: ${stats.totalMemories}条 (长期${stats.memoryCount}, 对话${stats.dialogCount}), 向量${stats.vectorCount}`,
      )
    } catch (err) {
      logger.error(err, '[VectorMemoryService] 初始化失败')
      throw err
    }
  }

  /**
   * 执行强制同步（压缩摘要后调用）
   */
  async forceSync(): Promise<void> {
    if (!this.initialized || !this.syncManager) {
      logger.warn('[VectorMemoryService] 服务未初始化，跳过强制同步')
      return
    }

    try {
      logger.info('[VectorMemoryService] 开始强制同步...')
      const report = await this.syncManager.forceSync()
      logger.info(
        `[VectorMemoryService] 强制同步完成: 记忆文件${report.memoryFiles.synced}/${report.memoryFiles.total}, 对话文件${report.dialogFiles.synced}/${report.dialogFiles.total}, 耗时${report.duration}ms`,
      )
    } catch (err) {
      logger.error(err, '[VectorMemoryService] 强制同步失败')
      // 不抛出错误，避免影响主流程
    }
  }

  /**
   * catch-up 同步 - 兜底/重试机制
   * 只处理对话文件：增量 gap 补全 + 失败重试，不碰长期记忆
   */
  async catchUpSync(): Promise<void> {
    if (!this.initialized || !this.syncManager) {
      logger.debug('[VectorMemoryService] 服务未初始化，跳过 catch-up 同步')
      return
    }

    try {
      const report = await this.syncManager.catchUpSync()
      if (report.dialogFiles.synced > 0 || report.dialogFiles.failed > 0) {
        logger.info(
          `[VectorMemoryService] catch-up 同步: 对话文件${report.dialogFiles.synced}/${report.dialogFiles.total}(+${report.dialogFiles.added}), 失败${report.dialogFiles.failed}, 耗时${report.duration}ms`,
        )
      }
    } catch (err) {
      logger.error(err, '[VectorMemoryService] catch-up 同步失败')
    }
  }

  /**
   * 异步同步（记忆变更后调用）
   */
  asyncSync(sourceFile: string): void {
    if (!this.initialized || !this.syncManager) {
      logger.warn('[VectorMemoryService] 服务未初始化，跳过异步同步')
      return
    }

    this.syncManager.asyncSync(sourceFile)
  }

  /**
   * 批量同步（新消息写入后调用）
   */
  batchSync(
    dialogFile: string,
    messages: Array<{ id: string; type: string; content: string; timestamp: number }>,
  ): void {
    if (!this.initialized || !this.syncManager) {
      logger.warn('[VectorMemoryService] 服务未初始化，跳过批量同步')
      return
    }

    this.syncManager.batchSync(dialogFile, messages)
  }

  /**
   * 立即刷新批量队列
   */
  async flushBatchQueue(): Promise<void> {
    if (!this.initialized || !this.syncManager) {
      return
    }

    await this.syncManager.flushBatchQueue()
  }

  /**
   * 执行混合搜索
   */
  async search(
    query: string,
    options: {
      maxResults?: number
      sourceTypes?: Array<'memory' | 'dialog'>
      startTime?: number
      endTime?: number
    } = {},
  ) {
    if (!this.initialized || !this.searcher) {
      logger.warn('[VectorMemoryService] 服务未初始化，返回空结果')
      return []
    }

    return this.searcher.search({
      query,
      maxResults: options.maxResults || 10,
      sourceTypes: options.sourceTypes,
      startTime: options.startTime,
      endTime: options.endTime,
    })
  }

  /**
   * 获取数据库实例
   */
  getDatabase() {
    return vectorMemoryDB.getDatabase()
  }

  /**
   * 检查是否支持向量搜索
   */
  isVectorEnabled(): boolean {
    return vectorMemoryDB.isVectorEnabled()
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return vectorMemoryDB.getStats()
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * 关闭服务
   */
  close(): void {
    if (!this.initialized) return

    logger.info('[VectorMemoryService] 正在关闭...')

    // 刷新批量队列
    this.flushBatchQueue().catch(() => {})

    // 关闭数据库连接
    vectorMemoryDB.close()

    this.initialized = false
    this.embeddingProvider = null
    this.syncManager = null
    this.searcher = null

    logger.info('[VectorMemoryService] 已关闭')
  }
}

// 单例实例
export const vectorMemoryService = new VectorMemoryService()
