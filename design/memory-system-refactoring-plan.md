# Seven-Agent 记忆系统改造方案

## 当前架构分析

### 现有记忆系统组成

```
┌─────────────────────────────────────────────────────────────┐
│ 当前记忆系统架构                                               │
├─────────────────────────────────────────────────────────────┤
│ 1. JSON文件存储（json-memory-manager.ts）                     │
│    - 碎片记忆：context/remember/fragments/YYYYMMDD.json       │
│    - 长期记忆：context/remember/main.json                     │
│    - 按日期分片，无向量索引                                    │
├─────────────────────────────────────────────────────────────┤
│ 2. 对话历史存储（Memory类）                                    │
│    - 按日期存储：memory/YYYYMMDD/memory.jsonl               │
│    - 仅支持关键词匹配搜索                                      │
├─────────────────────────────────────────────────────────────┤
│ 3. 记忆工具                                                  │
│    - memory_search：关键词搜索长期记忆+对话历史                │
│    - memory_deep_search：深度搜索对话历史（时间+关键词）        │
│    - update_memory：增删改记忆                                │
├─────────────────────────────────────────────────────────────┤
│ 4. 记忆注入（memory-injector.ts）                             │
│    - 直接读取JSON文件注入系统提示词                             │
│    - 无向量检索能力                                           │
└─────────────────────────────────────────────────────────────┘
```

### 现有问题

1. **无向量检索**：仅支持关键词匹配，无法语义搜索
2. **无混合检索**：无法结合向量相似度和文本匹配
3. **无多样性优化**：搜索结果可能高度相似
4. **无时间衰减**：新旧记忆同等权重
5. **无本地嵌入**：依赖外部API，成本高、延迟大

---

## 改造目标

集成 OpenClaw 的记忆系统特性：
1. ✅ 数据入库（SQLite + 向量）
2. ✅ 混合检索（向量 + 关键词）
3. ✅ 多样性优化（MMR）
4. ✅ 时间感知（时间衰减）
5. ✅ 本地 + OpenAI协议嵌入（优先本地）

---

## 改造方案

### 阶段一：数据入库方案（SQLite + 向量）

#### 1.1 数据库设计

**新建文件：`src/server/memory/vector-memory-db.ts`**

```typescript
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { paths } from '../../config/env'

// 表结构定义
const SCHEMA = `
-- 记忆主表
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,           -- 记忆内容
  memory_type TEXT NOT NULL,       -- 'fragment' | 'long_term' | 'dialog'
  source_id TEXT,                  -- 来源ID（如消息ID）
  importance REAL DEFAULT 0.5,     -- 重要性 0-1
  created_at INTEGER NOT NULL,     -- 创建时间戳
  updated_at INTEGER,              -- 更新时间戳（仅长期记忆）
  expire_at INTEGER,               -- 过期时间戳（仅碎片记忆）
  metadata TEXT                    -- JSON格式元数据
);

-- 向量表（使用sqlite-vec扩展）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[768]             -- 维度可配置，默认768
);

-- 全文搜索表（FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);

