/**
 * 工具响应解析模块
 * 提供工具响应的解析、分割、截断等功能
 * 主要用于消息处理器、摘要模块等内部使用
 */

import path from 'node:path'
import { nanoid } from 'nanoid'
import { ToolMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import { paths, configManager } from '../config/env'
import { logger } from './logger'
import { ContentAccumulator } from './content-accumulator'
import { settingManager } from '../config/setting-manager'

export const TOOL_RESPONSE_SEPARATOR = '\n---\n'

export interface ToolResponseBase {
  success: boolean
  desc: string
}

export type ToolResponseExtra = Record<string, unknown>

/**
 * 分割工具响应为 JSON 部分和原始内容部分
 * @param response 完整的工具响应字符串
 * @returns 分割后的 JSON 部分和可选的 rawBody 部分
 */
export function splitToolResponse(response: string): { json: string; rawBody?: string } {
  const separatorIndex = response.indexOf(TOOL_RESPONSE_SEPARATOR)

  if (separatorIndex === -1) {
    return { json: response }
  }

  const jsonPart = response.substring(0, separatorIndex)
  const rawBodyPart = response.substring(separatorIndex + TOOL_RESPONSE_SEPARATOR.length)

  return {
    json: jsonPart,
    rawBody: rawBodyPart || undefined,
  }
}

/**
 * 解析工具响应的 JSON 部分
 * @param response 完整的工具响应字符串
 * @returns 解析后的对象，失败返回 null
 */
export function parseToolResponseJson(
  response: string,
): (ToolResponseBase & ToolResponseExtra) | null {
  try {
    const { json } = splitToolResponse(response)
    return JSON.parse(json) as ToolResponseBase & ToolResponseExtra
  } catch {
    return null
  }
}

async function ensureTempDir(): Promise<string> {
  const tempDir = path.join(paths.CACHE_DIR, 'temp')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(tempDir, { recursive: true })
  return tempDir
}

async function saveRawToTempFile(rawBody: string, prefix: string = 'tool'): Promise<string> {
  const tempDir = await ensureTempDir()
  const timestamp = Date.now()
  const randomId = nanoid(8)
  const fileName = `${prefix}-${timestamp}-${randomId}.txt`
  const filePath = path.join(tempDir, fileName)

  const { writeFile } = await import('node:fs/promises')
  await writeFile(filePath, rawBody, 'utf-8')

  logger.info(`[truncate] RAW内容保存到临时文件: ${filePath} (长度: ${rawBody.length})`)

  return filePath
}

/** 截断模式 */
export type TrimMode = 'head' | 'tail' | 'summary' | 'structure'

/** 统一截断选项 */
export interface UnifiedTrimOptions {
  /** 最大字符数 */
  maxChars: number
  /** 最大行数 */
  maxLines?: number
  /** 截断模式，默认head */
  mode?: TrimMode
  /** 是否保存完整内容到临时文件（默认true） */
  saveTempFile?: boolean
  /** 临时文件前缀（默认'tool'） */
  tempFilePrefix?: string
  /** 自定义截断提示文本（不传则使用默认提示） */
  hint?: string
}

/**
 * 统一截断rawBody内容
 * 所有截断操作必须通过此函数执行，禁止在其他地方实现截断逻辑
 * @param rawBody 原始内容
 * @param options 截断选项
 * @returns 截断后的内容（含截断提示）
 */
export async function trimRawBody(rawBody: string, options: UnifiedTrimOptions): Promise<string> {
  const {
    maxChars,
    maxLines,
    mode = 'head',
    saveTempFile = true,
    tempFilePrefix = 'tool',
    hint,
  } = options

  // 未超限则直接返回
  const lineCount = rawBody.split('\n').length
  if (rawBody.length <= maxChars && (!maxLines || lineCount <= maxLines)) {
    return rawBody
  }

  // 先按行数截断
  let truncated = rawBody
  if (maxLines && lineCount > maxLines) {
    truncated = truncated.split('\n').slice(0, maxLines).join('\n')
  }

  // 再按字符数截断，根据模式选择截断方式
  if (truncated.length > maxChars) {
    switch (mode) {
      case 'tail':
        truncated = truncated.slice(-maxChars)
        break
      case 'summary': {
        const headLen = Math.floor(maxChars * 0.6)
        const tailLen = Math.floor(maxChars * 0.3)
        truncated = truncated.slice(0, headLen) + '\n...[中间省略]...\n' + truncated.slice(-tailLen)
        break
      }
      case 'structure': {
        // structure模式：保留首行（通常是JSON元数据）+ 截断内容体
        const firstLineEnd = truncated.indexOf('\n')
        if (firstLineEnd > 0 && firstLineEnd < maxChars * 0.3) {
          const header = truncated.slice(0, firstLineEnd + 1)
          const body = truncated.slice(firstLineEnd + 1)
          truncated = header + body.slice(0, maxChars - header.length)
        } else {
          truncated = truncated.slice(0, maxChars)
        }
        break
      }
      case 'head':
      default:
        truncated = truncated.slice(0, maxChars)
        break
    }
  }

  // 保存完整内容到临时文件
  let filePath: string | undefined
  if (saveTempFile) {
    try {
      filePath = await saveRawToTempFile(rawBody, tempFilePrefix)
    } catch {
      // 保存临时文件失败不影响截断
    }
  }

  // 构建截断提示
  let hintSuffix: string
  if (hint) {
    hintSuffix = '\n\n--- ' + hint + ' ---'
  } else if (saveTempFile && filePath) {
    hintSuffix = `\n\n--- 内容已截断，完整内容已保存到: ${filePath}\n请使用 read_file 工具读取该文件获取完整内容。 ---`
  } else {
    hintSuffix = '\n...[内容已截断]'
  }

  return truncated + hintSuffix
}

/** 工具结果保留策略 */
export type RetentionPolicy = 'always' | 'recent' | 'discard'

/**
 * 工具保留策略配置
 * always: 始终保留rawBody
 * recent: 保留近期（距尾部10条以内），超期清理rawBody
 * discard: 可随时清理rawBody
 */
export const TOOL_RETENTION_POLICIES: Record<string, RetentionPolicy> = {
  memory_search: 'always',
  memory_deep_search: 'always',
  update_memory: 'always',
  edit_file: 'recent',
  read_file: 'recent',
  read_line: 'recent',
  write_file: 'recent',
  terminal: 'discard',
  grep: 'discard',
  list_files: 'discard',
  list_directory: 'discard',
  screenshot: 'discard',
  notification: 'discard',
  ext_invoke: 'discard',
}

/** recent策略的保留距离（距尾部的消息数），从配置读取 */
export const getRecentThreshold = (): number => {
  try {
    return configManager.get('TOOL_RETENTION_RECENT_THRESHOLD')
  } catch {
    return 10
  }
}

/**
 * 应用工具保留策略清理消息
 * 根据工具类型和消息年龄自动清理rawBody
 * @param messages 消息数组
 * @returns 是否修改了任何消息
 */
export const applyRetentionPolicy = (messages: BaseMessage[]): boolean => {
  let modified = false
  const totalLength = messages.length

  for (let idx = 0; idx < totalLength; idx++) {
    const msg = messages[idx]
    if (!ToolMessage.isInstance(msg)) continue

    const policy: RetentionPolicy = TOOL_RETENTION_POLICIES[msg.name || ''] || 'recent'
    const age = totalLength - idx

    // always策略：不清理
    if (policy === 'always') continue

    // recent策略：近期不清理
    if (policy === 'recent' && age <= getRecentThreshold()) continue

    // discard策略或recent超期：检查是否有rawBody需要清理
    const content = typeof msg.content === 'string' ? msg.content : ''
    const { json, rawBody } = splitToolResponse(content)
    if (!rawBody) continue

    modified = true
    // 直接修改原对象（不新建ToolMessage，共享引用自动同步）
    msg.content = json
  }

  return modified
}

/** 工具裁剪策略 */
export interface ToolTrimStrategy {
  /** 源头截断最大字符数（工具执行时） */
  maxSourceChars: number
  /** 上下文中的最大字符数（构建上下文时） */
  maxContextChars: number
  /** 历史消息中的最大字符数（加载历史时） */
  maxHistoryChars: number
  /** 截断模式 */
  trimMode: TrimMode
}

/**
 * 工具类型裁剪策略配置（硬编码默认值）
 * key为工具名称，_default为默认策略
 * @deprecated 使用 getToolTrimStrategy() 从配置中心动态获取
 */
export const TOOL_TRIM_STRATEGIES: Record<string, ToolTrimStrategy> = {
  // 文件读取：内容重要，保留较多
  read_file: {
    maxSourceChars: 10240,
    maxContextChars: 5000,
    maxHistoryChars: 500,
    trimMode: 'structure',
  },
  // 文件搜索：匹配列表重要，内容可截断
  grep: {
    maxSourceChars: 10240,
    maxContextChars: 3000,
    maxHistoryChars: 500,
    trimMode: 'structure',
  },
  // 终端输出：最新输出重要，保留尾部
  terminal: {
    maxSourceChars: 10240,
    maxContextChars: 3000,
    maxHistoryChars: 200,
    trimMode: 'tail',
  },
  // 记忆搜索：结果重要，尽量保留完整
  memory_search: {
    maxSourceChars: 5000,
    maxContextChars: 5000,
    maxHistoryChars: 2000,
    trimMode: 'head',
  },
  memory_deep_search: {
    maxSourceChars: 5000,
    maxContextChars: 5000,
    maxHistoryChars: 2000,
    trimMode: 'head',
  },
  // 文件编辑：结果通常很小，保留完整
  edit_file: {
    maxSourceChars: 2000,
    maxContextChars: 2000,
    maxHistoryChars: 500,
    trimMode: 'head',
  },
  // 截图：图片数据体积大但价值低
  screenshot: {
    maxSourceChars: 2000,
    maxContextChars: 1000,
    maxHistoryChars: 200,
    trimMode: 'head',
  },
  // 默认策略
  _default: {
    maxSourceChars: 10240,
    maxContextChars: 3000,
    maxHistoryChars: 500,
    trimMode: 'head',
  },
}

/**
 * 获取工具裁剪策略
 * 优先从配置中心读取，支持运行时动态更新
 * @param toolName 工具名称
 * @returns 裁剪策略
 */
export function getToolTrimStrategy(toolName: string): ToolTrimStrategy {
  // 从配置中心获取配置
  const config = settingManager.getToolTruncationConfig()
  const strategy = config.strategies[toolName]

  if (strategy) {
    // 使用配置中的策略
    return {
      maxSourceChars: strategy.maxChars ?? config.defaultMaxChars,
      maxContextChars: strategy.maxChars ?? config.defaultMaxChars,
      maxHistoryChars: 500,
      trimMode: strategy.mode ?? config.defaultMode,
    }
  }

  // 回退到硬编码默认值
  return TOOL_TRIM_STRATEGIES[toolName] || TOOL_TRIM_STRATEGIES._default
}

export interface TruncateExistingOptions {
  maxChars?: number
  maxLines?: number
  hint?: string
}

/**
 * 对已有的工具响应进行截断处理
 * 如果内容超出限制，将完整内容保存到临时文件并返回截断后的响应
 * @param response 完整的工具响应字符串
 * @param options 截断选项
 * @returns 处理后的响应字符串
 */
export async function truncateExistingResponse(
  response: string,
  options: TruncateExistingOptions = {},
): Promise<string> {
  const { maxChars, maxLines, hint } = options

  const { json, rawBody } = splitToolResponse(response)

  if (!rawBody) {
    return response
  }

  const accumulator = new ContentAccumulator(maxChars, maxLines)
  const exceeded = accumulator.append(rawBody)

  if (!exceeded) {
    return response
  }

  // 使用统一截断函数
  const trimmedRaw = await trimRawBody(rawBody, {
    maxChars: maxChars ?? accumulator.getMaxChars(),
    maxLines: maxLines ?? accumulator.getMaxLines(),
    hint,
  })

  return json + TOOL_RESPONSE_SEPARATOR + trimmedRaw
}
