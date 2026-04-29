import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { jsonMemoryManager } from '../../memory/json-memory-manager'
import { clearMemoryCache } from '../../memory/memory-injector'
import { buildCoreMemoryPrompt } from '../../memory/memory-injector'
import { logger } from '../../utils/logger'
import { ToolResult } from '../../utils/tool-response'

const MemoryOperationSchema = z.union([
  z.object({
    action: z.literal('add'),
    description: z.string().describe('记忆描述内容'),
    importance: z.number().min(0).max(1).describe('重要性 0-1，越高越重要'),
    expireAt: z
      .string()
      .describe('过期时间，格式：2026年04月24日15时30分45秒 或 2026-04-24 15:30:45'),
  }),
  z.object({
    action: z.literal('update'),
    memoryId: z.string().describe('记忆ID'),
    description: z.string().optional().describe('新的描述内容'),
    importance: z.number().min(0).max(1).optional().describe('新的重要性'),
  }),
  z.object({
    action: z.literal('delete'),
    memoryId: z.string().describe('记忆ID'),
  }),
  z.object({
    action: z.literal('list'),
  }),
])

function formatMemoryList(
  memories: { id: string; importance: number; description: string }[],
): string[] {
  return memories.map((m) => `  ${m.id} | 重要性:${m.importance.toFixed(2)} | ${m.description}`)
}

async function getMemoryStatusFeedback(): Promise<string[]> {
  const lines: string[] = []

  const memoryPrompt = await buildCoreMemoryPrompt()

  if (memoryPrompt) {
    const memoryLines = memoryPrompt.split('\n')
    const contentStartIdx = memoryLines.findIndex((l) => l.startsWith('### 记忆列表'))
    if (contentStartIdx !== -1) {
      const memoryLines = memoryPrompt
        .split('\n')
        .slice(contentStartIdx + 1)
        .join('\n')
        .trim()

      if (memoryLines) {
        const memoryBlocks = memoryLines.split('---').filter((s) => s.trim())
        for (const block of memoryBlocks) {
          const trimmed = block.trim()
          if (trimmed) {
            lines.push(trimmed)
          }
        }
      }
    }
  }

  if (lines.length > 0) {
    lines.push('\n记忆添加成功，请查看现有记忆。如有可整合的、冲突的、或无用的记忆，请立即处理')
  }

  return lines
}

