/**
 * 摘要解析模块
 * 解析摘要模型输出，提取结构化信息
 */

import { BaseMessage, ToolMessage, AIMessage } from '@langchain/core/messages'
import { logger } from '../../utils/logger'
import type { SessionNotes, SceneBoundary, RememberOperation, TaskSkillBinding } from './types'
import { removeThinkTags } from '../../utils'

/**
 * 从内容中提取 JSON 对象
 * 处理 markdown 代码块和纯 JSON 两种格式
 */
const extractJson = (content: string): string | null => {
  content = content.trim()

  if (content.startsWith('```json')) {
    const startIndex = content.indexOf('\n')
    if (startIndex === -1) return null

    const jsonContent = content.substring(startIndex + 1)

    const endMatch = jsonContent.match(/```\s*/)
    if (endMatch) {
      const endIndex = jsonContent.indexOf(endMatch[0])
      if (endIndex !== -1) {
        return jsonContent.substring(0, endIndex).trim()
      }
    }

    return jsonContent.trim()
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/)
  return jsonMatch ? jsonMatch[0] : null
}

/** 默认空场景边界 */
const EMPTY_SCENE_BOUNDARY: SceneBoundary = {
  hasTransition: false,
  transitionId: '',
  reason: '',
}

/**
 * 解析场景边界字段
 * @param data LLM输出的sceneBoundary对象
 * @returns 结构化的SceneBoundary
 */
const parseSceneBoundary = (data: any): SceneBoundary => {
  if (!data || typeof data !== 'object') return { ...EMPTY_SCENE_BOUNDARY }
  return {
    hasTransition: data.hasTransition === true,
    transitionId: typeof data.transitionId === 'string' ? data.transitionId : '',
    reason: typeof data.reason === 'string' ? data.reason : '',
  }
}

/**
 * 解析记忆操作
 * @param data LLM输出的remember数组
 * @returns 结构化的RememberOperation数组
 */
const parseRememberOperations = (data: any[]): RememberOperation[] => {
  if (!Array.isArray(data)) return []

  return data
    .filter((op) => op && typeof op === 'object' && op.action)
    .map((op) => ({
      action: op.action as 'add' | 'remove' | 'update',
      id: typeof op.id === 'string' ? op.id : undefined,
      content: typeof op.content === 'string' ? op.content : undefined,
      importance: typeof op.importance === 'number' ? op.importance : undefined,
    }))
}

/**
 * 解析任务技能绑定
 * @param data LLM输出的taskSkillBindings数组
 * @returns 结构化的TaskSkillBinding数组
 */
const parseTaskSkillBindings = (data: any[]): TaskSkillBinding[] => {
  if (!Array.isArray(data)) return []

  return data
    .filter((b) => b && typeof b === 'object' && b.taskId)
    .map((b) => ({
      taskId: String(b.taskId),
      skills: Array.isArray(b.skills) ? b.skills.map(String) : [],
    }))
}

/**
 * 解析会话笔记模型输出
 * 优先使用 JSON 解析，失败则回退到纯文本
 * @param content LLM 返回的原始内容
 * @returns 结构化的 SessionNotes 对象
 */
export const parseSessionNotes = (content: string): SessionNotes => {
  try {
    content = removeThinkTags(content)

    const jsonStr = extractJson(content)
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr)

      return {
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
        remember: parseRememberOperations(parsed.remember),
        taskSkillBindings: parseTaskSkillBindings(parsed.taskSkillBindings),
        sceneBoundary: parseSceneBoundary(parsed.sceneBoundary),
      }
    }
  } catch (e) {
    logger.warn(
      `[会话笔记解析] JSON 解析失败，使用文本解析，原始错误: ${(e as Error).message}\n${content}`,
    )
  }

  // 解析失败回退
  return {
    notes: content,
    remember: [],
    taskSkillBindings: [],
    sceneBoundary: { ...EMPTY_SCENE_BOUNDARY },
  }
}

/**
 * 从消息列表中提取工具调用信息
 * 返回包含 id 字段的工具调用列表，用于清理指令
 */
export const extractToolCalls = (
  messages: BaseMessage[],
): Array<{ id: string; tool: string; params: string; result: string }> => {
  const toolCalls: Array<{ id: string; tool: string; params: string; result: string }> = []

  for (const msg of messages) {
    if (ToolMessage.isInstance(msg)) {
      toolCalls.push({
        id: msg.tool_call_id || '',
        tool: msg.name || 'unknown',
        params: '',
        result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })
    } else if (AIMessage.isInstance(msg) && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.name) {
          const existing = toolCalls.find((t) => t.tool === tc.name)
          if (!existing) {
            toolCalls.push({
              id: tc.id || '',
              tool: tc.name,
              params: JSON.stringify(tc.args || {}).substring(0, 100),
              result: '（等待返回）',
            })
          }
        }
      }
    }
  }

  return toolCalls
}
