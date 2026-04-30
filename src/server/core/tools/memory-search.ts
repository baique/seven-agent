import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { paths } from '../../config/env'
import { logger } from '../../utils/logger'
import type { MemoryMessage } from '../../memory'
import { jsonMemoryManager, vectorMemoryService } from '../../memory'
import { ToolResult } from '../../utils/tool-response'
import type { DialogMemoryMetadata } from '../../memory/vector/types'

const MAX_RESULTS_PER_CALL = 50
const MAX_CONTENT_LENGTH = 500

const DEFAULT_MIN_IMPORTANCE = 0.3

export const searchMemoryTool = new DynamicStructuredTool({
  name: 'memory_search',
  description: `搜索已记录的重要信息（支持语义搜索）。
**使用建议：**
- 支持自然语言描述，不仅限于关键词
- 使用具体的问题或描述，获得更准确的语义匹配
- 可以结合时间范围缩小搜索范围
- 每次调用最多返回 50 条结果
`,
  schema: z.object({
    query: z.string().describe('搜索查询，支持自然语言描述'),
    maxResults: z.number().min(1).max(50).default(10).describe('最大返回结果数'),
    sourceTypes: z
      .array(z.enum(['memory', 'dialog']))
      .optional()
      .describe('指定搜索来源，不指定则搜索全部'),
    useVectorSearch: z.boolean().default(true).describe('是否使用向量语义搜索（默认true）'),
  }),
  func: async (input) => {
    const toolName = 'memory_search'
    try {
      const { query, maxResults = 10, sourceTypes, useVectorSearch = true } = input

      // 优先使用向量搜索（如果服务已初始化且启用）
      if (useVectorSearch && vectorMemoryService.isInitialized()) {
        try {
          const results = await vectorMemoryService.search(query, {
            maxResults,
            sourceTypes: sourceTypes as Array<'memory' | 'dialog'> | undefined,
          })

          if (results.length > 0) {
            const outputParts: string[] = []
            const memoryResults = results.filter((r) => r.sourceType === 'memory')
            const dialogResults = results.filter((r) => r.sourceType === 'dialog')

            if (memoryResults.length > 0) {
              outputParts.push('# 长期记忆')
              for (const item of memoryResults) {
                outputParts.push(
                  JSON.stringify({
                    id: item.sourceId,
                    description: item.content,
                    score: Math.round(item.score * 100) + '%',
                    createdAt: new Date(item.createdAt).toISOString(),
                  }),
                )
              }
            }

            if (dialogResults.length > 0) {
              outputParts.push('# 过往对话')
              for (const item of dialogResults) {
                const dialogMeta = item.metadata as DialogMemoryMetadata | undefined
                outputParts.push(
                  JSON.stringify({
                    id: item.sourceId,
                    role: dialogMeta?.role || 'unknown',
                    content: item.snippet,
                    score: Math.round(item.score * 100) + '%',
                    timestamp: item.createdAt,
                  }),
                )
              }
            }

            logger.info(
              `[SearchMemory] 向量搜索 "${query}" 找到 ${memoryResults.length} 条长期记忆 + ${dialogResults.length} 条对话记录`,
            )

            return await ToolResult.success(toolName, {
              msg: `找到 ${results.length} 条相关记录`,
              body: outputParts.join('\n'),
              extra: {
                query,
                totalResults: results.length,
                longTermCount: memoryResults.length,
                dialogCount: dialogResults.length,
                searchMethod: 'vector',
              },
            })
          }
        } catch (vectorErr) {
          logger.warn(`[SearchMemory] 向量搜索失败，回退到关键词搜索: ${vectorErr}`)
          // 回退到关键词搜索
        }
      }

      // 关键词搜索（传统方式）
      const keywords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((k) => k.length > 0)

      if (keywords.length === 0) {
        return await ToolResult.error(toolName, {
          msg: '请提供搜索关键词',
        })
      }

      const searchMemory = !sourceTypes || sourceTypes.includes('memory')
      const searchDialog = !sourceTypes || sourceTypes.includes('dialog')

      const [longTermResults, dialogResults] = await Promise.all([
        searchMemory
          ? searchLongTermMemories(keywords, DEFAULT_MIN_IMPORTANCE)
          : Promise.resolve([]),
        searchDialog ? searchDialogRecords(keywords) : Promise.resolve([]),
      ])

      const outputParts: string[] = []

      if (longTermResults.length > 0) {
        outputParts.push('# 长期记忆')
        for (const item of longTermResults.slice(0, maxResults)) {
          outputParts.push(JSON.stringify(item))
        }
      }

      if (dialogResults.length > 0) {
        outputParts.push('# 过往对话')
        for (const item of dialogResults.slice(0, maxResults)) {
          outputParts.push(JSON.stringify(item))
        }
      }

      const totalCount = longTermResults.length + dialogResults.length

      logger.info(
        `[SearchMemory] 关键词搜索 "${query}" 找到 ${longTermResults.length} 条长期记忆 + ${dialogResults.length} 条对话记录`,
      )

      const msg = `找到 ${totalCount} 条记录`

      if (outputParts.length > 0) {
        return await ToolResult.success(toolName, {
          msg,
          body: outputParts.join('\n'),
          extra: {
            query,
            totalResults: totalCount,
            longTermCount: longTermResults.length,
            dialogCount: dialogResults.length,
            searchMethod: 'keyword',
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

  const sentences = content.split(/[.!?。！？]/)
  const relevantSentences: string[] = []

  for (const sentence of sentences) {
    if (matchesKeywords(sentence, keywords)) {
      relevantSentences.push(sentence.trim())
    }
  }

  if (relevantSentences.length > 0) {
    return relevantSentences.join('... ').slice(0, MAX_CONTENT_LENGTH)
  }

  return content.slice(0, MAX_CONTENT_LENGTH)
}

function readMessagesFromFile(filePath: string): MemoryMessage[] {
  const messages: MemoryMessage[] = []

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const message = JSON.parse(line) as MemoryMessage
        messages.push(message)
      } catch (e) {
        // 忽略解析错误的行
      }
    }
  } catch (error) {
    logger.error(`[SearchMemory] 读取文件失败 ${filePath}: ${error}`)
  }

  return messages
}