-- 触发器：自动同步FTS索引
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 索引
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
`

export class VectorMemoryDB {
  private db: DatabaseSync | null = null
  private dbPath: string
  private vecExtensionPath: string

  constructor() {
    this.dbPath = path.join(paths.WORKSPACE_ROOT, 'context', 'memory.db')
    this.vecExtensionPath = this.resolveVecExtensionPath()
  }

  async initialize(): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite')
    
    // 打开数据库并加载sqlite-vec扩展
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    
    // 加载向量扩展
    try {
      this.db.loadExtension(this.vecExtensionPath)
    } catch (err) {
      logger.warn(`[VectorMemoryDB] 加载sqlite-vec扩展失败: ${err}，将使用纯FTS搜索`)
    }
    
    // 初始化表结构
    this.db.exec(SCHEMA)
    
    logger.info(`[VectorMemoryDB] 初始化完成: ${this.dbPath}`)
  }

  private resolveVecExtensionPath(): string {
    // 根据平台选择扩展路径
    const platform = process.platform
    const arch = process.arch
    
    const extensionNames: Record<string, string> = {
      'win32': 'vec.dll',
      'darwin': 'vec.dylib',
      'linux': 'vec.so',
    }
    
    const extName = extensionNames[platform] || 'vec.so'
    return path.join(__dirname, '..', '..', '..', 'bin', extName)
  }

  // 插入记忆
  async insertMemory(memory: MemoryRecord, embedding: number[]): Promise<void> {
    if (!this.db) throw new Error('数据库未初始化')
    
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, content, memory_type, source_id, importance, created_at, updated_at, expire_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    stmt.run(
      memory.id,
      memory.content,
      memory.memoryType,
      memory.sourceId,
      memory.importance,
      memory.createdAt,
      memory.updatedAt,
      memory.expireAt,
      JSON.stringify(memory.metadata)
    )
    
    // 插入向量
    const vecBlob = Buffer.from(new Float32Array(embedding).buffer)
    const vecStmt = this.db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)')
    vecStmt.run(memory.id, vecBlob)
  }

  // 获取数据库实例
  getDatabase(): DatabaseSync {
    if (!this.db) throw new Error('数据库未初始化')
    return this.db
  }

  // 关闭连接
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

// 单例实例
export const vectorMemoryDB = new VectorMemoryDB()
```

#### 1.2 数据迁移策略

**新建文件：`src/server/memory/migration.ts`**

```typescript
import { jsonMemoryManager } from './json-memory-manager'
import { vectorMemoryDB } from './vector-memory-db'
import { embeddingProvider } from './embedding-provider'

/**
 * 将现有JSON记忆迁移到SQLite向量数据库
 */
export async function migrateExistingMemories(): Promise<void> {
  logger.info('[Migration] 开始迁移现有记忆数据...')
  
  // 1. 迁移长期记忆
  const longTermMemories = await jsonMemoryManager.getAllLongTermMemories()
  for (const memory of longTermMemories) {
    const embedding = await embeddingProvider.embed(memory.description)
    await vectorMemoryDB.insertMemory({
      id: memory.id,
      content: memory.description,
      memoryType: 'long_term',
      sourceId: memory.eventId,
      importance: memory.importance,
      createdAt: new Date(memory.createdAt).getTime(),
      updatedAt: new Date(memory.updatedAt).getTime(),
      expireAt: null,
      metadata: { originalType: 'long_term' }
    }, embedding)
  }
  
  // 2. 迁移碎片记忆（近N天）
  const retentionDays = configManager.get('FRAGMENT_MEMORY_RETENTION_DAYS')
  const fragmentMemories = await jsonMemoryManager.getRecentFragmentMemories(retentionDays)
  for (const memory of fragmentMemories) {
    // 跳过已过期的
    if (new Date(memory.expireAt) < new Date()) continue
    
    const embedding = await embeddingProvider.embed(memory.description)
    await vectorMemoryDB.insertMemory({
      id: memory.id,
      content: memory.description,
      memoryType: 'fragment',
      sourceId: memory.eventId,
      importance: memory.importance,
      createdAt: new Date(memory.createdAt).getTime(),
      updatedAt: null,
      expireAt: new Date(memory.expireAt).getTime(),
      metadata: { originalType: 'fragment' }
    }, embedding)
  }
  
  // 3. 迁移对话历史（近N天）
  const dialogDays = configManager.get('DIALOG_MEMORY_INDEX_DAYS')
  for (let i = 0; i < dialogDays; i++) {
    const date = new Date()
    date.setDate(date.getDate() - i)
    const dateStr = formatDate(date)
    
    const messages = await loadMessagesByDate(dateStr)
    for (const msg of messages) {
      const content = extractContent(msg)
      if (!content || content.length < 10) continue // 跳过太短的内容
      
      const embedding = await embeddingProvider.embed(content)
      await vectorMemoryDB.insertMemory({
        id: `dialog-${msg.id}`,
        content: content,
        memoryType: 'dialog',
        sourceId: msg.id,
        importance: 0.3, // 对话默认重要性较低
        createdAt: msg.timestamp,
        updatedAt: null,
        expireAt: null,
        metadata: { 
          originalType: 'dialog',
          role: msg.type,
          date: dateStr
        }
      }, embedding)
    }
  }
  
  logger.info('[Migration] 记忆数据迁移完成')
}
```

