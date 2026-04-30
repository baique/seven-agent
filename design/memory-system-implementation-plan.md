# Seven-Agent 记忆系统完整实施方案

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              数据层（JSON - Source of Truth）                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 长期记忆（Long-term Memory）                                                  │
│ ├── context/remember/main.json          # 主记忆文件                          │
│ └── context/remember/fragments/         # 碎片记忆（按日期分片）               │
│     ├── 2024-01-15.json                                                │
│     └── 2024-01-16.json                                                │
│                                                                              │
│ 对话记录（Dialog）                                                            │
│ └── memory/YYYYMMDD/memory.jsonl        # 按日期存储的对话历史                │
│     ├── 2024-01-15/memory.jsonl                                        │
│     └── 2024-01-16/memory.jsonl                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ 同步机制
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           索引层（SQLite - 只读加速）                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ context/memory.db                                                            │
│                                                                              │
│ 表结构：                                                                      │
│ ├── memories                    # 记忆主表                                   │
│ ├── memory_vectors              # 向量表（sqlite-vec）                        │
│ ├── memory_fts                  # 全文搜索表（FTS5）                          │
│ └── sync_state                  # 同步状态表                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、SQLite 表结构设计

### 2.1 memories 表（记忆主表）

```sql
CREATE TABLE IF NOT EXISTS memories (
  -- 主键
  id TEXT PRIMARY KEY,
  
  -- 内容
  content TEXT NOT NULL,
  
  -- 来源类型：'memory' | 'dialog'
  source_type TEXT NOT NULL,
  
  -- 来源标识
  -- memory: event_id (如 remember-xxx)
  -- dialog: message_id (如 msg-xxx)
  source_id TEXT NOT NULL,
  
  -- 来源文件路径（相对路径）
  -- memory: context/remember/main.json 或 fragments/YYYYMMDD.json
  -- dialog: memory/YYYYMMDD/memory.jsonl
  source_file TEXT NOT NULL,
  
  -- 在源文件中的位置（用于定位）
  -- memory: JSON数组索引
  -- dialog: 行号
  source_position INTEGER,
  
  -- 元数据（JSON格式）
  -- memory: { importance, eventType, ... }
  -- dialog: { role, type, ... }
  metadata TEXT,
  
  -- 时间戳
  created_at INTEGER NOT NULL,      -- 创建时间
  updated_at INTEGER,               -- 更新时间（仅memory支持更新）
  
  -- 软删除标记（用于同步检测）
  is_deleted INTEGER DEFAULT 0
);

-- 索引
CREATE INDEX idx_memories_source_type ON memories(source_type);
CREATE INDEX idx_memories_source_file ON memories(source_file);
CREATE INDEX idx_memories_created_at ON memories(created_at);
CREATE INDEX idx_memories_is_deleted ON memories(is_deleted);
```

### 2.2 memory_vectors 表（向量索引）

```sql
-- 使用 sqlite-vec 扩展
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  memory_id TEXT PRIMARY KEY,       -- 关联 memories.id
  embedding FLOAT[768]              -- 向量维度（可配置）
);
```

### 2.3 memory_fts 表（全文索引）

```sql
-- 使用 FTS5 扩展
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,                          -- 索引内容
  content='memories',               -- 关联表
  content_rowid='rowid'             -- 关联字段
);

-- 触发器：自动同步FTS索引
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) 
  VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) 
  VALUES('delete', old.rowid, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

### 2.4 sync_state 表（同步状态追踪）

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  -- 源文件路径（相对路径）
  source_file TEXT PRIMARY KEY,
  
  -- 源类型
  source_type TEXT NOT NULL,
  
  -- 文件哈希（用于检测变更）
  file_hash TEXT,
  
  -- 文件大小
  file_size INTEGER,
  
  -- 文件修改时间
  file_mtime INTEGER,
  
  -- 最后同步时间
  last_sync_at INTEGER,
  
  -- 同步状态：'pending' | 'syncing' | 'synced' | 'failed'
  sync_status TEXT DEFAULT 'pending',
  
  -- 同步失败原因
  sync_error TEXT
);

CREATE INDEX idx_sync_state_status ON sync_state(sync_status);
CREATE INDEX idx_sync_state_type ON sync_state(source_type);
```

