import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'
import type { MemoryMessage } from '../memory'
import { nanoid } from 'nanoid'
import { configManager } from '../config/env'

/**
 * 截断工具响应内容
 * 用于处理过长的工具响应，特别是包含图片数据的情况
 * 感知 json + \n---\n + rawBody 格式，对rawBody部分截断，保留json元数据
 * @param content 工具响应内容
 * @returns 截断后的内容
 */
export function truncateToolResponse(content: string): string {
  if (!content || content.length < 500) {
    return content
  }

  try {
    const parsed = JSON.parse(content)

    if (parsed.type === 'image_url' && parsed.image_url?.url) {
      return JSON.stringify({
        type: 'image_url',
        image_url: { url: '[图片数据已省略]' },
        metadata: parsed.metadata || {},
      })
    }

    if (parsed.imageBase64 || parsed.image_base64) {
      const result: Record<string, any> = { ...parsed }
      delete result.imageBase64
      delete result.image_base64
      result._note = '图片数据已省略'
      return JSON.stringify(result)
    }
  } catch (_) {
    // 忽略解析错误，保持原始内容
  }

  if (typeof content === 'string' && content.includes('data:image')) {
    return '[图片数据已省略]'
  }

  // 感知 json + \n---\n + rawBody 格式：对rawBody部分截断，保留json元数据
  const separatorIndex = content.indexOf('\n---\n')
  if (separatorIndex !== -1) {
    const jsonPart = content.substring(0, separatorIndex)
    const rawBody = content.substring(separatorIndex + 5)
    // 历史消息中rawBody截断到FILE_READ_MAX_CHARS的一半
    const historyMaxChars = Math.floor(configManager.get('FILE_READ_MAX_CHARS') / 2)
    if (rawBody.length > historyMaxChars) {
      return jsonPart + '\n---\n' + rawBody.substring(0, historyMaxChars) + '\n...[内容已截断]'
    }
    return content
  }

  // 非格式化内容，超阈值截断
  const historyMaxChars = Math.floor(configManager.get('FILE_READ_MAX_CHARS') / 2)
  if (content.length > historyMaxChars) {
    return content.substring(0, historyMaxChars) + '\n...[内容已截断]'
  }

  return content
}

/**
 * 掩码文件内容
 * 用于在持久化时掩码文件内容，避免占用过多存储空间
 * @param content 工具响应内容
 * @returns 掩码后的内容
 */
export function maskFileContent(content: string): string {
  try {
    const parsed = JSON.parse(content)
    if (parsed.tool === 'read' && parsed.success && parsed.content) {
      return JSON.stringify({
        tool: 'read',
        success: true,
        filePath: parsed.filePath,
        totalLines: parsed.totalLines,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        masked: true,
        hint: '文件内容已掩码，使用 reload_file_content 工具重新读取',
      })
    }
  } catch (_) {
    // 忽略解析错误，保持原始内容
  }
  return content
}

/**
 * 转换MemoryMessage数组为BaseMessage数组
 * 用于将存储的消息转换为LangChain消息格式
 * @param messages MemoryMessage数组
 * @param maskFileContent 是否对文件内容进行掩码（用于历史消息），默认false
 * @returns BaseMessage数组
 */