---

### 阶段二：混合检索集成

#### 2.1 混合搜索实现

**新建文件：`src/server/memory/hybrid-search.ts`**

```typescript
import { vectorMemoryDB } from './vector-memory-db'
import { embeddingProvider } from './embedding-provider'

export interface HybridSearchParams {
  query: string
  maxResults?: number
  minScore?: number
  vectorWeight?: number      // 向量权重（默认0.7）
  textWeight?: number        // 文本权重（默认0.3）
  memoryTypes?: string[]     // 记忆类型过滤
  startTime?: number         // 时间范围开始
  endTime?: number           // 时间范围结束
  mmrEnabled?: boolean       // 是否启用MMR
  mmrLambda?: number         // MMR参数（默认0.7）
  temporalDecayEnabled?: boolean  // 是否启用时间衰减
  temporalHalfLifeDays?: number   // 半衰期天数（默认30）
}

export interface HybridSearchResult {
  id: string
  content: string
  memoryType: string
  importance: number
  createdAt: number
  score: number              // 综合分数
  vectorScore: number        // 向量相似度
  textScore: number          // 文本匹配分数
  snippet: string            // 摘要片段
  metadata?: any
}

export async function hybridSearch(params: HybridSearchParams): Promise<HybridSearchResult[]> {
  const {
    query,
    maxResults = 10,
    minScore = 0.35,
    vectorWeight = 0.7,
    textWeight = 0.3,
    memoryTypes,
    startTime,
    endTime,
    mmrEnabled = false,
    mmrLambda = 0.7,
    temporalDecayEnabled = false,
    temporalHalfLifeDays = 30,
  } = params

  // 1. 并行执行向量搜索和关键词搜索
  const [vectorResults, textResults] = await Promise.all([
    searchVector(query, maxResults * 4, memoryTypes, startTime, endTime),
    searchKeyword(query, maxResults * 4, memoryTypes, startTime, endTime),
  ])

  // 2. 合并结果
  const merged = mergeResults(vectorResults, textResults, vectorWeight, textWeight)

  // 3. 应用时间衰减
  let results = temporalDecayEnabled 
    ? applyTemporalDecay(merged, temporalHalfLifeDays)
    : merged

  // 4. 应用MMR重排序
  if (mmrEnabled) {
    results = applyMMR(results, maxResults, mmrLambda)
  } else {
    results = results.slice(0, maxResults)
  }

  // 5. 过滤低分结果
  return results.filter(r => r.score >= minScore)
}

// 向量搜索（使用sqlite-vec的KNN）
async function searchVector(
  query: string,
  limit: number,
  memoryTypes?: string[],
  startTime?: number,
  endTime?: number
): Promise<Array<{ id: string; score: number }>> {
  const db = vectorMemoryDB.getDatabase()
  const queryVec = await embeddingProvider.embed(query)
  const vecBlob = Buffer.from(new Float32Array(queryVec).buffer)

  // 构建过滤条件
  const filters: string[] = []
  const params: any[] = [vecBlob, vecBlob, limit]
  
  if (memoryTypes?.length) {
    filters.push(`m.memory_type IN (${memoryTypes.map(() => '?').join(',')})`)
    params.push(...memoryTypes)
  }
  if (startTime) {
    filters.push('m.created_at >= ?')
    params.push(startTime)
  }
  if (endTime) {
    filters.push('m.created_at <= ?')
    params.push(endTime)
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  const stmt = db.prepare(`
    SELECT m.id, vec_distance_cosine(v.embedding, ?) as dist
    FROM memory_vectors v
    JOIN memories m ON m.id = v.memory_id
    ${whereClause}
    ORDER BY dist ASC
    LIMIT ?
  `)

  const rows = stmt.all(...params) as Array<{ id: string; dist: number }>
  
  return rows.map(r => ({
    id: r.id,
    score: 1 - r.dist,  // 距离转相似度
  }))
}

// 关键词搜索（使用FTS5）
function searchKeyword(
  query: string,
  limit: number,
  memoryTypes?: string[],
  startTime?: number,
  endTime?: number
): Promise<Array<{ id: string; score: number }>> {
  const db = vectorMemoryDB.getDatabase()
  
  // 构建FTS5查询
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) || []
  const matchQuery = tokens.map(t => `"${t.replaceAll('"', '')}"`).join(' AND ')

  // 构建过滤条件
  const filters: string[] = []
  const params: any[] = [matchQuery, limit]
  
  if (memoryTypes?.length) {
    filters.push(`m.memory_type IN (${memoryTypes.map(() => '?').join(',')})`)
    params.splice(1, 0, ...memoryTypes)
  }
  if (startTime) {
    filters.push('m.created_at >= ?')
    params.push(startTime)
  }
  if (endTime) {
    filters.push('m.created_at <= ?')
    params.push(endTime)
  }

  const whereClause = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const stmt = db.prepare(`
    SELECT m.id, bm25(memory_fts) as rank
    FROM memory_fts
    JOIN memories m ON m.rowid = memory_fts.rowid
    WHERE memory_fts MATCH ? ${whereClause}
    ORDER BY rank ASC
    LIMIT ?
  `)

  const rows = stmt.all(...params) as Array<{ id: string; rank: number }>
  
  return Promise.resolve(rows.map(r => ({
    id: r.id,
    score: bm25RankToScore(r.rank),
  })))
}

