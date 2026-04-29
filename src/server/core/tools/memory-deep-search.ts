import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { join } from 'path'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { paths } from '../../config/env'
import { logger } from '../../utils/logger'
import type { MemoryMessage } from '../../memory'
import { ToolResult } from '../../utils/tool-response'
import { removeThinkTags } from '../../utils'

const MAX_RESULTS_LIMIT = 200

interface ParsedTime {
  dateStr: string
  timestamp: number
}

function parseNaturalTime(timeStr: string): ParsedTime | null {
  const chineseMatch = timeStr.match(
    /^(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分(\d{1,2})秒$/,
  )
  if (chineseMatch) {
    const date = new Date(
      parseInt(chineseMatch[1], 10),
      parseInt(chineseMatch[2], 10) - 1,
      parseInt(chineseMatch[3], 10),
      parseInt(chineseMatch[4], 10),
      parseInt(chineseMatch[5], 10),
      parseInt(chineseMatch[6], 10),
    )
    return {
      dateStr: formatDate(date),
      timestamp: date.getTime(),
    }
  }

  const standardMatch = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
  if (standardMatch) {
    const date = new Date(
      parseInt(standardMatch[1], 10),
      parseInt(standardMatch[2], 10) - 1,
      parseInt(standardMatch[3], 10),
      parseInt(standardMatch[4], 10),
      parseInt(standardMatch[5], 10),
      parseInt(standardMatch[6], 10),
    )
    return {
      dateStr: formatDate(date),
      timestamp: date.getTime(),
    }
  }

  if (/^\d{8}$/.test(timeStr)) {
    const date = new Date(
      parseInt(timeStr.slice(0, 4), 10),
      parseInt(timeStr.slice(4, 6), 10) - 1,
      parseInt(timeStr.slice(6, 8), 10),
      12,
      0,
      0,
    )
    return {
      dateStr: formatDate(date),
      timestamp: date.getTime(),
    }
  }

  return null
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function parseKeywords(keywords: string): string[] {
  return keywords
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 0)
}

function matchesAnyKeyword(content: string | undefined | null, keywords: string[]): boolean {
  if (!content || typeof content !== 'string') return false
  if (keywords.length === 0) return true
  const lowerContent = removeThinkTags(content).toLowerCase()
  return keywords.some((keyword) => lowerContent.includes(keyword))
}

export const memoryDeepSearchTool = new DynamicStructuredTool({
  name: 'memory_deep_search',
  description: `深度搜索历史对话记录。

**参数说明（关键词和时间二选一，至少填一个）：**
- keywords: 搜索关键词，多个关键词用空格分隔，命中任一即返回
- timePoint: 时间点，统一格式：
  - 年月日时分秒："2026年04月07日15时30分45秒"
  - 标准格式："2026-04-07 15:30:45"
  - 纯日期："20260407"（默认中午12点）
- start: 起始偏移，负数=向前，正数=向后，0=从时间点开始，范围 -200~200
- end: 结束偏移，负数=向前，正数=向后，范围 -200~200

**示例：**
- keywords="吃饭 美食": 全局搜索包含"吃饭"或"美食"的对话
- timePoint="20260407": 搜索该日期前后的所有对话
- keywords="bug", timePoint="2026-04-07 12:00:00": 搜索该时间点前后包含"bug"的对话
`,
  schema: z.object({
    keywords: z.string().optional().describe('搜索关键词，多个用空格分隔，命中任一即返回'),
    timePoint: z
      .string()
      .optional()
      .describe('时间点，格式：2026年04月07日15时30分45秒 或 2026-04-07 15:30:45'),
    start: z
      .number()
      .int()
      .min(-MAX_RESULTS_LIMIT)
      .max(MAX_RESULTS_LIMIT)
      .default(-10)
      .describe('起始偏移'),
    end: z
      .number()
      .int()
      .min(-MAX_RESULTS_LIMIT)
      .max(MAX_RESULTS_LIMIT)
      .default(10)
      .describe('结束偏移'),
  }),
  func: async (input) => {
    const toolName = 'memory_deep_search'
    try {
      const { keywords, timePoint, start = -5, end = 5 } = input

      const keywordList = keywords ? parseKeywords(keywords) : []

      if (keywordList.length === 0 && !timePoint) {
        return await ToolResult.error(toolName, { msg: '请提供搜索关键词或时间点（至少一个）' })
      }

      if (start > end) {
        return await ToolResult.error(toolName, { msg: `start(${start}) 不能大于 end(${end})` })
      }

      if (end - start > MAX_RESULTS_LIMIT) {
        return await ToolResult.error(toolName, {
          msg: `范围过大，最多支持 ${MAX_RESULTS_LIMIT} 条，当前请求 ${end - start} 条`,
        })
      }

      let parsed: ParsedTime | null = null
      if (timePoint) {
        parsed = parseNaturalTime(timePoint)
        if (!parsed) {
          return await ToolResult.error(toolName, {
            msg: `无法解析时间"${timePoint}"，请使用格式：2026年04月07日15时30分45秒 或 2026-04-07 15:30:45 或 20260407`,
          })
        }
      }

      let result: SearchResult

      if (parsed) {
        result = await deepSearchByTimestamp(
          parsed.dateStr,
          parsed.timestamp,
          start,
          end,
          keywordList,
        )
        logger.info(
          `[DeepSearch] 检索 ${parsed.dateStr} ${formatTime(parsed.timestamp)}，关键词=[${keywordList.join(', ')}]，start=${start} end=${end}，找到 ${result.messages.length} 条`,
        )
      } else {
        result = await deepSearchAll(start, end, keywordList)
        logger.info(
          `[DeepSearch] 全局检索，关键词=[${keywordList.join(', ')}]，start=${start} end=${end}，找到 ${result.messages.length} 条`,
        )
      }

      if (result.messages.length === 0) {
        return await ToolResult.success(toolName, {
          msg: `未找到包含关键词「${keywordList.join('」或「')}」的对话记录`,
          extra: { keywords: keywordList },
        })
      }

      const outputParts: string[] = []
      outputParts.push('# 过往对话')
      for (const msg of result.messages) {
        outputParts.push(JSON.stringify(msg))
      }

      const pagination = buildPaginationHint(start, end, result.hasMore)
      if (pagination) {
        outputParts.push('', pagination)
      }

      const body = outputParts.join('\n')

      return await ToolResult.success(toolName, {
        msg: `找到 ${result.messages.length} 条对话记录`,
        body,
        extra: {
          keywords: keywordList,
          count: result.messages.length,
          hasMore: result.hasMore,
        },
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[DeepSearch] 检索失败: ${errorMsg}`)
      return await ToolResult.error(toolName, {
        msg: '深度检索失败',
        body: errorMsg,
      })
    }
  },
})

interface DialogRecord {
  id: string
  role: string
  content: string
  timestamp: number
}

interface SearchResult {
  messages: DialogRecord[]
  hasMore: { before: boolean; after: boolean }
}

async function deepSearchByTimestamp(
  dateStr: string,
  targetTimestamp: number,
  start: number,
  end: number,
  keywords: string[],
): Promise<SearchResult> {
  const messages = loadMessagesByDate(dateStr)

  if (messages.length === 0) {
    return { messages: [], hasMore: { before: false, after: false } }
  }

  messages.sort((a, b) => a.timestamp - b.timestamp)

  let midIndex = messages.findIndex((m) => m.timestamp >= targetTimestamp)
  if (midIndex === -1) {
    midIndex = messages.length - 1
  } else if (midIndex > 0) {
    const prevDiff = Math.abs(messages[midIndex - 1].timestamp - targetTimestamp)
    const currDiff = Math.abs(messages[midIndex].timestamp - targetTimestamp)
    if (prevDiff < currDiff) {
      midIndex = midIndex - 1
    }
  }

  const fromIndex = midIndex + start
  const toIndex = midIndex + end

  const clampedFrom = Math.max(0, fromIndex)
  const clampedTo = Math.min(messages.length, toIndex)

  const selected = messages
    .slice(clampedFrom, clampedTo)
    .filter((msg) => matchesAnyKeyword(msg.content, keywords))
    .map((msg) => formatMessageAsJson(msg))

  return {
    messages: selected,
    hasMore: {
      before: fromIndex > 0,
      after: toIndex < messages.length,
    },
  }
}

async function deepSearchAll(
  start: number,
  end: number,
  keywords: string[],
): Promise<SearchResult> {
  const memoryDir = join(paths.WORKSPACE_ROOT, 'memory')

  if (!existsSync(memoryDir)) {
    return { messages: [], hasMore: { before: false, after: false } }
  }

  const entries = readdirSync(memoryDir, { withFileTypes: true })
  const dateDirs = entries
    .filter((e) => e.isDirectory() && /^\d{8}$/.test(e.name))
    .map((e) => e.name)
    .sort()

  const allMatchedMessages: DialogRecord[] = []

  for (const dateStr of dateDirs) {
    const messages = loadMessagesByDate(dateStr)
    const matched = messages.filter((msg) => matchesAnyKeyword(msg.content, keywords))
    for (const msg of matched) {
      allMatchedMessages.push(formatMessageAsJson(msg))
    }
  }

  allMatchedMessages.sort((a, b) => a.timestamp - b.timestamp)

  const count = end - start
  const fromIndex = start >= 0 ? start : Math.max(0, allMatchedMessages.length + start)
  const toIndex = fromIndex + count

  const clampedFrom = Math.max(0, fromIndex)
  const clampedTo = Math.min(allMatchedMessages.length, toIndex)

  const selected = allMatchedMessages.slice(clampedFrom, clampedTo)

  return {
    messages: selected,
    hasMore: {
      before: fromIndex > 0,
      after: toIndex < allMatchedMessages.length,
    },
  }
}

function formatMessageAsJson(msg: MemoryMessage): DialogRecord {
  const role = msg.type === 'human' ? 'user' : msg.type === 'ai' ? 'ai' : 'tool'
  return {
    id: msg.id || `msg_${msg.timestamp}`,
    role,
    content: removeThinkTags(msg.content || ''),
    timestamp: msg.timestamp,
  }
}

function loadMessagesByDate(dateStr: string): MemoryMessage[] {
  const memoryDir = join(paths.WORKSPACE_ROOT, 'memory')
  const dayPath = join(memoryDir, dateStr)

  if (!existsSync(dayPath)) {
    return []
  }

  const memoryFile = join(dayPath, 'memory.jsonl')
  if (!existsSync(memoryFile)) {
    return []
  }

  return readMessagesFromFile(memoryFile)
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

function buildPaginationHint(
  start: number,
  end: number,
  hasMore: { before: boolean; after: boolean },
): string {
  const hints: string[] = []

  if (hasMore.before) {
    const newStart = start - (end - start)
    const newEnd = start
    hints.push(`向前翻页: start=${newStart}, end=${newEnd}`)
  }

  if (hasMore.after) {
    const newStart = end
    const newEnd = end + (end - start)
    hints.push(`向后翻页: start=${newStart}, end=${newEnd}`)
  }

  return hints.length > 0 ? hints.join('\n') : ''
}

export const memoryDeepSearchTools = [memoryDeepSearchTool]