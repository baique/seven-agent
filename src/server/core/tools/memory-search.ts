import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { paths } from '../../config/env'
import { logger } from '../../utils/logger'
import type { MemoryMessage } from '../../memory'
import { jsonMemoryManager } from '../../memory/json-memory-manager'
import { ToolResult } from '../../utils/tool-response'

const MAX_RESULTS_PER_CALL = 200
const MAX_CONTENT_LENGTH = 500

const DEFAULT_MIN_IMPORTANCE = 0.3

export const searchMemoryTool = new DynamicStructuredTool({
  name: 'memory_search',
  description: `搜索已记录的重要信息。
**使用建议：**
- 使用具体的关键词搜索，避免过于宽泛的词
- 每次调用最多返回 200 条结果
- 如果结果不完整，可以使用 offset 参数继续获取
- 注意：任务请使用 query_tasks 工具查询，不在记忆中存储
`,
  schema: z.object({
    query: z.string().describe('搜索关键词或自然语言描述'),
    offset: z.number().min(0).default(0).describe('跳过前N条结果，用于分页获取更多结果'),
    minImportance: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_MIN_IMPORTANCE)
      .describe('最低重要性过滤，默认0.3'),
  }),
  func: async (input) => {
    const toolName = 'memory_search'
    try {
      const { query, offset = 0, minImportance = DEFAULT_MIN_IMPORTANCE } = input

      const keywords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((k) => k.length > 0)

      if (keywords.length === 0) {
        return await ToolResult.error(toolName, {
          msg: '请提供搜索关键词',
        })
      }

      const [longTermResults, dialogResults] = await Promise.all([
        searchLongTermMemories(keywords, minImportance),
        searchDialogRecords(keywords),
      ])

      const outputParts: string[] = []

      if (longTermResults.length > 0) {
        outputParts.push('# 长期记忆')
        for (const item of longTermResults.slice(offset, offset + MAX_RESULTS_PER_CALL)) {
          outputParts.push(JSON.stringify(item))
        }
      }

      const dialogOffset = Math.max(0, offset - longTermResults.length)
      if (dialogResults.length > 0) {
        outputParts.push('# 过往对话')
        for (const item of dialogResults.slice(dialogOffset, dialogOffset + MAX_RESULTS_PER_CALL)) {
          outputParts.push(JSON.stringify(item))
        }
      }

      const totalCount = longTermResults.length + dialogResults.length
      const hasMore = offset + MAX_RESULTS_PER_CALL < totalCount

      logger.info(
        `[SearchMemory] 搜索 "${query}" 找到 ${longTermResults.length} 条长期记忆 + ${dialogResults.length} 条对话记录`,
      )

      const msg = `找到 ${totalCount} 条记录${hasMore ? '，还有更多' : ''}`

      if (outputParts.length > 0) {
        return await ToolResult.success(toolName, {
          msg,
          body: outputParts.join('\n'),
          extra: {
            query,
            totalResults: totalCount,
            longTermCount: longTermResults.length,
            dialogCount: dialogResults.length,
            offset,
            hasMore,
          },
        })
      }

      return await ToolResult.success(toolName, {
        msg: '未找到匹配的记忆',
        extra: {
          query,
          totalResults: 0,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[SearchMemory] 搜索失败: ${errorMsg}`)
      return await ToolResult.error(toolName, {
        msg: '搜索失败',
        body: errorMsg,
      })
    }
  },
})

async function searchLongTermMemories(
  keywords: string[],
  minImportance: number,
): Promise<
  Array<{
    id: string
    description: string
    importance: number
    createdAt: string
    memoryType: 'long_term'
  }>
> {
  const results: Array<{
    id: string
    description: string
    importance: number
    createdAt: string
    memoryType: 'long_term'
  }> = []

  const longTermMemories = await jsonMemoryManager.getAllLongTermMemories()
  for (const memory of longTermMemories) {
    if (memory.importance < minImportance) continue
    if (matchesKeywords(memory.description, keywords)) {
      results.push({
        id: memory.id,
        description: memory.description,
        importance: memory.importance,
        createdAt: memory.createdAt,
        memoryType: 'long_term',
      })
    }
  }

  results.sort((a, b) => b.importance - a.importance)
  return results
}

async function searchDialogRecords(
  keywords: string[],
): Promise<Array<{ id: string; role: string; content: string; timestamp: number }>> {
  const results: Array<{ id: string; role: string; content: string; timestamp: number }> = []
  const memoryDir = join(paths.WORKSPACE_ROOT, 'memory')

  if (!existsSync(memoryDir)) {
    return results
  }

  const dateDirs = readdirSync(memoryDir)
    .filter((name) => /^\d{8}$/.test(name))
    .sort((a, b) => b.localeCompare(a))

  for (const dateDir of dateDirs) {
    const memoryFile = join(memoryDir, dateDir, 'memory.jsonl')
    if (!existsSync(memoryFile)) continue

    const messages = readMessagesFromFile(memoryFile)
    for (const msg of messages) {
      if (matchesKeywords(msg.content, keywords)) {
        const content = extractContext(msg.content, keywords)
        const role = msg.type === 'human' ? 'user' : msg.type === 'ai' ? 'ai' : 'tool'

        results.push({
          id: msg.id || `${dateDir}_${msg.timestamp}`,
          role,
          content,
          timestamp: msg.timestamp,
        })
      }
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp)
  return results
}

function matchesKeywords(content: string | undefined | null, keywords: string[]): boolean {
  if (!content || typeof content !== 'string') return false
  if (keywords.length === 0) return true

  const lowerContent = content.toLowerCase()
  return keywords.some((k) => lowerContent.includes(k.toLowerCase()))
}

function extractContext(content: string | undefined | null, keywords: string[]): string {
  if (!content || typeof content !== 'string') return ''
  if (content.length <= MAX_CONTENT_LENGTH) return content

  const lowerContent = content.toLowerCase()
  let bestIndex = content.length

  for (const keyword of keywords) {
    const index = lowerContent.indexOf(keyword)
    if (index !== -1 && index < bestIndex) {
      bestIndex = index
    }
  }

  const start = Math.max(0, bestIndex - 100)
  const end = Math.min(content.length, start + MAX_CONTENT_LENGTH)
  const truncated = content.slice(start, end)

  return (start > 0 ? '...' : '') + truncated + (end < content.length ? '...' : '')
}

function readMessagesFromFile(filePath: string): MemoryMessage[] {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.trim().split('\n')
  const messages: MemoryMessage[] = []

  for (const line of lines) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line) as MemoryMessage)
      } catch {
        // 忽略解析错误
      }
    }
  }

  return messages
}

export const memorySearchTools = [searchMemoryTool]
