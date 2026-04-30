/**
 * VectorMemoryDB - SQLite + sqlite-vec 向量数据库管理
 * 职责：数据库连接管理、表结构维护、基础CRUD操作
 * 设计原则：最小侵入，独立模块，可测试
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { paths } from '../../config/env'
import type { MemoryRecord, SyncStateRecord, MemorySourceType } from './types'
import * as sqliteVec from 'sqlite-vec'

type DatabaseType = InstanceType<typeof Database>

// SQL 语句常量
const SQL_CREATE_TABLES = `
-- 记忆主表
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_position INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  is_deleted INTEGER DEFAULT 0
);

-- 同步状态表
CREATE TABLE IF NOT EXISTS sync_state (
  source_file TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  file_hash TEXT,
  file_size INTEGER,
  file_mtime INTEGER,
  last_sync_at INTEGER,
  sync_status TEXT DEFAULT 'pending',
  sync_error TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_memories_source_type ON memories(source_type);
CREATE INDEX IF NOT EXISTS idx_memories_source_file ON memories(source_file);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
CREATE INDEX IF NOT EXISTS idx_sync_state_status ON sync_state(sync_status);
CREATE INDEX IF NOT EXISTS idx_sync_state_type ON sync_state(source_type);
`;

const SQL_CREATE_FTS_TABLE = `
-- FTS5 全文搜索表
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);
`;

const SQL_CREATE_FTS_TRIGGERS = `
-- FTS 同步触发器
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
`;

const SQL_CREATE_VECTOR_TABLE = (dimensions: number) => `
-- 向量表（使用 sqlite-vec 扩展）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[${dimensions}]
);
`;

/**
 * VectorMemoryDB 类
 * 管理 SQLite 数据库连接和基础操作
 */
export class VectorMemoryDB {
  private db: DatabaseType | null = null
  private dbPath: string
  private vectorEnabled = false
  private vectorDimensions = 768
  private initialized = false

  constructor(dbPath?: string) {
    // 数据库存储在工作区目录，或使用指定的路径
    this.dbPath = dbPath || path.join(paths.WORKSPACE_ROOT, 'memory.db')
  }

  /**
   * 初始化数据库
   * @param options 初始化选项
   * @param options.vectorDimensions 向量维度（默认768）
   */
  async initialize(options: {
    vectorDimensions?: number
  } = {}): Promise<void> {
    if (this.initialized) {
      return
    }

    this.vectorDimensions = options.vectorDimensions || 768

    // 确保目录存在
    const dbDir = path.dirname(this.dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    // 打开数据库
    this.db = new Database(this.dbPath)

    // 设置 busy timeout
    this.db.pragma('journal_mode = WAL')

    // 尝试加载向量扩展
    await this.tryLoadVectorExtension()

    // 创建表结构
    this.createTables()

    this.initialized = true
    console.log(`[VectorMemoryDB] 初始化完成: ${this.dbPath}, 向量支持: ${this.vectorEnabled}`)
  }

  /**
   * 尝试加载 sqlite-vec 扩展
   * 使用 sqlite-vec npm 包自动加载对应平台的扩展
   */
  private async tryLoadVectorExtension(): Promise<void> {
    try {
      // 使用 sqlite-vec 包的 load 方法自动加载扩展
      sqliteVec.load(this.db!)
      this.vectorEnabled = true
      console.log('[VectorMemoryDB] 成功加载 sqlite-vec 扩展')
    } catch (err) {
      console.warn(`[VectorMemoryDB] 加载 sqlite-vec 扩展失败: ${err}，将使用纯FTS搜索`)
      this.vectorEnabled = false
    }
  }

  /**
   * 创建表结构
   */
  private createTables(): void {
    if (!this.db) throw new Error('数据库未初始化')

    // 创建基础表
    this.db.exec(SQL_CREATE_TABLES)
    
    // 创建FTS表
    this.db.exec(SQL_CREATE_FTS_TABLE)
    this.db.exec(SQL_CREATE_FTS_TRIGGERS)
    
    // 创建向量表（如果支持）
    if (this.vectorEnabled) {
      this.db.exec(SQL_CREATE_VECTOR_TABLE(this.vectorDimensions))
    }
  }

  /**
   * 检查是否支持向量搜索
   */
  isVectorEnabled(): boolean {
    return this.vectorEnabled
  }

  /**
   * 获取数据库实例
   */
  getDatabase(): DatabaseType {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }
    return this.db
  }

  /**
   * 获取数据库路径
   */
  getDbPath(): string {
    return this.dbPath
  }