// BM25排名转分数
function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0.001
  if (rank < 0) {
    const relevance = -rank
    return relevance / (1 + relevance)
  }
  return 1 / (1 + rank)
}

// 合并结果
function mergeResults(
  vectorResults: Array<{ id: string; score: number }>,
  textResults: Array<{ id: string; score: number }>,
  vectorWeight: number,
  textWeight: number
): HybridSearchResult[] {
  const byId = new Map<string, { vectorScore: number; textScore: number }>()

  // 添加向量结果
  for (const r of vectorResults) {
    byId.set(r.id, { vectorScore: r.score, textScore: 0 })
  }

  // 合并关键词结果
  for (const r of textResults) {
    const existing = byId.get(r.id)
    if (existing) {
      existing.textScore = r.score
    } else {
      byId.set(r.id, { vectorScore: 0, textScore: r.score })
    }
  }

  // 获取完整记忆数据
  const db = vectorMemoryDB.getDatabase()
  const results: HybridSearchResult[] = []

  for (const [id, scores] of byId) {
    const stmt = db.prepare('SELECT * FROM memories WHERE id = ?')
    const row = stmt.get(id) as any
    
    if (row) {
      const score = vectorWeight * scores.vectorScore + textWeight * scores.textScore
      results.push({
        id: row.id,
        content: row.content,
        memoryType: row.memory_type,
        importance: row.importance,
        createdAt: row.created_at,
        score,
        vectorScore: scores.vectorScore,
        textScore: scores.textScore,
        snippet: truncateUtf16Safe(row.content, 300),
        metadata: JSON.parse(row.metadata || '{}'),
      })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}
```

---

### 阶段三：多样性优化（MMR）

#### 3.1 MMR实现

**在 `hybrid-search.ts` 中添加：**

```typescript
// MMR (Maximal Marginal Relevance) 实现
function applyMMR(
  results: HybridSearchResult[],
  maxResults: number,
  lambda: number
): HybridSearchResult[] {
  if (results.length <= 1) return results

  const selected: HybridSearchResult[] = []
  const remaining = [...results]

  while (remaining.length > 0 && selected.length < maxResults) {
    let bestMMRScore = -Infinity
    let bestIndex = 0

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      
      // 相关性部分
      const relevance = candidate.score
      
      // 多样性部分：与已选结果的最大相似度
      let maxSimToSelected = 0
      for (const sel of selected) {
        const sim = calculateSimilarity(candidate, sel)
        maxSimToSelected = Math.max(maxSimToSelected, sim)
      }

      // MMR = λ * Relevance - (1-λ) * max(Similarity)
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected

      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore
        bestIndex = i
      }
    }

    selected.push(remaining[bestIndex])
    remaining.splice(bestIndex, 1)
  }

  return selected
}

