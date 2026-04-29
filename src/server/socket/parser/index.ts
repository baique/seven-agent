import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { MemoryMessage } from '../../memory'
import { CharacterStateManager } from '../../core/state/context/impl/character-state'
import type { WebSocket } from 'ws'
import { logger, splitTextWithTags, removeThinkTags } from '../../utils'
import { StreamingTTSBuffer } from '../../utils/streaming-tts-buffer'
import type { OutputCommand, StateInTTS, TTSCommand } from '../../core/nodes/llm-structured'
import { CHARACTER_STATES } from '../../core/dict/face_and_act'
import { nanoid } from 'nanoid'
import { env } from '../../config/env'

const mentionRoutes: Record<string, string> = (() => {
  const routes = env.MENTION_ROUTES
  if (!routes) return {}
  const result: Record<string, string> = {}
  for (const part of routes.split(',')) {
    const idx = part.indexOf(':')
    if (idx > 0) {
      const name = part.substring(0, idx).trim()
      const address = part.substring(idx + 1).trim()
      if (name && address) {
        result[name] = address
      }
    }
  }
  console.log('[Parser] 艾特路由配置:', result)
  return result
})()

export interface StateCommandLite {
  type: 1 | 2 | 3
  id: string
  intensity?: number
  duration?: 'persistent' | 'instant'
}

export interface TTSData {
  type: 'audio'
  text: string
  speed: string
  id?: string
  timeline: (StateCommandLite | TTSData)[]
  pauseAfter?: number
  batchId?: string
  batchIndex?: number
  isBatchComplete?: boolean
}

export interface ToolCallData {
  toolName: string
  text: string
  audioData?: string
  toolCallId?: string
  content?: string
}

export interface ParameterData {
  id: string
  value: number
  duration?: number
}

/** 流式工具调用记录 - 用于累积流式返回的 tool_call */
interface StreamingToolCall {
  id: string
  tool_call_id: string
  name: string
  /** LangChain 的 index，用于匹配后续 chunk */
  index: number
  /** 累积的参数字符串（流式返回时分段拼接） */
  argsString: string
  /** 解析后的参数对象 */
  args?: Record<string, unknown>
}

/** 流式消息记录 */
interface StreamingRecord {
  content: string
  toolCalls: StreamingToolCall[]
}

function stripJsonCommands(content: string): string {
  const jsonRegex = /\{[^{}]*"type"\s*:\s*"(tts|pause|state|face|act|task)"[^{}]*\}/g
  return content.replace(jsonRegex, '').trim()
}

export class LLMResponseParser {
  private sm: CharacterStateManager
  private requestId: string
  private socket: WebSocket
  private currentMessages: MemoryMessage[] = []
  private aiMessageCache: Record<string, MemoryMessage> = {}
  private processedCommands: Set<string> = new Set()

  /** 正在流式传输的消息记录 messageId -> StreamingRecord */
  private streamingMessages = new Map<string, StreamingRecord>()
  /** 流式TTS缓冲区 messageId -> StreamingTTSBuffer */
  private streamingTTSBuffers = new Map<string, StreamingTTSBuffer>()

  constructor(sm: CharacterStateManager, requestId: string, socket: WebSocket) {
    this.sm = sm
    this.requestId = requestId
    this.socket = socket
  }

  reset(): void {
    this.currentMessages = []
    this.aiMessageCache = {}
    this.processedCommands.clear()
    this.streamingMessages.clear()
    this.streamingTTSBuffers.clear()
  }

  addHumanMessage(content: string): void {
    this.currentMessages.push({
      id: `human-${nanoid(8)}`,
      type: 'human',
      content,
      timestamp: Date.now(),
    })
  }

  parseChunk(chunk: any): void {
    // 处理 streamMode: ['updates', 'messages'] 返回的元组格式 [mode, data]
    if (Array.isArray(chunk) && chunk.length === 2) {
      const [mode, data] = chunk

      if (mode === 'messages') {
        // messages 模式: [messageChunk, metadata]
        const [messageChunk, metadata] = data

        this.handleStreamingToken(messageChunk, metadata)
        return
      }

      if (mode === 'updates') {
        // updates 模式: 原来的节点更新逻辑
        this.handleUpdates(data)
        return
      }
    }

    // 兼容旧格式（直接传递 updates 数据）
    this.handleUpdates(chunk)
  }