---

## 三、同步机制详解

### 3.1 同步触发时机

| 触发场景 | 触发方式 | 优先级 | 说明 |
|---------|---------|--------|------|
| **压缩摘要完成** | 强制同步 | P0 | 必须完成，阻塞后续操作 |
| 记忆变更（增删改） | 异步同步 | P1 | 写入JSON后立即触发 |
| 新消息写入 | 批量异步 | P1 | 每N条或每M秒触发 |
| 启动时 | 全量检查 | P2 | 检查所有文件哈希 |
| 定时任务 | 增量同步 | P2 | 每5分钟检查一次 |

### 3.2 长期记忆同步流程

```typescript
// src/server/memory/sync-manager.ts

interface SyncManager {
  // 强制同步（压缩摘要后调用）
  forceSync(): Promise<void>
  
  // 异步同步（记忆变更后调用）
  asyncSync(sourceFile: string): void
  
  // 批量同步（新消息写入）
  batchSync(dialogFile: string, messages: Message[]): void
}

class MemorySyncManager implements SyncManager {
  private db: VectorMemoryDB
  private embeddingProvider: EmbeddingProvider
  private pendingSyncs = new Map<string, Promise<void>>()  // 防重复同步
  private batchQueue = new Map<string, Message[]>()        // 批量队列
  private batchTimer: NodeJS.Timeout | null = null

  /**
   * 【P0】强制同步 - 压缩摘要后调用
   * 特点：阻塞式，必须完成，失败则重试
   */
  async forceSync(): Promise<void> {
    logger.info('[Sync] 开始强制同步（压缩摘要触发）')
    
    // 1. 同步所有长期记忆文件
    const memoryFiles = await this.listMemoryFiles()
    for (const file of memoryFiles) {
      await this.syncMemoryFile(file, { force: true })
    }
    
    // 2. 同步所有对话文件
    const dialogFiles = await this.listDialogFiles()
    for (const file of dialogFiles) {
      await this.syncDialogFile(file, { force: true })
    }
    
    // 3. 清理已删除的数据
    await this.cleanupDeletedRecords()
    
    logger.info('[Sync] 强制同步完成')
  }

  /**
   * 【P1】异步同步 - 记忆变更后调用
   * 特点：非阻塞，失败可重试，不保证实时性
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
    const syncPromise = this.syncMemoryFile(sourceFile)
      .catch(err => {
        logger.error(`[Sync] 同步失败 ${sourceFile}: ${err}`)
        // 失败后标记状态，定时重试
        this.markSyncFailed(sourceFile, String(err))
      })
      .finally(() => {
        this.pendingSyncs.delete(sourceFile)
      })
    
    this.pendingSyncs.set(sourceFile, syncPromise)
  }

  /**
   * 【P1】批量同步 - 新消息写入
   * 特点：合并多次写入，批量处理，减少IO
   */
  batchSync(dialogFile: string, messages: Message[]): void {
    // 添加到批量队列
    const existing = this.batchQueue.get(dialogFile) || []
    this.batchQueue.set(dialogFile, [...existing, ...messages])
    
    // 重置定时器
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
    }
    
    // 触发条件：队列满N条 或 超时M秒
    const BATCH_SIZE = 10
    const BATCH_TIMEOUT_MS = 5000
    
    const totalMessages = Array.from(this.batchQueue.values())
      .reduce((sum, msgs) => sum + msgs.length, 0)
    
    if (totalMessages >= BATCH_SIZE) {
      this.flushBatchQueue()
    } else {
      this.batchTimer = setTimeout(() => {
        this.flushBatchQueue()
      }, BATCH_TIMEOUT_MS)
    }
  }

  private async flushBatchQueue(): Promise<void> {
    if (this.batchQueue.size === 0) return
    
    const queue = new Map(this.batchQueue)
    this.batchQueue.clear()
    
    for (const [dialogFile, messages] of queue) {
      await this.syncDialogBatch(dialogFile, messages)
    }
  }
}
```

### 3.3 长期记忆文件同步（增删改处理）