// 计算两个记忆之间的相似度（基于向量）
async function calculateSimilarity(
  a: HybridSearchResult,
  b: HybridSearchResult
): Promise<number> {
  // 如果已有向量分数，直接使用
  if (a.vectorScore && b.vectorScore) {
    // 从数据库获取原始向量计算余弦相似度
    const db = vectorMemoryDB.getDatabase()
    
    const getVec = (id: string) => {
      const stmt = db.prepare('SELECT embedding FROM memory_vectors WHERE memory_id = ?')
      const row = stmt.get(id) as { embedding: Buffer } | undefined
      return row ? Array.from(new Float32Array(row.embedding.buffer)) : null
    }

    const vecA = getVec(a.id)
    const vecB = getVec(b.id)

    if (vecA && vecB) {
      return cosineSimilarity(vecA, vecB)
    }
  }

  // 回退：基于文本的简单相似度
  return jaccardSimilarity(a.content, b.content)
}

// 余弦相似度
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Jaccard相似度（文本回退）
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/))
  const setB = new Set(b.toLowerCase().split(/\s+/))
  
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  
  return intersection.size / union.size
}
```

---

### 阶段四：时间感知（时间衰减）

#### 4.1 时间衰减实现

**在 `hybrid-search.ts` 中添加：**

```typescript
// 应用时间衰减
function applyTemporalDecay(
  results: HybridSearchResult[],
  halfLifeDays: number
): HybridSearchResult[] {
  const now = Date.now()
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000

  return results.map(r => {
    const age = now - r.createdAt
    const decayFactor = Math.pow(0.5, age / halfLifeMs)
    
    return {
      ...r,
      score: r.score * decayFactor,
      // 保留原始分数用于调试
      originalScore: r.score,
    }
  }).sort((a, b) => b.score - a.score)
}
```

---

### 阶段五：嵌入提供者（本地+OpenAI协议）

#### 5.1 嵌入提供者设计

**新建文件：`src/server/memory/embedding-provider.ts`**

```typescript
import { configManager } from '../../config/env'

export interface EmbeddingProvider {
  id: string
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

// 本地嵌入模型（使用llama.cpp或类似）
class LocalEmbeddingProvider implements EmbeddingProvider {
  id = 'local'
  private model: any = null
  private modelPath: string
  private dimensions: number

  constructor(modelPath?: string, dimensions = 768) {
    this.modelPath = modelPath || this.getDefaultModelPath()
    this.dimensions = dimensions
  }

  private getDefaultModelPath(): string {
    // 默认使用 nomic-embed-text
    return path.join(process.env.HOME || '', '.models', 'nomic-embed-text-v1.5.f32.gguf')
  }

  async initialize(): Promise<void> {
    // 使用 node-llama-cpp 或类似的本地推理库
    const { LlamaModel } = await import('node-llama-cpp')
    this.model = new LlamaModel({
      modelPath: this.modelPath,
    })
    logger.info(`[LocalEmbeddingProvider] 本地模型加载完成: ${this.modelPath}`)
  }

  async embed(text: string): Promise<number[]> {
    if (!this.model) await this.initialize()
    
    const embedding = await this.model.createEmbedding({
      input: text,
    })
    
    return embedding.vector
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.model) await this.initialize()
    
    // 批量处理
    const results: number[][] = []
    for (const text of texts) {
      results.push(await this.embed(text))
    }
    return results
  }
}

// OpenAI协议兼容的远程提供者
class OpenAICompatibleProvider implements EmbeddingProvider {
  id: string
  private apiKey: string
  private baseUrl: string
  private model: string
  private dimensions: number

