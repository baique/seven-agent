/**
 * 消息状态机
 * 集中管理消息处理逻辑，统一处理实时消息流和历史消息加载
 */

import type { Message, RawMessage, ToolCall } from '../types/message'

/** 处理结果 */
export interface ProcessResult {
  /** 处理后的消息（可能为null，如工具消息被合并） */
  /** 是否需要更新已有消息 */
  message: Message | null
  isUpdate: boolean
  /** 需要更新的消息ID */
  updateId?: string
}

/**
 * 消息处理器
 * 统一处理实时消息流和历史消息加载
 */
export class MessageProcessor {
  /** 工具调用映射表 toolCallId -> ToolCall */
  private toolCallMap = new Map<string, ToolCall>()

  /** AI消息映射表 messageId -> Message */
  private aiMessageMap = new Map<string, Message>()

  /** 当前流式消息缓冲 */
  private streamBuffer: Message | null = null

  /**
   * 预注册工具调用
   * 用于在消息处理前预先建立toolCallId到args的映射
   * 确保Tool消息能获取到正确的参数
   * @param id 工具调用ID
   * @param name 工具名称
   * @param args 工具参数
   */
  preRegisterToolCall(id: string, name: string, args: Record<string, unknown>): void {
    if (!id || this.toolCallMap.has(id)) return
    this.toolCallMap.set(id, {
      id,
      name: name || 'unknown',
      args,
      status: 'loading',
    })
  }

  /**
   * 处理单条原始消息
   * 用于实时消息流处理
   * @param raw 原始消息
   * @returns 处理结果
   */
  processMessage(raw: RawMessage): ProcessResult {
    // 工具消息：合并到对应的AI消息
    if (raw.type === 'tool') {
      return this.processToolMessage(raw)
    }

    // AI消息：处理toolCalls并建立映射
    if (raw.type === 'ai') {
      return this.processAIMessage(raw)
    }

    // 其他消息：直接转换
    return {
      message: this.convertToMessage(raw),
      isUpdate: false,
    }
  }

  /**
   * 处理批量原始消息
   * 用于历史消息加载
   * @param raws 原始消息数组
   * @returns 处理后的消息数组（工具消息已合并）
   */
  processMessages(raws: RawMessage[]): Message[] {
    console.log('[MessageProcessor] processMessages 开始, raws:', raws?.length)
    const result: Message[] = []

    // 预处理：先遍历所有消息，提取AI消息中的toolCalls建立args映射
    // 这样即使Tool消息在AI消息之前处理，也能获取到args
    for (const raw of raws) {
      if (raw.type === 'ai' && raw.toolCalls && raw.toolCalls.length > 0) {
        for (const tc of raw.toolCalls) {
          const id = tc.id || tc.tool_call_id || ''
          if (id && tc.args) {
            // 预先建立toolCall映射，保留args
            const existingToolCall = this.toolCallMap.get(id)
            if (!existingToolCall) {
              this.toolCallMap.set(id, {
                id,
                name: tc.name || 'unknown',
                args: tc.args,
                status: 'loading',
              })
            }
          }
        }
      }
    }

    for (const raw of raws) {
      const processed = this.processMessage(raw)
      if (processed.message) {
        if (processed.isUpdate && processed.updateId) {
          // 更新已有消息
          const idx = result.findIndex((m) => m.id === processed.updateId)
          if (idx !== -1) {
            result[idx] = processed.message
          }
        } else {
          result.push(processed.message)
        }
      }
    }

    console.log('[MessageProcessor] processMessages 返回, result:', result.length)
    return result
  }

  /**
   * 处理AI消息
   * 建立toolCall映射，支持流式更新
   */
  private processAIMessage(raw: RawMessage): ProcessResult {
    const toolCalls: ToolCall[] = []

    // 处理toolCalls
    if (raw.toolCalls && raw.toolCalls.length > 0) {
      for (const tc of raw.toolCalls) {
        const id = tc.id || tc.tool_call_id || ''
        const toolCall: ToolCall = {
          id,
          name: tc.name || 'unknown',
          args: tc.args,
          status: 'loading',
        }
        toolCalls.push(toolCall)
        // 建立映射
        this.toolCallMap.set(id, toolCall)
      }
    }

    // 检查是否已存在该ID的消息（流式更新）
    const existingMsg = this.aiMessageMap.get(raw.id)
    if (existingMsg) {
      // 合并toolCalls：保留已有的，添加新的
      const mergedToolCalls = [...(existingMsg.toolCalls || [])]
      for (const newTc of toolCalls) {
        const existingIdx = mergedToolCalls.findIndex((tc) => tc.id === newTc.id)
        if (existingIdx >= 0) {
          // 更新已有的toolCall：保留已有信息，用新值覆盖（但args只有在新值有内容时才覆盖）
          const existing = mergedToolCalls[existingIdx]
          mergedToolCalls[existingIdx] = {
            ...existing,
            ...newTc,
            // 只有当新args有内容时才更新，避免用空对象覆盖已有值
            args: newTc.args && Object.keys(newTc.args).length > 0 ? newTc.args : existing.args,
          }
        } else {
          // 添加新的toolCall
          mergedToolCalls.push(newTc)
        }
      }

      // 创建新的消息对象（确保响应式更新）
      const updatedMsg: Message = {
        ...existingMsg,
        content: raw.content,
        toolCalls: mergedToolCalls,
        status: raw.status || existingMsg.status,
      }

      // 更新映射
      this.aiMessageMap.set(raw.id, updatedMsg)

      return {
        message: updatedMsg,
        isUpdate: true,
        updateId: raw.id,
      }
    }

    // 新消息
    const newMsg = this.convertToMessage(raw)
    if (toolCalls.length > 0) {
      newMsg.toolCalls = toolCalls
    }

    // 更新AI消息映射
    this.aiMessageMap.set(raw.id, newMsg)
    this.streamBuffer = newMsg

    return {
      message: newMsg,
      isUpdate: false,
    }
  }