```typescript
/**
 * 同步单个长期记忆文件
 * 处理：新增、修改、删除
 */
async function syncMemoryFile(
  filePath: string, 
  options: { force?: boolean } = {}
): Promise<void> {
  const db = vectorMemoryDB.getDatabase()
  
  // 1. 计算文件当前状态
  const fileContent = await fs.readFile(filePath, 'utf-8')
  const fileHash = crypto.createHash('md5').update(fileContent).digest('hex')
  const fileStat = await fs.stat(filePath)
  
  // 2. 检查是否需要同步
  const syncState = db.prepare(
    'SELECT file_hash, file_mtime FROM sync_state WHERE source_file = ?'
  ).get(filePath) as { file_hash: string; file_mtime: number } | undefined
  
  if (!options.force && syncState?.file_hash === fileHash) {
    logger.debug(`[Sync] 文件未变更，跳过: ${filePath}`)
    return
  }
  
  // 3. 解析JSON内容
  const memories: LongTermMemory[] = JSON.parse(fileContent)
  const currentIds = new Set(memories.map(m => m.id))
  
  // 4. 获取SQLite中该文件的现有记录
  const existingRows = db.prepare(
    'SELECT id, source_id, content FROM memories WHERE source_file = ? AND is_deleted = 0'
  ).all(filePath) as Array<{ id: string; source_id: string; content: string }>
  
  const existingIdMap = new Map(existingRows.map(r => [r.source_id, r]))
  
  // 5. 处理变更
  const toInsert: LongTermMemory[] = []
  const toUpdate: Array<{ memory: LongTermMemory; existingId: string }> = []
  const toDelete: string[] = []
  
  for (const memory of memories) {
    const existing = existingIdMap.get(memory.id)
    if (!existing) {
      // 新增
      toInsert.push(memory)
    } else if (existing.content !== memory.description) {
      // 修改（内容变化）
      toUpdate.push({ memory, existingId: existing.id })
    }
    // 标记为已处理
    existingIdMap.delete(memory.id)
  }
  
  // 剩余的就是已删除的
  for (const [sourceId, existing] of existingIdMap) {
    toDelete.push(existing.id)
  }
  
  // 6. 执行数据库操作
  db.exec('BEGIN TRANSACTION')
  
  try {
    // 6.1 插入新记录
    for (const memory of toInsert) {
      const recordId = `mem-${memory.id}`
      const embedding = await embeddingProvider.embed(memory.description)
      
      db.prepare(`
        INSERT INTO memories (id, content, source_type, source_id, source_file, 
                            source_position, metadata, created_at, updated_at)
        VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        memory.description,
        memory.id,
        filePath,
        memories.indexOf(memory),
        JSON.stringify({ importance: memory.importance, eventType: memory.eventType }),
        new Date(memory.createdAt).getTime(),
        memory.updatedAt ? new Date(memory.updatedAt).getTime() : null
      )
      
      // 插入向量
      const vecBlob = Buffer.from(new Float32Array(embedding).buffer)
      db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)')
        .run(recordId, vecBlob)
    }
    
    // 6.2 更新现有记录
    for (const { memory, existingId } of toUpdate) {
      const newEmbedding = await embeddingProvider.embed(memory.description)
      
      db.prepare(`
        UPDATE memories 
        SET content = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        memory.description,
        JSON.stringify({ importance: memory.importance, eventType: memory.eventType }),
        new Date(memory.updatedAt!).getTime(),
        existingId
      )
      
      // 更新向量
      const vecBlob = Buffer.from(new Float32Array(newEmbedding).buffer)
      db.prepare('UPDATE memory_vectors SET embedding = ? WHERE memory_id = ?')
        .run(vecBlob, existingId)
    }
    
    // 6.3 软删除（非物理删除，便于恢复和审计）
    for (const recordId of toDelete) {
      db.prepare('UPDATE memories SET is_deleted = 1 WHERE id = ?').run(recordId)
      // 可选：同时删除向量以节省空间
      // db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(recordId)
    }
    
    // 6.4 更新同步状态
    db.prepare(`
      INSERT INTO sync_state (source_file, source_type, file_hash, file_size, 
                            file_mtime, last_sync_at, sync_status)
      VALUES (?, 'memory', ?, ?, ?, ?, 'synced')
      ON CONFLICT(source_file) DO UPDATE SET
        file_hash = excluded.file_hash,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        last_sync_at = excluded.last_sync_at,
        sync_status = 'synced',
        sync_error = NULL
    `).run(filePath, fileHash, fileStat.size, fileStat.mtimeMs, Date.now())
    
    db.exec('COMMIT')
    
    logger.info(`[Sync] 长期记忆同步完成: ${filePath} ` +
      `(+${toInsert.length} ~${toUpdate.length} -${toDelete.length})`)
      
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
```

### 3.4 对话记录同步（批量追加）

```typescript
/**
 * 同步对话文件（批量追加模式）
 * 特点：只追加，不修改历史记录
 */
async function syncDialogBatch(
  filePath: string, 
  messages: Message[]
): Promise<void> {
  const db = vectorMemoryDB.getDatabase()
  
  // 1. 获取当前已同步的最大行号
  const lastSyncResult = db.prepare(`
    SELECT MAX(source_position) as last_line 
    FROM memories 
    WHERE source_file = ? AND source_type = 'dialog'
  `).get(filePath) as { last_line: number | null }
  
  const startLine = (lastSyncResult?.last_line ?? -1) + 1
  
  // 2. 只处理新消息
  const newMessages = messages.slice(startLine)
  if (newMessages.length === 0) return
  
  // 3. 批量生成嵌入
  const embeddings = await embeddingProvider.embedBatch(
    newMessages.map(m => m.content)
  )
  
  // 4. 批量插入
  db.exec('BEGIN TRANSACTION')
  
  try {
    const insertMemory = db.prepare(`
      INSERT INTO memories (id, content, source_type, source_id, source_file, 
                          source_position, metadata, created_at)
      VALUES (?, ?, 'dialog', ?, ?, ?, ?, ?)
    `)
    
    const insertVector = db.prepare(`
      INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)
    `)
    
    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i]
      const lineNumber = startLine + i
      const recordId = `dlg-${msg.id}`
      
      insertMemory.run(
        recordId,
        msg.content,
        msg.id,
        filePath,
        lineNumber,
        JSON.stringify({ role: msg.type, hasToolCalls: !!msg.tool_calls }),
        msg.timestamp
      )
      
      const vecBlob = Buffer.from(new Float32Array(embeddings[i]).buffer)
      insertVector.run(recordId, vecBlob)
    }
    
    // 5. 更新同步状态
    const fileStat = await fs.stat(filePath)
    const fileHash = await computeFileHash(filePath)
    
    db.prepare(`
      INSERT INTO sync_state (source_file, source_type, file_hash, file_size, 
                            file_mtime, last_sync_at, sync_status)
      VALUES (?, 'dialog', ?, ?, ?, ?, 'synced')
      ON CONFLICT(source_file) DO UPDATE SET
        file_hash = excluded.file_hash,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        last_sync_at = excluded.last_sync_at,
        sync_status = 'synced'
    `).run(filePath, fileHash, fileStat.size, fileStat.mtimeMs, Date.now())
    
    db.exec('COMMIT')
    
    logger.info(`[Sync] 对话记录同步完成: ${filePath} (+${newMessages.length})`)
    
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
```

---

## 四、压缩摘要触发的强制同步

### 4.1 集成点

```typescript
// src/server/core/summary/index.ts

export async function processSessionMessages(messages: BaseMessage[]): Promise<void> {
  // ... 现有摘要逻辑 ...
  
  // 摘要完成后，触发强制同步
  logger.info('[Summary] 摘要完成，触发记忆同步')
  await memorySyncManager.forceSync()
  
  logger.info('[Summary] 记忆同步完成')
}

// src/server/core/summary/extreme.ts

export async function handleExtremeContext(params: ExtremeContextParams): Promise<void> {
  // ... 极限压缩逻辑 ...
  
  // 极限压缩后，强制同步确保索引最新
  logger.info('[Extreme] 极限压缩完成，触发强制同步')
  await memorySyncManager.forceSync()
}
```

### 4.2 同步状态报告

```typescript
interface SyncReport {
  timestamp: number
  duration: number
  memoryFiles: {
    total: number
    synced: number
    failed: number
    details: Array<{
      file: string
      status: 'synced' | 'failed'
      changes: { added: number; updated: number; deleted: number }
      error?: string
    }>
  }
  dialogFiles: {
    total: number
    synced: number
    failed: number
    newMessages: number
  }
}

// 在强制同步后生成报告
async function generateSyncReport(): Promise<SyncReport> {
  const db = vectorMemoryDB.getDatabase()
  
  const memoryStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END) as synced,
      SUM(CASE WHEN sync_status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM sync_state 
    WHERE source_type = 'memory'
  `).get() as { total: number; synced: number; failed: number }
  
  const dialogStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END) as synced
    FROM sync_state 
    WHERE source_type = 'dialog'
  `).get() as { total: number; synced: number }
  
  return {
    timestamp: Date.now(),
    duration: 0, // 由调用方填充
    memoryFiles: {
      total: memoryStats.total,
      synced: memoryStats.synced,
      failed: memoryStats.failed,
      details: []
    },
    dialogFiles: {
      total: dialogStats.total,
      synced: dialogStats.synced,
      failed: 0,
      newMessages: 0
    }
  }
}
```