  constructor(config: {
    apiKey: string
    baseUrl?: string
    model?: string
    dimensions?: number
  }) {
    this.id = 'openai-compatible'
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1'
    this.model = config.model || 'text-embedding-3-small'
    this.dimensions = config.dimensions || 1536
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
        dimensions: this.dimensions,
      }),
    })

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.data[0].embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        dimensions: this.dimensions,
      }),
    })

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    return data.data.map((d: any) => d.embedding)
  }
}

// 嵌入提供者管理器
class EmbeddingProviderManager {
  private provider: EmbeddingProvider | null = null
  private config: any = null

  async initialize(): Promise<void> {
    this.config = configManager.get('EMBEDDING_PROVIDER')
    
    // 优先尝试本地模型
    if (this.config?.local?.enabled !== false) {
      try {
        const localProvider = new LocalEmbeddingProvider(
          this.config?.local?.modelPath,
          this.config?.local?.dimensions
        )
        await localProvider.initialize()
        this.provider = localProvider
        logger.info('[EmbeddingProviderManager] 使用本地嵌入模型')
        return
      } catch (err) {
        logger.warn(`[EmbeddingProviderManager] 本地模型加载失败: ${err}，尝试远程提供者`)
      }
    }

    // 回退到远程提供者
    if (this.config?.remote?.apiKey) {
      this.provider = new OpenAICompatibleProvider({
        apiKey: this.config.remote.apiKey,
        baseUrl: this.config.remote.baseUrl,
        model: this.config.remote.model,
        dimensions: this.config.remote.dimensions,
      })
      logger.info('[EmbeddingProviderManager] 使用远程嵌入API')
      return
    }

    throw new Error('没有可用的嵌入提供者')
  }

  async embed(text: string): Promise<number[]> {
    if (!this.provider) await this.initialize()
    return this.provider!.embed(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.provider) await this.initialize()
    return this.provider!.embedBatch(texts)
  }

  getProviderId(): string {
    return this.provider?.id || 'unknown'
  }
}

// 单例
export const embeddingProvider = new EmbeddingProviderManager()
```

---

### 阶段六：工具改造

#### 6.1 改造 memory_search 工具

**修改：`src/server/core/tools/memory-search.ts`**

```typescript
import { hybridSearch } from '../../memory/hybrid-search'

