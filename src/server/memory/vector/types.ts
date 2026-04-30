/**
 * 向量记忆系统类型定义
 * 提供统一的类型接口，与现有系统最小侵入
 */

/**
 * 记忆来源类型
 */
export type MemorySourceType = 'memory' | 'dialog'

/**
 * 记忆记录（数据库存储格式）
 */
export interface MemoryRecord {
  /** 数据库主键 */
  id: string
  /** 记忆内容 */
  content: string
  /** 来源类型 */
  sourceType: MemorySourceType
  /** 来源ID（memory:event_id, dialog:message_id） */
  sourceId: string
  /** 来源文件路径（相对工作区） */
  sourceFile: string
  /** 在源文件中的位置（memory:数组索引, dialog:行号） */
  sourcePosition: number
  /** 元数据（JSON字符串） */
  metadata: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳（仅memory支持） */
  updatedAt: number | null
  /** 软删除标记 */
  isDeleted: number
}

/**
 * 长期记忆元数据
 */
export interface LongTermMemoryMetadata {
  importance: number
  eventType?: string
  tags?: string[]
}

/**
 * 对话记录元数据
 */
export interface DialogMemoryMetadata {
  role: string
  type?: string
  hasToolCalls?: boolean
}

/**
 * 同步状态记录
 */
export interface SyncStateRecord {
  sourceFile: string
  sourceType: MemorySourceType
  fileHash: string | null
  fileSize: number
  fileMtime: number
  lastSyncAt: number
  syncStatus: 'pending' | 'syncing' | 'synced' | 'failed'
  syncError: string | null
}

/**
 * 混合搜索参数
 */
export interface HybridSearchParams {
  /** 搜索查询 */
  query: string
  /** 最大结果数（默认10） */
  maxResults?: number
  /** 最小分数阈值（默认0.35） */
  minScore?: number
  /** 向量权重（默认0.7） */
  vectorWeight?: number
  /** 文本权重（默认0.3） */
  textWeight?: number
  /** 来源类型过滤 */
  sourceTypes?: MemorySourceType[]
  /** 时间范围开始 */
  startTime?: number
  /** 时间范围结束 */
  endTime?: number
  /** 是否启用MMR（默认true） */
  mmrEnabled?: boolean
  /** MMR参数lambda（默认0.7） */
  mmrLambda?: number
  /** 是否启用时间衰减（默认true） */
  temporalDecayEnabled?: boolean
  /** 半衰期天数（默认30） */
  temporalHalfLifeDays?: number
}

/**
 * 混合搜索结果
 */
export interface HybridSearchResult {
  id: string
  content: string
  sourceType: MemorySourceType
  sourceId: string
  sourceFile: string
  sourcePosition: number
  createdAt: number
  /** 综合分数 */
  score: number
  /** 向量相似度 */
  vectorScore: number
  /** 文本匹配分数 */
  textScore: number
  /** 内容片段（截断后） */
  snippet: string
  /** 元数据 */
  metadata?: LongTermMemoryMetadata | DialogMemoryMetadata
}

/**
 * 嵌入提供者接口
 */
export interface EmbeddingProvider {
  id: string
  model: string
  dimensions: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

/**
 * 同步选项
 */
export interface SyncOptions {
  /** 强制同步（忽略哈希检查） */
  force?: boolean
  /** 是否阻塞等待 */
  blocking?: boolean
}

/**
 * 同步报告
 */
export interface SyncReport {
  timestamp: number
  duration: number
  memoryFiles: {
    total: number
    synced: number
    failed: number
    added: number
    updated: number
    deleted: number
  }
  dialogFiles: {
    total: number
    synced: number
    failed: number
    added: number
  }
}