export const updateMemoryTool = new DynamicStructuredTool({
  name: 'update_memory',
  description: `记录和管理重要信息。

**操作说明：**
- add: 记录新信息（描述 + 重要性 + 过期时间）
- update: 更新已有信息
- delete: 删除信息
- list: 查看所有记录

**重要性参考：**
- 0.9-1.0: 人生大事、核心关系（过期时间1年以上）
- 0.7-0.8: 重要偏好、习惯（过期时间3-6个月）
- 0.5-0.6: 一般信息（过期时间1-2个月）
- 0.1-0.4: 临时信息（过期时间1-2周）

**过期时间格式：**
- 2026年04月24日15时30分45秒
- 2026-04-24 15:30:45`,
  schema: z.object({
    operations: z.array(MemoryOperationSchema).describe('操作列表'),
  }),
  func: async (input) => {
    const toolName = 'update_memory'

    try {
      const { operations } = input
      const results: string[] = []
      let needFeedback = false

      for (const op of operations) {
        try {
          switch (op.action) {
            case 'add': {
              const memory = await jsonMemoryManager.addFragmentMemory(
                op.description,
                op.importance,
                op.expireAt,
              )
              results.push(`已记录: ${memory.id} (重要性: ${memory.importance.toFixed(2)})`)
              logger.info(`[MemoryTool] 添加记忆: ${memory.id}`)
              needFeedback = true
              break
            }

            case 'update': {
              const isFragment = op.memoryId.startsWith('frag-')
              const isLongTerm = op.memoryId.startsWith('ltm-')

              if (!isFragment && !isLongTerm) {
                results.push(`无效的记忆ID: ${op.memoryId}`)
                break
              }

              if (isFragment) {
                const success = await jsonMemoryManager.updateFragmentMemory(op.memoryId, {
                  description: op.description,
                  importance: op.importance,
                })

                if (success) {
                  results.push(`已更新: ${op.memoryId}`)
                  logger.info(`[MemoryTool] 更新记忆: ${op.memoryId}`)
                  needFeedback = true
                } else {
                  results.push(`未找到记忆: ${op.memoryId}`)
                }
              } else {
                const success = await jsonMemoryManager.updateLongTermMemory(op.memoryId, {
                  description: op.description,
                  importance: op.importance,
                })
                if (success) {
                  results.push(`已更新: ${op.memoryId}`)
                  logger.info(`[MemoryTool] 更新记忆: ${op.memoryId}`)
                } else {
                  results.push(`未找到记忆: ${op.memoryId}`)
                }
              }
              break
            }

            case 'delete': {
              const isFragment = op.memoryId.startsWith('frag-')
              const isLongTerm = op.memoryId.startsWith('ltm-')

              if (!isFragment && !isLongTerm) {
                results.push(`无效的记忆ID: ${op.memoryId}`)
                break
              }

              let success: boolean
              if (isFragment) {
                success = await jsonMemoryManager.deleteFragmentMemory(op.memoryId)
              } else {
                success = await jsonMemoryManager.deleteLongTermMemory(op.memoryId)
              }

              if (success) {
                results.push(`已删除: ${op.memoryId}`)
                logger.info(`[MemoryTool] 删除记忆: ${op.memoryId}`)
                needFeedback = true
              } else {
                results.push(`未找到记忆: ${op.memoryId}`)
              }
              break
            }

            case 'list': {
              const lines: string[] = []

              const longTermMemories = await jsonMemoryManager.getAllLongTermMemories()
              if (longTermMemories.length > 0) {
                lines.push(`【核心记忆】共${longTermMemories.length}条`)
                longTermMemories
                  .sort((a, b) => b.importance - a.importance)
                  .forEach((m) => {
                    lines.push(
                      `  ${m.id} | 重要性:${m.importance.toFixed(2)} | ${m.description.slice(0, 50)}`,
                    )
                  })
              }

              const recentFragments = await jsonMemoryManager.getRecentFragmentMemories(7)
              const validFragments = recentFragments.filter(
                (m) => new Date(m.expireAt) > new Date(),
              )

              if (validFragments.length > 0) {
                if (lines.length > 0) lines.push('')
                lines.push(`【近期记忆】共${validFragments.length}条（近7天）`)
                validFragments
                  .sort((a, b) => b.importance - a.importance)
                  .slice(0, 10)
                  .forEach((m) => {
                    lines.push(
                      `  ${m.id} | 重要性:${m.importance.toFixed(2)} | ${m.description.slice(0, 50)}`,
                    )
                  })
              }

              if (lines.length === 0) {
                lines.push('当前没有记录的记忆')
              }

              results.push(lines.join('\n'))
              logger.info(`[MemoryTool] 列出记忆`)
              break
            }
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          results.push(`操作失败: ${errorMsg}`)
          logger.error(`[MemoryTool] 操作失败: ${errorMsg}`)
        }
      }

      if (needFeedback) {
        const feedbackLines = await getMemoryStatusFeedback()
        results.push(...feedbackLines)
      }

      clearMemoryCache()

      const resultsText = results.join('\n')
      return await ToolResult.success(toolName, {
        msg: `操作完成，共${operations.length}个操作`,
        body: resultsText,
        extra: {
          operationCount: operations.length,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[MemoryTool] 操作失败: ${errorMsg}`)
      return await ToolResult.error(toolName, {
        msg: errorMsg,
      })
    }
  },
})