  /**
   * 处理 updates 类型的数据（节点状态更新）
   */
  private handleUpdates(data: any): void {
    if (data['toolNode']?.messages) {
      const messages = data['toolNode'].messages as ToolMessage[]
      for (const msg of messages) {
        this.handleToolMessage(msg)
      }
    } else if (data['taskNode']?.messages) {
      const messages = data['taskNode'].messages as HumanMessage[]
      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          const taskMsg: MemoryMessage = {
            id: `task-${nanoid(8)}`,
            type: 'tool',
            name: msg.name,
            toolCallId: (msg as { tool_call_id?: string }).tool_call_id,
            content: msg.content,
            timestamp: Date.now(),
          }
          this.sm.sendMessage(this.requestId, this.socket, taskMsg)
        }
      }
    } else if (data['llmCall'] && data['llmCall']['messages']?.length) {
      // llmCall 节点完成，检查是否有流式消息需要标记为完成
      const msg = data['llmCall']['messages'].at(-1)
      const id = msg.id as string
      if (id && this.streamingMessages.has(id)) {
        this.finalizeMessage(id, 'success')
      } else {
        // 非流式消息，使用原有逻辑
        this.handleAIMessageChunk([msg])
      }
    }
  }

  /**
   * 处理流式 token（打字机效果）
   * messages 模式返回 [messageChunk, metadata]
   */
  private handleStreamingToken(messageChunk: any, metadata: any): void {
    // 只处理来自 llmCall 节点的消息（主对话）
    if (metadata?.langgraph_node !== 'llmCall') {
      return
    }

    const id = messageChunk.id as string
    if (!id) return

    const chunkContent = (messageChunk.content as string) || ''

    // 获取或创建流式记录
    let record = this.streamingMessages.get(id)
    if (!record) {
      record = {
        content: '',
        toolCalls: [],
      }
      this.streamingMessages.set(id, record)
    }

    // 获取或创建流式TTS缓冲区
    let ttsBuffer = this.streamingTTSBuffers.get(id)
    if (!ttsBuffer) {
      ttsBuffer = new StreamingTTSBuffer()
      this.streamingTTSBuffers.set(id, ttsBuffer)
    }

    // 累积内容
    if (chunkContent) {
      record.content += chunkContent
    }

    // 处理 LangChain 流式返回的 tool_call_chunks
    // 参考真实日志：LangChain 使用 tool_call_chunks，第一次有 id 和 name，后续只有 index 和 args
    const toolCallChunks = messageChunk.tool_call_chunks || []
    if (toolCallChunks.length > 0) {
      // logger.info({ rawToolCallChunks: toolCallChunks }, '[Parser:RAW] tool_call_chunks')

      for (const chunk of toolCallChunks) {
        const toolCallIndex = chunk.index ?? 0
        const argsChunk = chunk.args || ''
        // 第一次 chunk 有 id 和 name，后续没有
        const realToolCallId = chunk.id || ''
        const toolName = chunk.name || ''

        // logger.info(
        //   { toolCallIndex, realToolCallId, toolName, argsChunk },
        //   '[Parser:RAW] 处理 chunk',
        // )

        // 先用 index 查找是否已存在
        let existingIndex = record.toolCalls.findIndex((t) => t.index === toolCallIndex)

        if (existingIndex >= 0) {
          // 更新已有的 toolCall：累积参数字符串
          const existing = record.toolCalls[existingIndex]
          if (argsChunk) {
            existing.argsString += argsChunk
            // 尝试解析完整的参数
            try {
              existing.args = JSON.parse(existing.argsString)
              logger.info(
                { toolCallId: existing.id, args: existing.args, argsString: existing.argsString },
                '[Parser:RAW] 参数解析成功',
              )
            } catch {
              // 参数还不完整，继续累积
            }
          }
        } else {
          // 添加新的 toolCall，使用真实的 tool_call_id（如果有）
          const toolCallId = realToolCallId || `call_${id}_${toolCallIndex}`
          const argsString = argsChunk
          let args: Record<string, unknown> | undefined
          try {
            args = JSON.parse(argsString)
          } catch {
            // 参数还不完整，等待后续累积
          }
          record.toolCalls.push({
            id: toolCallId,
            tool_call_id: toolCallId,
            name: toolName || 'unknown',
            index: toolCallIndex,
            argsString,
            args,
          })
        }
      }
    }

    // 转换为前端期望的格式（只发送有完整 args 的 toolCalls）
    const completedToolCalls = record.toolCalls
      .filter((tc) => tc.args && Object.keys(tc.args).length > 0)
      .map((tc) => ({
        id: tc.id,
        tool_call_id: tc.tool_call_id,
        name: tc.name,
        args: tc.args,
      }))

    // 更新缓存
    this.aiMessageCache[id] = {
      id,
      type: 'ai',
      content: record.content,
      toolCalls: completedToolCalls,
      timestamp: Date.now(),
    }

    // 流式TTS处理：累积内容并适时生成TTS命令
    if (chunkContent) {
      const ttsCommands = ttsBuffer.append(chunkContent)
      if (ttsCommands.length > 0) {
        this.processStructuredCommands(ttsCommands)
      }
    }

    // 当检测到完整的工具调用时，立即刷新TTS缓冲区
    // 避免工具调用完成前的文本被延迟到工具执行后才合成
    const hasCompletedToolCalls = completedToolCalls.length > 0
    if (hasCompletedToolCalls && ttsBuffer) {
      const remainingCommands = ttsBuffer.finalize()
      if (remainingCommands && remainingCommands.length > 0) {
        this.processStructuredCommands(remainingCommands)
      }
      // 重置缓冲区以便后续使用
      ttsBuffer.reset()
    }

    const hasContent = chunkContent && chunkContent.length > 0

    // 只要有内容或有完整的toolCalls就发送
    if (hasContent || hasCompletedToolCalls) {
      this.sm.sendMessage(this.requestId, this.socket, {
        id,
        type: 'ai',
        content: record.content,
        toolCalls: completedToolCalls,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * 标记消息为完成或错误状态
   * @param id 消息ID
   * @param status 最终状态
   * @param errorMessage 错误信息（可选）
   */
  private finalizeMessage(id: string, status: 'success' | 'error', errorMessage?: string): void {
    const record = this.streamingMessages.get(id)
    if (!record) return

    // 构建最终内容
    let finalContent = record.content
    if (status === 'error' && errorMessage) {
      finalContent += `\n\n[${errorMessage}]`
    }

    // 处理剩余TTS内容
    const ttsBuffer = this.streamingTTSBuffers.get(id)
    if (ttsBuffer) {
      const remainingCommands = ttsBuffer.finalize()
      if (remainingCommands.length > 0) {
        this.processStructuredCommands(remainingCommands)
      }
      this.streamingTTSBuffers.delete(id)
    }

    // 发送最终消息
    // 只发送有完整 args 的 toolCalls
    const completedToolCalls = record.toolCalls
      .filter((tc) => tc.args && Object.keys(tc.args).length > 0)
      .map((tc) => ({
        id: tc.id,
        tool_call_id: tc.tool_call_id,
        name: tc.name,
        args: tc.args,
      }))
    this.sm.sendMessage(this.requestId, this.socket, {
      id,
      type: 'ai',
      content: finalContent,
      toolCalls: completedToolCalls,
      status,
      timestamp: Date.now(),
    })

    // 更新缓存
    this.aiMessageCache[id] = {
      id,
      type: 'ai',
      content: finalContent,
      toolCalls: completedToolCalls,
      status,
      timestamp: Date.now(),
    }

    // 清理流式记录
    this.streamingMessages.delete(id)
  }

  /**
   * 中止所有流式消息
   * @param reason 中止原因
   */
  abortAllStreaming(
    reason: 'cancelled' | 'error' | 'connection_lost' | 'timeout' | 'rate_limited',
  ): void {
    const reasonMap = {
      cancelled: '用户取消',
      error: '发生错误',
      connection_lost: '连接断开',
      timeout: '响应超时',
      rate_limited: '请求过于频繁',
    }

    for (const [id] of this.streamingMessages) {
      this.finalizeMessage(id, 'error', reasonMap[reason])
    }
  }

  /**
   * 获取正在流式的消息ID列表
   */
  getStreamingMessageIds(): string[] {
    return Array.from(this.streamingMessages.keys())
  }

  private handleToolMessage(msg: ToolMessage): void {
    if (!ToolMessage.isInstance(msg)) {
      return
    }

    const content = msg.content as string
    const toolCallMsg: MemoryMessage = {
      id: msg.id as string,
      type: 'tool',
      content: content,
      name: msg.name,
      toolCallId: msg.tool_call_id,
      timestamp: Date.now(),
      status: (msg as any).status || 'success',
    }

    this.currentMessages.push(toolCallMsg)

    this.sm.sendMessage(this.requestId, this.socket, toolCallMsg)
  }

  private handleAIMessageChunk(chunk: any): void {
    const chunkItem = chunk[0]
    const id = chunkItem.id as string

    if (!this.aiMessageCache[id]) {
      const msg: MemoryMessage = {
        id: id,
        type: 'ai',
        content: '',
        toolCalls: [],
        timestamp: Date.now(),
      }
      this.aiMessageCache[id] = msg
      this.currentMessages.push(msg)
    }

    let chunkContent = chunkItem.content as string
    if (chunkContent) {
      this.aiMessageCache[id].content += chunkContent
    }

    if (chunkItem.tool_calls && chunkItem.tool_calls.length > 0) {
      this.aiMessageCache[id].toolCalls = chunkItem.tool_calls.map((tc: any) => {
        // 解析参数 - 可能是对象或JSON字符串
        let args = tc.args
        if (!args && tc.function?.arguments) {
          const argStr = tc.function.arguments
          if (typeof argStr === 'string') {
            try {
              args = JSON.parse(argStr)
            } catch {
              args = argStr
            }
          } else {
            args = argStr
          }
        }
        return {
          id: tc.id || tc.tool_call_id || '',
          tool_call_id: tc.id || tc.tool_call_id || '',
          name: tc.name || tc.function?.name || 'unknown',
          args: args || {},
        }
      })
    }

    // 当 content 有值或 tool_calls 有值时发送消息
    const hasToolCalls = chunkItem.tool_calls && chunkItem.tool_calls.length > 0
    if (chunkContent || hasToolCalls) {
      // 移除think标签内容，避免被TTS解析
      if (chunkContent) {
        const contentWithoutThink = removeThinkTags(chunkContent)
        const segList = splitTextWithTags(contentWithoutThink)
        const states: TTSCommand[] = segList.map((seg) => {
          const tags = seg.tag
            .map((tag) => {
              let [action, intensity] = tag.split('-')
              action = action.trim()
              intensity = intensity?.trim() || '1'
              if (CHARACTER_STATES[action]) {
                return {
                  id: action,
                  stateType: CHARACTER_STATES[action].type,
                  intensity: parseInt(intensity, 40),
                } as StateInTTS
              }
              return null
            })
            .filter((item) => item != null)
          return {
            type: 'tts' as const,
            text: seg.text,
            speed: 'stand' as const,
            state: tags,
            pauseAfter: seg.pauseAfter,
          }
        })
        logger.debug(segList, '[LLM] 消息切分结果:')
        if (states) {
          this.processStructuredCommands(states)
        }
        this.checkAndForwardMention(chunkContent)
      }
      this.sm.sendMessage(this.requestId, this.socket, {
        ...this.aiMessageCache[id],
        content: chunkContent || '',
      })
    }
  }

  private processStructuredCommands(commands: OutputCommand[]): void {
    const ttsCommands = commands.filter((cmd): cmd is TTSCommand => cmd.type === 'tts')
    const batchId = ttsCommands.length > 0 ? nanoid() : undefined

    for (const cmd of commands) {
      logger.debug({ cmd }, '[parser] 解析到结构化命令')

      switch (cmd.type) {
        case 'tts': {
          const ttsCmd = cmd as TTSCommand
          const ttsIndex = ttsCommands.indexOf(ttsCmd)
          const timeline = ttsCmd.state
            ?.filter((f): f is NonNullable<typeof f> => !!f)
            .map((s) => ({
              type: s.stateType as 1 | 2 | 3,
              id: s.id,
              intensity: s.intensity,
            }))
          this.sm.addTTS(this.requestId, this.socket, {
            type: 'audio',
            text: ttsCmd.text || '',
            speed: ttsCmd.speed || 'stand',
            timeline: timeline || [],
            pauseAfter: ttsCmd.pauseAfter,
            batchId,
            batchIndex: ttsIndex,
            isBatchComplete: ttsIndex === ttsCommands.length - 1,
          })
          break
        }
        default:
          break
      }
    }
  }

  private checkAndForwardMention(content: string): void {
    const cleanContent = removeThinkTags(content)
    for (const [name, address] of Object.entries(mentionRoutes)) {
      if (cleanContent.includes(`@${name}`)) {
        const fullUrl = `${address.replace(/\/$/, '')}/api/chat`
        const forwardContent = cleanContent.replace(`@${name}`, '').trim()
        const senderName = env.MENTION_SENDER_NAME || ''
        const messageToSend = senderName ? `${senderName}说：${forwardContent}` : forwardContent
        logger.info(`[Parser] 检测到艾特 @${name}，转发到 ${fullUrl}`)
        fetch(fullUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: messageToSend }),
        })
          .then((res) => {
            if (res.ok) {
              logger.info(`[Parser] 艾特转发成功 @${name}`)
            } else {
              logger.warn(`[Parser] 艾特转发失败: ${res.status} @${name}`)
            }
          })
          .catch((err) => {
            logger.error({ err }, `[Parser] 艾特转发异常 @${name}`)
          })
        break
      }
    }
  }

  getDisplayContent(content: string): string {
    return stripJsonCommands(content)
  }

  getCurrentMessages(): MemoryMessage[] {
    return this.currentMessages.filter((f) => {
      return f.content || (f.toolCalls && f.toolCalls.length)
    })
  }

  debugParseAndSend(content: string): void {
    const id = 'debug-' + Date.now().toString()

    this.handleAIMessageChunk([
      {
        id: id,
        content: content,
        tool_calls: [],
        tool_call_chunks: [],
      },
    ])
  }
}