  /**
   * 处理工具消息
   * 将结果合并到对应的AI消息的toolCall中
   */
  private processToolMessage(raw: RawMessage): ProcessResult {
    const toolCallId = raw.toolCallId
    if (!toolCallId) {
      return { message: null, isUpdate: false }
    }

    // 查找包含该toolCall的AI消息
    let targetMsg: Message | null = null
    let targetMsgId: string | null = null

    for (const [msgId, msg] of this.aiMessageMap) {
      if (msg.toolCalls?.some((tc) => tc.id === toolCallId)) {
        targetMsg = msg
        targetMsgId = msgId
        break
      }
    }

    if (targetMsg && targetMsgId) {
      // 创建新的消息对象以确保响应式更新
      const updatedMsg: Message = {
        ...targetMsg,
        toolCalls: targetMsg.toolCalls?.map((tc) => {
          if (tc.id === toolCallId) {
            return {
              ...tc,
              result: this.parseToolResult(raw.content),
              status: raw.status || 'success',
            }
          }
          return tc
        }),
      }
      // 更新映射
      this.aiMessageMap.set(targetMsgId, updatedMsg)
      // 更新toolCallMap
      const toolCall = this.toolCallMap.get(toolCallId)
      if (toolCall) {
        toolCall.result = this.parseToolResult(raw.content)
        toolCall.status = raw.status || 'success'
      }
      return { message: updatedMsg, isUpdate: true, updateId: targetMsgId }
    }

    // 在toolCallMap中查找并更新
    const toolCall = this.toolCallMap.get(toolCallId)
    if (toolCall) {
      toolCall.result = this.parseToolResult(raw.content)
      toolCall.status = raw.status || 'success'
    }

    // 仍未找到对应的AI消息，创建新的toolCall并添加到最近的AI消息
    const lastAIMessage = this.findLastAIMessage()
    if (lastAIMessage) {
      // 尝试从toolCallMap获取预处理时保存的args
      const preprocessedToolCall = this.toolCallMap.get(toolCallId)
      const newToolCall: ToolCall = {
        id: toolCallId,
        name: raw.name || preprocessedToolCall?.name || 'unknown',
        args: preprocessedToolCall?.args || {},
        result: this.parseToolResult(raw.content),
        status: raw.status || 'success',
      }
      const updatedMsg: Message = {
        ...lastAIMessage,
        toolCalls: [...(lastAIMessage.toolCalls || []), newToolCall],
      }
      this.aiMessageMap.set(lastAIMessage.id, updatedMsg)
      this.toolCallMap.set(toolCallId, newToolCall)
      return { message: updatedMsg, isUpdate: true, updateId: lastAIMessage.id }
    }

    return { message: null, isUpdate: false }
  }

  /**
   * 解析工具结果
   */
  private parseToolResult(content: string): unknown {
    try {
      return JSON.parse(content)
    } catch {
      return content
    }
  }

  /**
   * 查找最后一条AI消息
   */
  private findLastAIMessage(): Message | null {
    let last: Message | null = null
    for (const msg of this.aiMessageMap.values()) {
      if (msg.type === 'ai') {
        last = msg
      }
    }
    return last
  }

  /**
   * 转换原始消息为渲染消息
   */
  private convertToMessage(raw: RawMessage): Message {
    return {
      id: raw.id,
      type: raw.type,
      content: raw.content,
      toolCallId: raw.toolCallId,
      status: raw.status,
      isSubagent: raw.isSubagent,
      timestamp: raw.timestamp,
    }
  }

  /**
   * 重置状态
   * 清空所有映射和缓冲
   */
  reset(): void {
    this.toolCallMap.clear()
    this.aiMessageMap.clear()
    this.streamBuffer = null
  }

  /**
   * 获取当前流式缓冲
   */
  getStreamBuffer(): Message | null {
    return this.streamBuffer
  }

  /**
   * 清空流式缓冲
   */
  clearStreamBuffer(): void {
    this.streamBuffer = null
  }
}

/** 全局消息处理器实例 */
export const messageProcessor = new MessageProcessor()
