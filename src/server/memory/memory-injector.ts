/**
 * 记忆提示词注入模块
 * 从长期记忆(main.json)和近72小时碎片记忆中获取记忆并注入提示词
 */
import { jsonMemoryManager } from './json-memory-manager'
import { logger } from '../utils/logger'
import { configManager } from '../config/env'

let cachedMemoryPrompt: string | null = null

/**
 * 格式化单个记忆项
 * 格式：
 * 记忆编号：frag-xxx 或 ltm-xxx
 * 记忆内容：描述原文
 * 重要性：0.85
 * 记录时间：2026-04-24 10:00:00
 */
function formatMemory(memory: {
  id: string
  description: string
  importance: number
  createdAt: string
}): string {
  const lines = [
    `记忆编号：${memory.id}`,
    `记忆内容：${memory.description}`,
    `重要性：${memory.importance.toFixed(2)}`,
    `记录时间：${new Date(memory.createdAt).toLocaleString('zh-CN')}`,
  ]

  return lines.join('\n')
}

/**
 * 构建长期记忆提示词
 * 包含长期记忆（main.json）和近72小时碎片记忆
 */
export async function buildCoreMemoryPrompt(rawOutput: boolean = false): Promise<string> {
  try {
    const sections: string[] = []

    // 获取长期记忆（main.json）
    const longTermMemories = await jsonMemoryManager.getAllLongTermMemories()
    const sortedLongTerm = longTermMemories.sort((a, b) => b.importance - a.importance).slice(0, 20) // 最多取20条最重要的

    if (sortedLongTerm.length > 0) {
      const lines = sortedLongTerm.map((m) => {
        if (rawOutput) {
          return JSON.stringify(m)
        }
        return formatMemory(m)
      })
      sections.push(`${lines.join('\n\n')}`)
    }

    // 获取近72小时碎片记忆（可配置）
    const retentionHours = configManager.get('FRAGMENT_MEMORY_RETENTION_HOURS')
    const recentFragments = await jsonMemoryManager.getRecentFragmentMemoriesByHours(retentionHours)
    const validFragments = recentFragments.filter((m) => {
      // 过滤掉已过期的
      return new Date(m.expireAt) > new Date()
    })

    if (validFragments.length > 0) {
      const lines = validFragments.map((m) => {
        if (rawOutput) {
          return JSON.stringify(m)
        }
        return formatMemory(m)
      })
      sections.push(`${lines.join('\n\n')}`)
    }

    if (sections.length === 0) {
      const emptyResult = ''
      cachedMemoryPrompt = emptyResult
      return emptyResult
    }

    const result = `## 长期记忆

### 工具使用指南
- 搜索记忆：使用「memory_search」工具
- 搜索历史对话记录：使用「memory_deep_search」工具
- 记录新记忆或更新记忆：使用「update_memory」工具

### 记忆列表
${sections.join('\n\n')}`

    cachedMemoryPrompt = result
    return result
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    logger.error(`[MemoryInjector] 获取长期记忆失败: ${err.message}\n${err.stack}`)
    return ''
  }
}

/**
 * 清除记忆缓存
 * 在记忆更新后调用，确保下次获取最新内容
 */
export function clearMemoryCache(): void {
  cachedMemoryPrompt = null
  logger.info('[MemoryInjector] 记忆缓存已清除')
}