export function convertMemoryMessageToBaseMessages(
  messages: MemoryMessage[],
  mask = false,
): BaseMessage[] {
  const newMessages: BaseMessage[] = []

  messages.forEach((message) => {
    let msg: BaseMessage | null = null
    const suffixMessage: BaseMessage[] = []
    let aiContent = message.content

    if (message.type === 'ai' && aiContent) {
      try {
        const parsed = JSON.parse(aiContent)
        if (parsed && typeof parsed === 'object' && parsed.output) {
          aiContent = JSON.stringify(parsed.output)
        } else if (parsed && typeof parsed === 'object' && parsed.commands) {
          aiContent = JSON.stringify(parsed.commands)
        }
      } catch (_) {
        // 忽略解析错误，保持原始内容
      }
    }

    switch (message.type) {
      case 'human':
        msg = new HumanMessage(message.content)
        break
      case 'system':
        msg = new SystemMessage(message.content)
        break
      case 'ai': {
        const normalizedToolCalls = (message.toolCalls || []).map((tc: any) => {
          let args = tc.args
          if (args && typeof args === 'object') {
            const keys = Object.keys(args)
            if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
              let combined = ''
              for (let i = 0; i < keys.length; i++) {
                combined += (args as any)[i] || ''
              }
              try {
                args = JSON.parse(combined)
              } catch {
                args = combined
              }
            }
          } else if (typeof args === 'string') {
            try {
              args = JSON.parse(args)
            } catch (_) {
              // 忽略解析错误，保持原始内容
            }
          }
          return { ...tc, args }
        })
        msg = new AIMessage({
          content: message.content,
          tool_calls: normalizedToolCalls,
          additional_kwargs:
            normalizedToolCalls.length > 0 ? { tool_calls: normalizedToolCalls } : {},
        })
        break
      }
      case 'tool': {
        let toolContent = message.content
        toolContent = truncateToolResponse(toolContent)
        if (mask) {
          toolContent = maskFileContent(toolContent)
        }
        msg = new ToolMessage({
          content: toolContent,
          tool_call_id: message.toolCallId as string,
          name: message.name,
          status: message.status,
        })
        break
      }
    }
    if (msg) {
      msg.id = message.id
      ;(msg as { timestamp?: number }).timestamp = message.timestamp
      newMessages.push(msg)
      suffixMessage.forEach((m) => newMessages.push(m))
    }
  })
  return newMessages
}

/**
 * 转换BaseMessage为MemoryMessage
 * 用于将LangChain消息转换为存储格式
 * @param msg BaseMessage消息
 * @returns MemoryMessage或null
 */
export function convertBaseMessageToMemoryMessage(msg: any): MemoryMessage | null {
  const timestamp = Date.now()

  if (HumanMessage.isInstance(msg)) {
    const content = typeof msg.content === 'string' ? msg.content : ''
    return {
      id: msg.id || `human-${nanoid(8)}`,
      type: 'human',
      content,
      timestamp,
    }
  }

  if (SystemMessage.isInstance(msg)) {
    return {
      id: msg.id || `system-${nanoid(8)}`,
      type: 'system',
      content: typeof msg.content === 'string' ? msg.content : '',
      timestamp,
    }
  }

  if (AIMessage.isInstance(msg)) {
    const toolCalls = msg.tool_calls || []

    if (toolCalls.length > 0 && toolCalls.length === 0 && !msg.content) {
      return null
    }

    return {
      id: msg.id || `ai-${nanoid(8)}`,
      type: 'ai',
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls,
      timestamp,
    }
  }

  if (ToolMessage.isInstance(msg)) {
    return {
      id: msg.id || `tool-${nanoid(8)}`,
      type: 'tool',
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCallId: msg.tool_call_id,
      name: msg.name,
      status: msg.status,
      timestamp,
    }
  }

  return null
}

/**
 * 查找工具调用配对
 * 用于建立AI消息中的工具调用与Tool消息的关联关系
 * @param messages 消息数组
 * @returns 工具调用ID到消息索引的映射
 */
export function findToolCallPairs(messages: any[]): Map<string, number> {
  const toolCallToMessageIndex = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolCallToMessageIndex.set(tc.id, i)
        }
      }
    }
    if (ToolMessage.isInstance(msg) && msg.tool_call_id) {
      const aiIndex = toolCallToMessageIndex.get(msg.tool_call_id)
      if (aiIndex !== undefined) {
        toolCallToMessageIndex.set(msg.tool_call_id, aiIndex)
      }
    }
  }

  return toolCallToMessageIndex
}

/**
 * 滑动窗口消息处理
 * 保留最近的消息，同时确保工具调用配对的完整性
 * @param messages 消息数组
 * @param keepCount 保留的消息数量
 * @returns 处理后的消息数组
 */
export function slidingWindowMessages(messages: any[], keepCount: number): any[] {
  if (messages.length <= keepCount) {
    return messages
  }

  const toolCallPairs = findToolCallPairs(messages)
  const keepFromIndex = messages.length - keepCount
  const result: any[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (i >= keepFromIndex) {
      result.push(msg)
      continue
    }

    if (ToolMessage.isInstance(msg) && msg.tool_call_id) {
      const aiIndex = toolCallPairs.get(msg.tool_call_id)
      if (aiIndex !== undefined && aiIndex >= keepFromIndex) {
        result.push(msg)
        continue
      }
    }
  }

  return result
}
