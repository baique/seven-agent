import { MarkdownAstParser } from './markdown-ast'

/**
 * 清理文本以适应TTS合成
 * - 缩减多个省略号为......
 * - 移除markdown格式符号
 * - 移除emoji
 * @param text - 原始文本
 * @returns 清理后的文本
 */
export function cleanTextForTTS(text: string): string {
  let cleaned = text

  // 将多个省略号缩减成......
  cleaned = cleaned.replace(/[…\.]{3,}/g, '......')

  cleaned = cleaned.replace(/[#*_~`>\-+]/g, '')
  cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '')
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '')
  cleaned = cleaned.replace(/`[^`]+`/g, '')
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  const emojiRegex =
    /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2300}-\u{23FF}]|[\u{2B50}]|[\u{1FA00}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]|[\u{FE0F}]|[\u{E0020}-\u{E007F}]/gu
  cleaned = cleaned.replace(emojiRegex, '')

  cleaned = cleaned.trim()

  return cleaned
}

export interface TextSegment {
  text: string
  tag: string[]
  pauseAfter?: number
}

function parseTagIntensity(tag: string): { action: string; intensity: number } {
  const dashIndex = tag.indexOf('-')
  if (dashIndex === -1) {
    return { action: tag, intensity: 1 }
  }
  const action = tag.slice(0, dashIndex)
  const intensity = parseInt(tag.slice(dashIndex + 1), 10) || 1
  return { action, intensity }
}

function extractTags(content: string): { text: string; tags: string[]; waitTime?: number } {
  const tags: string[] = []
  const waitRegex = /\[wait-(\d+)\]/gi
  let lastWaitTime: number | undefined

  // 先提取所有 [wait-n] 标记并记录最后一个的值
  let text = content.replace(waitRegex, (_match, timeStr) => {
    const time = parseInt(timeStr, 10)
    if (!isNaN(time)) {
      lastWaitTime = Math.min(3200, Math.max(800, time))
    }
    return ''
  })

  text = text.replace(/\[([^\]]+)\]/g, (_, tagContent) => {
    const { action, intensity } = parseTagIntensity(tagContent)
    if (action) {
      tags.push(intensity === 1 ? action : `${action}-${intensity}`)
    }
    return ''
  })
  return { text: text.trim(), tags, waitTime: lastWaitTime }
}

/**
 * 处理 TTS 文本段落的通用逻辑
 * @param segments - 文本段落数组
 * @returns 处理后的文本片段数组
 */
function processSegments(segments: { text: string; pauseAfter?: number }[]): TextSegment[] {
  const result: TextSegment[] = []
  let pendingTags: string[] = []

  for (const segment of segments) {
    // 对提取的纯文本进行表情标签提取，按行处理
    const lines = segment.text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const isLastLine = i === lines.length - 1
      const line = lines[i].trim()
      if (!line) continue

      const { text: lineText, tags: lineTags, waitTime } = extractTags(line)
      const allTags = [...pendingTags, ...lineTags]
      pendingTags = []

      // 如果这一行只有标签没有文本，累积到 pendingTags
      if (!lineText) {
        pendingTags.push(...allTags)
        // 如果是最后一行且有累积的标签，加到前一个 segment
        if (isLastLine && result.length > 0) {
          result[result.length - 1].tag.push(...pendingTags)
          pendingTags = []
        }
        continue
      }

      // 如果有 [wait-n] 标记，使用它替换计算的停顿时间
      const pauseAfter = waitTime !== undefined ? waitTime / 1000 : segment.pauseAfter

      result.push({
        text: lineText,
        tag: allTags,
        pauseAfter,
      })
    }
  }

  return result
}

/**
 * 使用 Markdown AST 解析并提取带标签的文本段落
 * 过滤掉表格、代码块、链接等不适合 TTS 的内容
 * 用于消息完全接收后的 TTS 处理
 * @param text - 原始文本（可能包含 markdown）
 * @returns 文本片段数组
 */
export function splitTextWithTags(text: string): TextSegment[] {
  if (!text || !text.trim()) return []

  // 使用 Markdown AST 解析器提取适合 TTS 的段落
  const parser = new MarkdownAstParser()
  const ttsSegments = parser.extractTTSText(text)

  return processSegments(ttsSegments)
}

/**
 * 提取错误信息的详细描述
 * @param error 错误信息
 * @returns 错误信息的详细描述
 */
export function errorMessage(error: any): string {
  return error instanceof Error ? error.message : error
}

export { logger } from './logger'

export {
  readFile,
  initWorkspace,
  getPromptPath,
  getSkillPath,
  getDbPath,
  saveLongContentToTempFile,
} from './workspace'
export { uploadFileAndGetUrl } from './oss-upload'

export {
  formatDate,
  getCurrentDate,
  formatDateDisplay,
  formatTimeDiff,
  getTimeSince,
  getSecondsDiff,
} from './time-utils'

export {
  truncateToolResponse,
  maskFileContent,
  convertMemoryMessageToBaseMessages as convertToMessages,
  convertBaseMessageToMemoryMessage,
  findToolCallPairs,
  slidingWindowMessages,
} from './message-utils'

export { detectAndDecode } from './encoding-utils'

export { isWorkspacePath, normalizePath, joinPaths } from './path-utils'

export {
  createFsConfig,
  validatePath,
  validateFileSize,
  getFileType,
  formatBytes,
  type FsConfig,
  type PathValidationResult,
} from './path-policy'

export { parseXMLFragments } from './xml-utils'
export type { ElementNode } from './xml-utils'

export { retry, retryWithExponentialBackoff, retryForever, type RetryOptions } from './retry-utils'

/**
 * 移除文本中的 think 标签内容
 * @param text 原始文本
 * @returns 清理后的文本
 */
export function removeThinkTags(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<think[\s\S]*$/gi, '')
    .trim()
}

/**
 * 安全地将对象序列化为 JSON 字符串，处理 BigInt 类型
 * @param value 要序列化的值
 * @param replacer JSON.stringify 的 replacer 参数
 * @param space JSON.stringify 的 space 参数
 * @returns JSON 字符串
 */
export function safeStringify(
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown,
  space?: string | number,
): string {
  return JSON.stringify(
    value,
    (key, val) => {
      if (typeof val === 'bigint') {
        return val.toString()
      }
      if (replacer) {
        return replacer(key, val)
      }
      return val
    },
    space,
  )
}

// Markdown AST 解析工具
export { MarkdownAstParser, createMarkdownAstParser, extractTTSTextQuick } from './markdown-ast'
export type { MarkdownNode, MarkdownNodeType, TTSTextSegment } from './markdown-ast'