---

## 五、模糊点澄清总结

### 5.1 什么时候存储到 SQLite？

| 场景 | 触发时机 | 同步方式 | 优先级 |
|------|---------|---------|--------|
| 压缩摘要完成 | `processSessionMessages()` 末尾 | 强制同步（阻塞） | P0 |
| 长期记忆新增/修改/删除 | `jsonMemoryManager` 写操作后 | 异步同步 | P1 |
| 新对话消息 | `appendMessage()` 后 | 批量异步（5秒或10条） | P1 |
| 系统启动 | `MemoryService.initialize()` | 全量检查同步 | P2 |
| 定时任务 | 每5分钟 | 增量同步 | P2 |

### 5.2 长期记忆变更怎么同步？

```
变更检测机制：
1. 文件哈希比对（MD5）
2. 内容级比对（source_id + content）

同步策略：
- 新增：插入 memories + memory_vectors
- 修改：更新 memories.content + 重新生成 embedding
- 删除：软删除（is_deleted = 1），保留审计痕迹

冲突解决：
- 以 JSON 文件为准（Source of Truth）
- SQLite 只读加速层，不反向写入 JSON
```

### 5.3 对话记录同步特点

```
特点：
1. 只追加，不修改历史
2. 批量处理，减少 IO
3. 记录行号，便于定位原文
4. 不删除（对话历史不可修改）

优化：
- 使用 last_sync_line 记录已同步位置
- 每次只同步新增部分
```

