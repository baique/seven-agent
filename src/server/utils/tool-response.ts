/**
 * 工具响应创建模块
 * 提供统一的工具响应创建方法
 */

import { env } from '../config/env'
import { logger } from './logger'
import { safeStringify } from './index'
import { trimRawBody, getToolTrimStrategy, TOOL_RESPONSE_SEPARATOR } from './tool-response-parser'

export interface ToolResultOptions {
  body?: string
  msg: string
  extra?: Record<string, unknown>
}

export interface ToolResult {
  success: boolean
  msg: string
  extra?: Record<string, unknown>
}

function formatResponse(result: ToolResult, body?: string): string {
  const response = {
    success: result.success,
    desc: result.msg.replace(/\n/g, '\\n'),
    ...result.extra,
  }

  const jsonPart = safeStringify(response)
  return jsonPart + TOOL_RESPONSE_SEPARATOR + (body ?? '')
}

export const ToolResult = {
  async success(toolName: string, options: ToolResultOptions, useTrim = true): Promise<string> {
    const { body, msg, extra } = options

    if (!body) {
      return formatResponse({ success: true, msg, extra })
    }

    if (!useTrim) {
      return formatResponse({ success: true, msg, extra }, body)
    }
    const strategy = toolName ? getToolTrimStrategy(toolName) : null
    const maxChars = strategy?.maxSourceChars ?? env.FILE_READ_MAX_CHARS
    const maxLines = (strategy as any)?.maxLines ?? env.FILE_READ_MAX_LINES
    const mode = strategy?.trimMode ?? 'head'

    const trimmedBody = await trimRawBody(body, { maxChars, maxLines, mode })

    logger.info(
      { originalLength: body.length, truncatedLength: trimmedBody.length, toolName },
      '[truncate] 工具响应已截断',
    )

    return formatResponse({ success: true, msg, extra }, trimmedBody)
  },

  async error(toolName: string, options: ToolResultOptions): Promise<string> {
    const { body, msg, extra } = options
    return formatResponse({ success: false, msg, extra }, body)
  },
}