  /**
   * 插入记忆记录
   */
  insertMemory(record: MemoryRecord): void {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare(`
      INSERT INTO memories 
      (id, content, source_type, source_id, source_file, source_position, metadata, created_at, updated_at, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      record.id,
      record.content,
      record.sourceType,
      record.sourceId,
      record.sourceFile,
      record.sourcePosition,
      record.metadata,
      record.createdAt,
      record.updatedAt,
      record.isDeleted
    )
  }

  /**
   * 插入向量
   */
  insertVector(memoryId: string, embedding: number[]): void {
    if (!this.db) throw new Error('数据库未初始化')
    if (!this.vectorEnabled) throw new Error('向量功能未启用')

    const vecBlob = Buffer.from(new Float32Array(embedding).buffer)
    const stmt = this.db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)')
    stmt.run(memoryId, vecBlob)
  }

  /**
   * 更新记忆内容
   */
  updateMemory(id: string, content: string, metadata: string, updatedAt: number): void {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare(`
      UPDATE memories 
      SET content = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `)
    stmt.run(content, metadata, updatedAt, id)
  }

  /**
   * 更新向量
   */
  updateVector(memoryId: string, embedding: number[]): void {
    if (!this.db) throw new Error('数据库未初始化')
    if (!this.vectorEnabled) throw new Error('向量功能未启用')

    const vecBlob = Buffer.from(new Float32Array(embedding).buffer)
    const stmt = this.db.prepare('UPDATE memory_vectors SET embedding = ? WHERE memory_id = ?')
    stmt.run(vecBlob, memoryId)
  }

  /**
   * 软删除记忆
   */
  softDeleteMemory(id: string): void {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare('UPDATE memories SET is_deleted = 1 WHERE id = ?')
    stmt.run(id)
  }

  /**
   * 物理删除记忆（包括向量）
   */
  deleteMemory(id: string): void {
    if (!this.db) throw new Error('数据库未初始化')

    // 删除主表记录（触发器会自动清理FTS）
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?')
    stmt.run(id)

    // 删除向量
    if (this.vectorEnabled) {
      const vecStmt = this.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?')
      vecStmt.run(id)
    }
  }

  /**
   * 根据ID查询记忆
   */
  getMemoryById(id: string): MemoryRecord | null {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ? AND is_deleted = 0')
    const row = stmt.get(id) as any
    
    if (!row) return null
    
    return this.rowToMemoryRecord(row)
  }

  /**
   * 根据来源文件获取所有记忆
   */
  getMemoriesBySourceFile(sourceFile: string): MemoryRecord[] {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare(
      'SELECT * FROM memories WHERE source_file = ? AND is_deleted = 0 ORDER BY source_position'
    )
    const rows = stmt.all(sourceFile) as any[]
    
    return rows.map(row => this.rowToMemoryRecord(row))
  }

  /**
   * 获取同步状态
   */
  getSyncState(sourceFile: string): SyncStateRecord | null {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE source_file = ?')
    const row = stmt.get(sourceFile) as any
    
    if (!row) return null
    
    return {
      sourceFile: row.source_file,
      sourceType: row.source_type,
      fileHash: row.file_hash,
      fileSize: row.file_size,
      fileMtime: row.file_mtime,
      lastSyncAt: row.last_sync_at,
      syncStatus: row.sync_status,
      syncError: row.sync_error,
    }
  }

  /**
   * 更新或插入同步状态
   */
  upsertSyncState(state: SyncStateRecord): void {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare(`
      INSERT INTO sync_state 
      (source_file, source_type, file_hash, file_size, file_mtime, last_sync_at, sync_status, sync_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_file) DO UPDATE SET
        source_type = excluded.source_type,
        file_hash = excluded.file_hash,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        last_sync_at = excluded.last_sync_at,
        sync_status = excluded.sync_status,
        sync_error = excluded.sync_error
    `)

    stmt.run(
      state.sourceFile,
      state.sourceType,
      state.fileHash,
      state.fileSize,
      state.fileMtime,
      state.lastSyncAt,
      state.syncStatus,
      state.syncError
    )
  }

  /**
   * 获取所有待同步的文件
   */
  getPendingSyncFiles(): string[] {
    if (!this.db) throw new Error('数据库未初始化')

    const stmt = this.db.prepare(
      "SELECT source_file FROM sync_state WHERE sync_status IN ('pending', 'failed')"
    )
    const rows = stmt.all() as Array<{ source_file: string }>
    
    return rows.map(r => r.source_file)
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalMemories: number
    memoryCount: number
    dialogCount: number
    vectorCount: number
    syncPending: number
    syncFailed: number
  } {
    if (!this.db) throw new Error('数据库未初始化')

    const totalStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM memories WHERE is_deleted = 0'
    )
    const memoryStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE source_type = 'memory' AND is_deleted = 0"
    )
    const dialogStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE source_type = 'dialog' AND is_deleted = 0"
    )
    let vectorCount = 0
    if (this.vectorEnabled) {
      try {
        const vectorStmt = this.db.prepare('SELECT COUNT(*) as count FROM memory_vectors')
        vectorCount = (vectorStmt.get() as any).count
      } catch (e) {
        // 向量表可能不存在
        vectorCount = 0
      }
    }
    const pendingStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM sync_state WHERE sync_status = 'pending'"
    )
    const failedStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM sync_state WHERE sync_status = 'failed'"
    )

    return {
      totalMemories: (totalStmt.get() as any).count,
      memoryCount: (memoryStmt.get() as any).count,
      dialogCount: (dialogStmt.get() as any).count,
      vectorCount,
      syncPending: (pendingStmt.get() as any).count,
      syncFailed: (failedStmt.get() as any).count,
    }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.initialized = false
      console.log('[VectorMemoryDB] 数据库连接已关闭')
    }
  }

  /**
   * 行数据转 MemoryRecord
   */
  private rowToMemoryRecord(row: any): MemoryRecord {
    return {
      id: row.id,
      content: row.content,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceFile: row.source_file,
      sourcePosition: row.source_position,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isDeleted: row.is_deleted,
    }
  }
}

// 单例实例
export const vectorMemoryDB = new VectorMemoryDB()
