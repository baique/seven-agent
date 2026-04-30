/**
 * Vector Memory System - 向量记忆系统
 * 提供基于 SQLite + sqlite-vec 的混合检索能力
 * 
 * 使用方式：
 * ```typescript
 * import { vectorMemoryDB, createEmbeddingProvider, createHybridSearcher } from './vector'
 * 
 * // 1. 初始化数据库
 * await vectorMemoryDB.initialize({ vectorDimensions: 768 })
 * 
 * // 2. 初始化嵌入提供者
 * const embeddingProvider = createEmbeddingProvider({
 *   local: { dimensions: 768 },
 *   remote: { apiKey: 'xxx', model: 'text-embedding-3-small' }
 * })
 * await embeddingProvider.initialize()
 * 
 * // 3. 创建搜索器
 * const searcher = createHybridSearcher(
 *   vectorMemoryDB.getDatabase(),
 *   embeddingProvider,
 *   vectorMemoryDB.isVectorEnabled()
 * )
 * 
 * // 4. 执行搜索
 * const results = await searcher.search({
 *   query: '搜索内容',
 *   maxResults: 10,
 *   sourceTypes: ['memory', 'dialog']
 * })
 * ```
 */

// 类型导出
export type {
  MemorySourceType,
  MemoryRecord,
  LongTermMemoryMetadata,
  DialogMemoryMetadata,
  SyncStateRecord,
  HybridSearchParams,
  HybridSearchResult,
  EmbeddingProvider,
  SyncOptions,
  SyncReport,
} from './types'

// 数据库模块
export { VectorMemoryDB, vectorMemoryDB } from './db'

// 嵌入模块
export {
  EmbeddingProviderManager,
  createEmbeddingProvider,
  type LocalEmbeddingConfig,
  type RemoteEmbeddingConfig,
  type EmbeddingManagerConfig,
} from './embedding'

// 搜索模块
export { HybridSearcher, createHybridSearcher } from './search'

// 同步模块
export { MemorySyncManager, createMemorySyncManager } from './sync'