export const searchMemoryTool = new DynamicStructuredTool({
  name: 'memory_search',
  description: `搜索已记录的重要信息（支持语义搜索）。
**使用建议：**
- 支持自然语言描述，不仅限于关键词
- 使用具体的问题或描述，获得更准确的语义匹配
- 可以结合时间范围缩小搜索范围
- 每次调用最多返回 50 条结果
- 注意：任务请使用 query_tasks 工具查询，不在记忆中存储
`,
  schema: z.object({
    query: z.string().describe('搜索查询，支持自然语言描述'),
    maxResults: z.number().min(1).max(50).default(10).describe('最大返回结果数'),
    minScore: z.number().min(0).max(1).default(0.35).describe('最小相关度分数'),
    memoryTypes: z.array(z.enum(['long_term', 'fragment', 'dialog']))
      .optional()
      .describe('记忆类型过滤'),
    startTime: z.string().optional().describe('开始时间（ISO格式）'),
    endTime: z.string().optional().describe('结束时间（ISO格式）'),
    useMMR: z.boolean().default(true).describe('是否启用多样性优化'),
    temporalDecay: z.boolean().default(true).describe('是否优先近期记忆'),
  }),
  func: async (input) => {
    const toolName = 'memory_search'
    try {
      const results = await hybridSearch({
        query: input.query,
        maxResults: input.maxResults,
        minScore: input.minScore,
        memoryTypes: input.memoryTypes,
        startTime: input.startTime ? new Date(input.startTime).getTime() : undefined,
        endTime: input.endTime ? new Date(input.endTime).getTime() : undefined,
        mmrEnabled: input.useMMR,
        temporalDecayEnabled: input.temporalDecay,
      })

      if (results.length === 0) {
        return await ToolResult.success(toolName, {
          msg: '未找到相关记忆',
          extra: { query: input.query },
        })
      }

      // 格式化输出
      const outputParts: string[] = []
      outputParts.push(`# 搜索结果（共 ${results.length} 条）`)
      
      for (const r of results) {
        const typeLabel = r.memoryType === 'long_term' ? '长期记忆' 
                        : r.memoryType === 'fragment' ? '碎片记忆' 
                        : '对话记录'
        
        outputParts.push(`
[${typeLabel}] 相关度: ${(r.score * 100).toFixed(1)}%
内容: ${r.snippet}
时间: ${new Date(r.createdAt).toLocaleString('zh-CN')}
ID: ${r.id}
        `.trim())
      }

      return await ToolResult.success(toolName, {
        msg: `找到 ${results.length} 条相关记忆`,
        body: outputParts.join('\n\n'),
        extra: {
          query: input.query,
          resultCount: results.length,
          provider: embeddingProvider.getProviderId(),
        },
      })
    } catch (error) {
      logger.error(`[MemorySearch] 搜索失败: ${error}`)
      return await ToolResult.error(toolName, {
        msg: '搜索失败',
        body: String(error),
      })
    }
  },
})
```

---

## 改造收益分析

| 特性 | 当前系统 | 改造后 | 收益 |
|------|---------|--------|------|
| **语义搜索** | ❌ 仅关键词 | ✅ 向量+关键词 | 理解用户意图，提高召回率 |
| **混合检索** | ❌ 无 | ✅ 加权融合 | 兼顾精确匹配和语义相似 |
| **多样性** | ❌ 无 | ✅ MMR | 避免结果高度相似 |
| **时间感知** | ❌ 无 | ✅ 指数衰减 | 优先近期记忆 |
| **本地嵌入** | ❌ 无 | ✅ 本地优先 | 降低成本，减少延迟 |
| **存储效率** | JSON文件 | SQLite+向量 | 更快的检索速度 |

---

## 实施计划

### 第一阶段（1-2天）：基础架构
1. 实现 `vector-memory-db.ts` - SQLite + sqlite-vec
2. 实现 `embedding-provider.ts` - 本地+远程提供者
3. 编写数据迁移脚本

### 第二阶段（2-3天）：核心功能
1. 实现 `hybrid-search.ts` - 混合检索
2. 实现 MMR 多样性优化
3. 实现时间衰减

### 第三阶段（1-2天）：工具改造
1. 改造 `memory_search` 工具
2. 保持 `memory_deep_search` 和 `update_memory` 兼容
3. 更新 `memory-injector.ts` 支持向量检索

### 第四阶段（1天）：测试与优化
1. 数据迁移测试
2. 检索质量评估
3. 性能调优

---

## 配置项

**新增配置（`config/env.ts`）：**

```typescript
EMBEDDING_PROVIDER: {
  local: {
    enabled: true,
    modelPath: '',  // 空则使用默认路径
    dimensions: 768,
  },
  remote: {
    enabled: false,
    apiKey: '',
    baseUrl: '',  // 空则使用OpenAI官方
    model: 'text-embedding-3-small',
    dimensions: 1536,
  }
},
MEMORY_SEARCH: {
  defaultMaxResults: 10,
  defaultMinScore: 0.35,
  vectorWeight: 0.7,
  textWeight: 0.3,
  mmrEnabled: true,
  mmrLambda: 0.7,
  temporalDecayEnabled: true,
  temporalHalfLifeDays: 30,
},
DIALOG_MEMORY_INDEX_DAYS: 7,  // 索引近7天对话
```

---

## 风险提示

1. **sqlite-vec 扩展依赖**：需要为不同平台编译/提供扩展文件
2. **本地模型资源占用**：本地嵌入模型需要一定的内存和CPU资源
3. **数据迁移风险**：迁移前建议备份现有JSON记忆文件
4. **向量维度一致性**：切换嵌入模型时需要重新索引所有数据
