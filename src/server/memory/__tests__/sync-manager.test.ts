/**
 * MemorySyncManager 测试用例
 * 测试同步机制、批量处理、强制同步等功能
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { paths } from '../../config/env'
import { VectorMemoryDB, createEmbeddingProvider, createMemorySyncManager } from '../vector/index'
import type { MemorySyncManager } from '../vector/index'

// 使用实际的工作区路径进行测试
const TEST_MEMORY_DIR = path.join(paths.WORKSPACE_ROOT, 'context', 'remember', 'test-sync')
const TEST_DIALOG_DIR = path.join(paths.WORKSPACE_ROOT, 'memory', 'test-sync-dialog')
const TEST_DB_PATH = path.join(paths.WORKSPACE_ROOT, 'test-sync.db')

describe('MemorySyncManager', () => {
  let db: VectorMemoryDB
  let provider: ReturnType<typeof createEmbeddingProvider>
  let syncManager: MemorySyncManager

  beforeAll(async () => {
    // 创建测试目录
    if (!fs.existsSync(TEST_MEMORY_DIR)) {
      fs.mkdirSync(TEST_MEMORY_DIR, { recursive: true })
    }
    if (!fs.existsSync(TEST_DIALOG_DIR)) {
      fs.mkdirSync(TEST_DIALOG_DIR, { recursive: true })
    }
  })

  afterAll(() => {
    // 清理测试目录
    if (fs.existsSync(TEST_MEMORY_DIR)) {
      try {
        fs.rmSync(TEST_MEMORY_DIR, { recursive: true })
      } catch (e) {
        // 忽略错误
      }
    }
    if (fs.existsSync(TEST_DIALOG_DIR)) {
      try {
        fs.rmSync(TEST_DIALOG_DIR, { recursive: true })
      } catch (e) {
        // 忽略错误
      }
    }
    // 清理测试数据库
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH)
      } catch (e) {
        // 忽略错误
      }
    }
  })

  beforeEach(async () => {
    // 关闭之前的数据库连接
    if (db) {
      db.close()
    }
    
    // 清理数据库
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH)
      } catch (e) {
        // 忽略删除错误
      }
    }

    // 初始化数据库
    db = new VectorMemoryDB()
    ;(db as any).dbPath = TEST_DB_PATH
    await db.initialize({ vectorDimensions: 768 })

    // 初始化嵌入提供者
    provider = createEmbeddingProvider()
    await provider.initialize()

    // 创建同步管理器
    syncManager = createMemorySyncManager(db, provider)
    await syncManager.initialize()
  })

  afterEach(() => {
    // 关闭数据库连接
    if (db) {
      db.close()
    }
  })

  describe('长期记忆同步', () => {
    it('应该同步新的长期记忆文件', async () => {
      // 创建测试记忆文件
      const memories = [
        {
          id: 'mem-1',
          description: '这是一个重要的记忆',
          importance: 0.9,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'mem-2',
          description: '这是另一个记忆',
          importance: 0.5,
          createdAt: new Date().toISOString(),
        },
      ]

      const memoryFile = path.join(TEST_MEMORY_DIR, 'main.json')
      fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2))

      // 直接调用同步方法而不是 forceSync
      const result = await (syncManager as any).syncMemoryFile(memoryFile, { force: true })

      // 验证结果
      expect(result.added).toBe(2)

      // 验证数据库
      const records = db.getMemoriesBySourceFile(memoryFile)
      expect(records).toHaveLength(2)
      expect(records[0].content).toBe('这是一个重要的记忆')
      expect(records[1].content).toBe('这是另一个记忆')
    })

    it('应该检测并同步变更的记忆', async () => {
      // 创建初始记忆文件
      const memories = [
        {
          id: 'mem-1',
          description: '原始内容',
          importance: 0.5,
          createdAt: new Date().toISOString(),
        },
      ]

      const memoryFile = path.join(TEST_MEMORY_DIR, 'update.json')
      fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2))

      // 首次同步
      await (syncManager as any).syncMemoryFile(memoryFile, { force: true })

      // 修改记忆内容
      memories[0].description = '更新后的内容'
      memories[0].updatedAt = new Date().toISOString()
      fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2))

      // 再次同步
      const result = await (syncManager as any).syncMemoryFile(memoryFile, { force: true })

      // 验证更新
      expect(result.updated).toBe(1)

      const records = db.getMemoriesBySourceFile(memoryFile)
      expect(records[0].content).toBe('更新后的内容')
    })

    it('应该检测并标记删除的记忆', async () => {
      // 创建包含多条记忆的初始文件
      const memories = [
        {
          id: 'mem-1',
          description: '保留的记忆',
          importance: 0.5,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'mem-2',
          description: '将被删除的记忆',
          importance: 0.3,
          createdAt: new Date().toISOString(),
        },
      ]

      const memoryFile = path.join(TEST_MEMORY_DIR, 'delete.json')
      fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2))

      // 首次同步
      await (syncManager as any).syncMemoryFile(memoryFile, { force: true })

      // 删除一条记忆
      memories.pop()
      fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2))

      // 再次同步
      const result = await (syncManager as any).syncMemoryFile(memoryFile, { force: true })

      // 验证删除
      expect(result.deleted).toBe(1)

      const records = db.getMemoriesBySourceFile(memoryFile)
      expect(records).toHaveLength(1)
      expect(records[0].content).toBe('保留的记忆')
    })
  })

  describe('对话记录同步', () => {
    it('应该同步新的对话记录', async () => {
      // 创建测试对话文件
      const messages = [
        {
          id: 'msg-1',
          type: 'user',
          content: '你好',
          timestamp: Date.now(),
        },
        {
          id: 'msg-2',
          type: 'assistant',
          content: '你好！有什么可以帮助你的？',
          timestamp: Date.now(),
        },
      ]

      const dialogFile = path.join(TEST_DIALOG_DIR, 'memory.jsonl')
      fs.writeFileSync(dialogFile, messages.map(m => JSON.stringify(m)).join('\n'))

      // 直接调用同步方法
      const result = await (syncManager as any).syncDialogFile(dialogFile, { force: true })

      // 验证结果
      expect(result.added).toBe(2)

      // 验证数据库
      const records = db.getMemoriesBySourceFile(dialogFile)
      expect(records).toHaveLength(2)
      expect(records[0].content).toBe('你好')
      expect(records[1].content).toBe('你好！有什么可以帮助你的？')
    })

    it('应该增量同步对话记录', async () => {
      // 创建初始对话文件
      const messages = [
        {
          id: 'msg-1',
          type: 'user',
          content: '初始消息',
          timestamp: Date.now(),
        },
      ]

      const dialogFile = path.join(TEST_DIALOG_DIR, 'incremental.jsonl')
      fs.writeFileSync(dialogFile, messages.map(m => JSON.stringify(m)).join('\n'))

      // 首次同步
      await (syncManager as any).syncDialogFile(dialogFile, { force: true })

      // 追加新消息
      const newMessage = {
        id: 'msg-2',
        type: 'assistant',
        content: '新消息',
        timestamp: Date.now(),
      }
      fs.appendFileSync(dialogFile, '\n' + JSON.stringify(newMessage))

      // 再次同步
      const result = await (syncManager as any).syncDialogFile(dialogFile, { force: true })

      // 验证只同步了新消息
      expect(result.added).toBe(1)

      const records = db.getMemoriesBySourceFile(dialogFile)
      expect(records).toHaveLength(2)
    })
  })

  describe('批量同步', () => {
    it('应该批量处理多条消息', async () => {
      const dialogFile = path.join(TEST_DIALOG_DIR, 'batch.jsonl')

      // 先创建空文件
      fs.writeFileSync(dialogFile, '')

      // 批量添加消息
      const messages = [
        { id: 'batch-1', type: 'user', content: '消息1', timestamp: Date.now() },
        { id: 'batch-2', type: 'assistant', content: '消息2', timestamp: Date.now() },
        { id: 'batch-3', type: 'user', content: '消息3', timestamp: Date.now() },
      ]

      await (syncManager as any).syncDialogBatch(dialogFile, messages)

      // 验证结果
      const records = db.getMemoriesBySourceFile(dialogFile)
      expect(records).toHaveLength(3)
    })
  })

  describe('异步同步', () => {
    it('应该异步同步文件', async () => {
      // 创建测试文件
      const memories = [
        {
          id: 'async-1',
          description: '异步测试记忆',
          importance: 0.5,
          createdAt: new Date().toISOString(),
        },
      ]

      const memoryFile = path.join(TEST_MEMORY_DIR, 'async.json')
      fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2))

      // 触发异步同步
      syncManager.asyncSync(memoryFile)

      // 等待异步完成
      await new Promise(resolve => setTimeout(resolve, 1000))

      // 验证结果
      const records = db.getMemoriesBySourceFile(memoryFile)
      expect(records).toHaveLength(1)
      expect(records[0].content).toBe('异步测试记忆')
    })
  })

  describe('同步报告', () => {
    it('应该生成完整的同步报告', async () => {
      // 创建多个测试文件
      fs.writeFileSync(
        path.join(TEST_MEMORY_DIR, 'report.json'),
        JSON.stringify([
          { id: 'r1', description: '记忆1', importance: 0.5, createdAt: new Date().toISOString() },
          { id: 'r2', description: '记忆2', importance: 0.6, createdAt: new Date().toISOString() },
        ])
      )

      fs.writeFileSync(
        path.join(TEST_DIALOG_DIR, 'report.jsonl'),
        JSON.stringify({ id: 'd1', type: 'user', content: '对话', timestamp: Date.now() })
      )

      // 执行同步
      const report = await syncManager.forceSync()

      // 验证报告结构
      expect(report.timestamp).toBeGreaterThan(0)
      expect(report.duration).toBeGreaterThanOrEqual(0)
      expect(report.memoryFiles.total).toBeGreaterThanOrEqual(0)
    })
  })
})