---

## 六、实施步骤

### Phase 1: 基础设施（1-2天）
1. 实现 `VectorMemoryDB` 类（数据库初始化、表创建）
2. 实现 `EmbeddingProvider`（本地模型优先）
3. 准备 sqlite-vec 扩展文件（Win/Mac/Linux）

### Phase 2: 同步机制（2-3天）
1. 实现 `MemorySyncManager` 类
2. 实现长期记忆同步（增删改）
3. 实现对话记录批量同步
4. 集成到压缩摘要流程

### Phase 3: 混合检索（2天）
1. 实现 `hybridSearch()` 函数
2. 实现 MMR 多样性重排序
3. 实现时间衰减

### Phase 4: 工具改造（1-2天）
1. 改造 `memory_search` 工具
2. 移除 `memory_deep_search`（功能合并）
3. 更新工具描述和提示词

### Phase 5: 数据迁移（1天）
1. 编写数据迁移脚本
2. 测试迁移过程
3. 验证数据完整性

---

## 七、关键代码文件清单

| 文件 | 说明 |
|------|------|
| `src/server/memory/vector-memory-db.ts` | SQLite数据库管理 |
| `src/server/memory/embedding-provider.ts` | 嵌入提供者（本地+远程） |
| `src/server/memory/sync-manager.ts` | 同步管理器 |
| `src/server/memory/hybrid-search.ts` | 混合检索实现 |
| `src/server/memory/mmr.ts` | MMR多样性算法 |
| `src/server/core/tools/memory-search.ts` | 改造后的记忆搜索工具 |
