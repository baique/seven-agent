/**
 * 消息 Token 计数器
 * 统一管理消息的 token 计算、截断和格式化
 */
import { getEncoding } from 'js-tiktoken'
import { removeThinkTags } from './index'
import type { BaseMessage } from '@langchain/core/messages'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'

/** 全局编码器实例，避免重复初始化 */
let encoder: ReturnType<typeof getEncoding> | null = null

/**
 * 获取全局编码器（单例模式）
 * 使用 o200k_base 编码器，适用于 GPT-4 系列模型
 */
function getEncoder() {
  if (!encoder) {
    encoder = getEncoding('o200k_base')
  }
  return encoder
}

/**
 * 计算文本的 token 数量
 * @param text 输入文本
 * @returns token 数量，如果编码失败则按 4 字符约等于 1 token 估算
 */
function countTextTokens(text: string): number {
  if (!text) return 0
  try {
    return getEncoder().encode(text).length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

/** 添加消息后的结果，包含当前计数状态 */
export interface AddMessageResult {
  /** 当前轮数（HumanMessage 数量） */
  rounds: number
  /** 原始 token 总数 */
  tokens: number
  /** 截断后的 token 总数（Tool 消息内容被截断） */
  truncatedTokens: number
  /** 是否还有未配对的 Tool 调用（等待 ToolMessage） */
  needsTool: boolean
  /** 等待配对的 tool_call_id 列表 */
  toolCallIds: string[]
}

/** 消息类型 Token 统计 */
export interface MessageTypeStats {
  /** 用户消息 token 数量 */
  userTokens: number
  /** AI消息 token 数量 */
  aiTokens: number
  /** 工具消息 token 数量 */
  toolTokens: number
  /** 总 token 数量 */
  totalTokens: number
}

/** 消息计数结果 */
export interface CountResult {
  /** 原始 token 总数 */
  totalTokens: number
  /** 截断后的 token 总数 */
  truncatedTokens: number
  /** 消息数量 */
  messageCount: number
  /** 轮数（HumanMessage 数量） */
  roundCount: number
  /** 消息类型统计 */
  typeStats: MessageTypeStats
}

/** 截断结果，包含选中消息和剩余消息 */
export interface TruncateResult {
  /** 被选中的消息 */
  selected: BaseMessage[]
  /** 被移除的消息 */
  remaining: BaseMessage[]
  /** 选中消息的原始 token 数 */
  tokens: number
  /** 选中消息的截断后 token 数 */
  truncatedTokens: number
  /** 选中的轮数 */
  rounds: number
}

/** 格式化选项 */
export interface FormatOptions {
  /** Tool 消息最大行数，超过则截断 */
  toolMaxLines?: number
  /** 是否保留 think 标签内容，默认 true */
  keepThink?: boolean
}

/**
 * 计算单条消息的原始 token 数
 * @param msg 消息对象
 * @returns token 数量
 */
function countSingleMessageTokens(msg: BaseMessage): number {
  let numTokens = 3
  const tokensPerName = 1

  const role = msg.type
  numTokens += countTextTokens(role)

  if (msg.content) {
    numTokens += countTextTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )
  }

  if ('name' in msg && msg.name) {
    numTokens += tokensPerName + countTextTokens(msg.name)
  }

  // 计算 tool_calls 的 token
  if ('tool_calls' in msg && Array.isArray((msg as any).tool_calls)) {
    for (const toolCall of (msg as any).tool_calls) {
      numTokens += countTextTokens(toolCall.name || '')
      if (toolCall.args) {
        numTokens += countTextTokens(JSON.stringify(toolCall.args))
      }
    }
  }

  return numTokens
}

/**
 * 截断Tool消息内容（同步轻量版，不写临时文件）
 * 用于formatForLLM和token计算场景
 * 感知 json + \n---\n + rawBody 格式，对rawBody部分截断，保留json元数据
 * @param content 原始内容
 * @param maxLines 最大行数
 * @returns 截断后的内容
 */
function truncateToolContent(content: string, maxLines: number): string {
  // 感知 json + \n---\n + rawBody 格式
  const separatorIndex = content.indexOf('\n---\n')
  if (separatorIndex !== -1) {
    const jsonPart = content.substring(0, separatorIndex)
    const rawBody = content.substring(separatorIndex + 5)
    const lines = rawBody.split('\n')
    if (lines.length > maxLines) {
      const trimmedRaw = lines.slice(0, maxLines).join('\n') + '\n...(已截断)'
      return jsonPart + '\n---\n' + trimmedRaw
    }
    return content
  }

  // 普通内容
  const lines = content.split('\n')
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + '\n...(已截断)'
  }
  return content
}

/**
 * 计算单条消息的截断后 token 数（Tool 内容被截断）
 * @param msg 消息对象
 * @param toolMaxLines Tool 消息最大行数
 * @returns 截断后的 token 数
 */
function countTruncatedMessageTokens(msg: BaseMessage, toolMaxLines: number): number {
  let numTokens = 3
  const tokensPerName = 1

  const role = msg.type
  numTokens += countTextTokens(role)

  if (msg.content) {
    let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    if (ToolMessage.isInstance(msg)) {
      content = truncateToolContent(content, toolMaxLines)
    }
    numTokens += countTextTokens(content)
  }

  if ('name' in msg && msg.name) {
    numTokens += tokensPerName + countTextTokens(msg.name)
  }

  if ('tool_calls' in msg && Array.isArray((msg as any).tool_calls)) {
    for (const toolCall of (msg as any).tool_calls) {
      numTokens += countTextTokens(toolCall.name || '')
      if (toolCall.args) {
        numTokens += countTextTokens(JSON.stringify(toolCall.args))
      }
    }
  }

  return numTokens
}

/**
 * 消息 Token 计数器
 * 用于追踪缓冲区的消息 token 数量，支持增量计数和 AI+Tool 配对
 */
export class MessageTokenCounter {
  /** 原始 token 总数 */
  private tokens: number = 0
  /** 截断后 token 总数 */
  private truncatedTokens: number = 0
  /** 消息列表 */
  private messages: BaseMessage[] = []
  /** 轮数（user+ai 算一轮） */
  private rounds: number = 0
  /** 等待配对的 tool_call_id */
  private pendingToolCallIds: string[] = []
  /** Tool 消息最大行数（超过则截断） */
  private toolMaxLines: number
  /** 是否有未配对的 HumanMessage（等待 AI 回复） */
  private hasPendingHumanMessage: boolean = false
  /** 用户消息 token 数量 */
  private userTokens: number = 0
  /** AI消息 token 数量 */
  private aiTokens: number = 0
  /** 工具消息 token 数量 */
  private toolTokens: number = 0

  constructor(options?: { toolMaxLines?: number }) {
    this.toolMaxLines = options?.toolMaxLines ?? 300
  }

  /**
   * 添加单条消息到计数器
   * 自动处理 AI+Tool 配对逻辑
   * 轮次计算规则：user+ai 算一轮，连续多条 user 消息只算一轮
   */
  addMessage(msg: BaseMessage): AddMessageResult {
    const rawTokens = countSingleMessageTokens(msg)
    const truncated = countTruncatedMessageTokens(msg, this.toolMaxLines)

    if (HumanMessage.isInstance(msg)) {
      // HumanMessage 标记为等待 AI 回复，不立即增加轮次
      // 连续多条 HumanMessage 也只标记一次
      if (!this.hasPendingHumanMessage) {
        this.hasPendingHumanMessage = true
      }
      this.pendingToolCallIds = []
      this.userTokens += rawTokens
    } else if (AIMessage.isInstance(msg)) {
      // AI 消息回复，如果前面有未配对的 HumanMessage，则完成一轮
      if (this.hasPendingHumanMessage) {
        this.rounds++
        this.hasPendingHumanMessage = false
      }
      // 如果 AI 消息有 tool_calls，记录待配对的 id
      if (msg.tool_calls?.length) {
        this.pendingToolCallIds = msg.tool_calls
          .map((tc) => tc.id)
          .filter((id): id is string => id !== undefined)
      }
      this.aiTokens += rawTokens
    } else if (ToolMessage.isInstance(msg)) {
      // Tool 消息，匹配对应的 tool_call_id
      const idx = this.pendingToolCallIds.indexOf(msg.tool_call_id)
      if (idx !== -1) {
        this.pendingToolCallIds.splice(idx, 1)
      }
      this.toolTokens += rawTokens
    }

    this.messages.push(msg)
    this.tokens += rawTokens
    this.truncatedTokens += truncated

    return {
      rounds: this.rounds,
      tokens: this.tokens,
      truncatedTokens: this.truncatedTokens,
      needsTool: this.pendingToolCallIds.length > 0,
      toolCallIds: [...this.pendingToolCallIds],
    }
  }

  /**
   * 批量添加消息
   */
  addMessages(messages: BaseMessage[]): CountResult {
    for (const msg of messages) {
      this.addMessage(msg)
    }
    return this.getCount()
  }

  /**
   * 获取当前计数结果
   */
  getCount(): CountResult {
    return {
      totalTokens: this.tokens,
      truncatedTokens: this.truncatedTokens,
      messageCount: this.messages.length,
      roundCount: this.rounds,
      typeStats: {
        userTokens: this.userTokens,
        aiTokens: this.aiTokens,
        toolTokens: this.toolTokens,
        totalTokens: this.userTokens + this.aiTokens + this.toolTokens,
      },
    }
  }

  /**
   * 获取消息类型 Token 统计
   */
  getTypeStats(): MessageTypeStats {
    return {
      userTokens: this.userTokens,
      aiTokens: this.aiTokens,
      toolTokens: this.toolTokens,
      totalTokens: this.userTokens + this.aiTokens + this.toolTokens,
    }
  }

  setState(state: {
    tokens: number
    truncatedTokens: number
    rounds: number
    userTokens?: number
    aiTokens?: number
    toolTokens?: number
  }): void {
    this.tokens = state.tokens
    this.truncatedTokens = state.truncatedTokens
    this.rounds = state.rounds
    if (state.userTokens !== undefined) this.userTokens = state.userTokens
    if (state.aiTokens !== undefined) this.aiTokens = state.aiTokens
    if (state.toolTokens !== undefined) this.toolTokens = state.toolTokens
  }

  setMessages(messages: BaseMessage[]): void {
    this.messages = messages
    // 重新计算所有状态，确保与消息列表一致
    this.recalculateStateFromMessages()
  }

  /**
   * 根据消息列表重新计算所有状态
   * 用于从磁盘恢复状态时保持状态一致性
   */
  private recalculateStateFromMessages(): void {
    // 重置计数
    this.tokens = 0
    this.truncatedTokens = 0
    this.rounds = 0
    this.pendingToolCallIds = []
    this.hasPendingHumanMessage = false
    this.userTokens = 0
    this.aiTokens = 0
    this.toolTokens = 0

    // 重新计算
    for (const msg of this.messages) {
      const rawTokens = countSingleMessageTokens(msg)
      this.tokens += rawTokens
      this.truncatedTokens += countTruncatedMessageTokens(msg, this.toolMaxLines)

      if (HumanMessage.isInstance(msg)) {
        if (!this.hasPendingHumanMessage) {
          this.hasPendingHumanMessage = true
        }
        this.pendingToolCallIds = []
        this.userTokens += rawTokens
      } else if (AIMessage.isInstance(msg)) {
        if (this.hasPendingHumanMessage) {
          this.rounds++
          this.hasPendingHumanMessage = false
        }
        if (msg.tool_calls?.length) {
          this.pendingToolCallIds = msg.tool_calls
            .map((tc) => tc.id)
            .filter((id): id is string => id !== undefined)
        }
        this.aiTokens += rawTokens
      } else if (ToolMessage.isInstance(msg)) {
        const idx = this.pendingToolCallIds.indexOf(msg.tool_call_id)
        if (idx !== -1) {
          this.pendingToolCallIds.splice(idx, 1)
        }
        this.toolTokens += rawTokens
      }
    }
  }

  /**
   * 重置计数器
   */
  reset(): void {
    this.tokens = 0
    this.truncatedTokens = 0
    this.messages = []
    this.rounds = 0
    this.pendingToolCallIds = []
    this.hasPendingHumanMessage = false
    this.userTokens = 0
    this.aiTokens = 0
    this.toolTokens = 0
  }

  /**
   * 获取当前所有消息的副本
   */
  getMessages(): BaseMessage[] {
    return [...this.messages]
  }

  /**
   * 获取第一条消息的ID
   * @returns 第一条消息的ID，如果没有消息则返回undefined
   */
  getFirstMessageId(): string | undefined {
    return this.messages[0]?.id
  }

  /** 静态方法：计算单条消息 token */
  static countSingle(msg: BaseMessage): number {
    return countSingleMessageTokens(msg)
  }

  /** 静态方法：计算多条消息 token */
  static countMessages(messages: BaseMessage[]): number {
    let total = 0
    for (const msg of messages) {
      total += countSingleMessageTokens(msg)
    }
    return total
  }

  /** 静态方法：计算单条消息截断后 token */
  static countSingleTruncated(msg: BaseMessage, toolMaxLines: number): number {
    return countTruncatedMessageTokens(msg, toolMaxLines)
  }

  /** 静态方法：计算多条消息截断后 token */
  static countMessagesTruncated(messages: BaseMessage[], toolMaxLines: number): number {
    let total = 0
    for (const msg of messages) {
      total += countTruncatedMessageTokens(msg, toolMaxLines)
    }
    return total
  }

  /**
   * 按 token 数量截断消息
   * @param messages 消息数组
   * @param maxTokens 最大 token 数
   * @param direction 截断方向：start 从开头保留，end 从末尾保留
   * @param options 格式化选项
   */
  static truncate(
    messages: BaseMessage[],
    maxTokens: number,
    direction: 'start' | 'end',
    options?: FormatOptions,
  ): TruncateResult {
    const toolMaxLines = options?.toolMaxLines ?? 300

    if (messages.length === 0) {
      return { selected: [], remaining: [], tokens: 0, truncatedTokens: 0, rounds: 0 }
    }

    if (direction === 'start') {
      return this.truncateFromStart(messages, maxTokens, toolMaxLines)
    } else {
      return this.truncateFromEnd(messages, maxTokens, toolMaxLines)
    }
  }

  /**
   * 从开头截断（保留较早的消息）
   * 逐条加入消息，直到超过 maxTokens
   * 轮次计算规则：user+ai 算一轮
   */
  private static truncateFromStart(
    messages: BaseMessage[],
    maxTokens: number,
    toolMaxLines: number,
  ): TruncateResult {
    const selected: BaseMessage[] = []
    let tokens = 0
    let truncatedTokens = 0
    let rounds = 0
    let pendingToolCallIds: string[] = []
    let hasPendingHumanMessage = false

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const msgTokens = countSingleMessageTokens(msg)
      const msgTruncatedTokens = countTruncatedMessageTokens(msg, toolMaxLines)

      // 更新轮次和待配对状态
      if (HumanMessage.isInstance(msg)) {
        // 标记有未配对的 HumanMessage，不立即增加轮次
        if (!hasPendingHumanMessage) {
          hasPendingHumanMessage = true
        }
        pendingToolCallIds = []
      } else if (AIMessage.isInstance(msg)) {
        // AI 消息回复，完成一轮
        if (hasPendingHumanMessage) {
          rounds++
          hasPendingHumanMessage = false
        }
        if (msg.tool_calls?.length) {
          pendingToolCallIds = msg.tool_calls
            .map((tc) => tc.id)
            .filter((id): id is string => id !== undefined)
        }
      } else if (ToolMessage.isInstance(msg)) {
        const idx = pendingToolCallIds.indexOf(msg.tool_call_id)
        if (idx !== -1) pendingToolCallIds.splice(idx, 1)
      }

      // 超限则停止
      if (tokens + msgTokens > maxTokens && selected.length > 0) {
        break
      }

      selected.push(msg)
      tokens += msgTokens
      truncatedTokens += msgTruncatedTokens
    }

    // 收集剩余的配对 Tool 消息
    selected.push(
      ...this.collectRemainingToolMessages(messages, selected.length, pendingToolCallIds),
    )

    const remaining = messages.slice(selected.length)

    return {
      selected,
      remaining,
      tokens,
      truncatedTokens,
      rounds,
    }
  }

  /**
   * 从末尾截断（保留较新的消息）
   * 从最新消息向前收集，保持 AI+Tool 配对完整
   * 轮次计算规则：user+ai 算一轮（反向遍历时，遇到 HumanMessage 且已收集到 AIMessage 才算一轮）
   */
  private static truncateFromEnd(
    messages: BaseMessage[],
    maxTokens: number,
    toolMaxLines: number,
  ): TruncateResult {
    const selected: BaseMessage[] = []
    let tokens = 0
    let truncatedTokens = 0
    let rounds = 0
    /** 用于去重（避免同一消息被重复处理） */
    const seenMessages = new Set<string>()
    const pendingToolCallIds: string[] = []
    /** 标记是否已收集到 AIMessage（反向遍历先遇到 AI） */
    let hasCollectedAIMessage = false

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]

      // 跳过已处理的消息（先去重）
      if (msg.id && seenMessages.has(msg.id)) continue
      if (msg.id) seenMessages.add(msg.id)

      const msgTokens = countSingleMessageTokens(msg)
      const msgTruncatedTokens = countTruncatedMessageTokens(msg, toolMaxLines)

      // 超限则停止
      if (tokens + msgTokens > maxTokens && selected.length > 0) {
        break
      }

      // Tool 消息加入待配对队列
      if (ToolMessage.isInstance(msg)) {
        pendingToolCallIds.push(msg.tool_call_id)
      } else if (AIMessage.isInstance(msg)) {
        // AI 消息，将其 tool_call 与待配对队列匹配
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            if (tc.id) {
              const idx = pendingToolCallIds.indexOf(tc.id)
              if (idx !== -1) pendingToolCallIds.splice(idx, 1)
            }
          }
        }
        // 标记已收集到 AI 消息，等待配对的 HumanMessage
        hasCollectedAIMessage = true
      } else if (HumanMessage.isInstance(msg)) {
        // HumanMessage：如果已收集到 AI 消息，则完成一轮
        if (hasCollectedAIMessage) {
          rounds++
          hasCollectedAIMessage = false
        }
      }

      selected.unshift(msg)
      tokens += msgTokens
      truncatedTokens += msgTruncatedTokens
    }

    // 移除开头不成对的 Tool 消息
    while (selected.length > 0) {
      const first = selected[0]
      if (ToolMessage.isInstance(first)) {
        selected.shift()
        continue
      }
      break
    }

    const remaining = messages.slice(0, messages.length - selected.length)

    return {
      selected,
      remaining,
      tokens,
      truncatedTokens,
      rounds,
    }
  }

  /**
   * 收集剩余的配对 Tool 消息
   * 用于 truncateFromStart 后，将被截断但仍需保留的 Tool 消息收集回来
   */
  private static collectRemainingToolMessages(
    messages: BaseMessage[],
    currentLength: number,
    pendingToolCallIds: string[],
  ): BaseMessage[] {
    if (pendingToolCallIds.length === 0) return []

    const collected: BaseMessage[] = []
    const toolIds = new Set(pendingToolCallIds)

    for (let i = currentLength; i < messages.length; i++) {
      const msg = messages[i]
      if (ToolMessage.isInstance(msg) && toolIds.has(msg.tool_call_id)) {
        collected.push(msg)
        toolIds.delete(msg.tool_call_id)
        if (toolIds.size === 0) break
      }
    }

    return collected
  }

  /**
   * 按轮数截断消息
   * @param messages 消息数组
   * @param rounds 最大轮数
   * @param direction 截断方向
   */
  static truncateByRounds(
    messages: BaseMessage[],
    rounds: number,
    direction: 'start' | 'end',
    options?: FormatOptions,
  ): TruncateResult {
    const toolMaxLines = options?.toolMaxLines ?? 300

    if (messages.length === 0) {
      return { selected: [], remaining: [], tokens: 0, truncatedTokens: 0, rounds: 0 }
    }

    if (direction === 'start') {
      return this.truncateRoundsFromStart(messages, rounds, toolMaxLines)
    } else {
      return this.truncateRoundsFromEnd(messages, rounds, toolMaxLines)
    }
  }

  /**
   * 从开头按轮数截断
   * 轮次计算规则：user+ai 算一轮
   */
  private static truncateRoundsFromStart(
    messages: BaseMessage[],
    targetRounds: number,
    toolMaxLines: number,
  ): TruncateResult {
    const selected: BaseMessage[] = []
    let tokens = 0
    let truncatedTokens = 0
    let rounds = 0
    let pendingToolCallIds: string[] = []
    let hasPendingHumanMessage = false

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const msgTokens = countSingleMessageTokens(msg)
      const msgTruncatedTokens = countTruncatedMessageTokens(msg, toolMaxLines)

      if (HumanMessage.isInstance(msg)) {
        // 检查是否已达到目标轮数
        if (rounds >= targetRounds && !hasPendingHumanMessage) break
        // 标记有未配对的 HumanMessage
        if (!hasPendingHumanMessage) {
          hasPendingHumanMessage = true
        }
        pendingToolCallIds = []
      } else if (AIMessage.isInstance(msg)) {
        // AI 消息回复，完成一轮
        if (hasPendingHumanMessage) {
          if (rounds >= targetRounds) break
          rounds++
          hasPendingHumanMessage = false
        }
        if (msg.tool_calls?.length) {
          pendingToolCallIds = msg.tool_calls
            .map((tc) => tc.id)
            .filter((id): id is string => id !== undefined)
        }
      } else if (ToolMessage.isInstance(msg)) {
        const idx = pendingToolCallIds.indexOf(msg.tool_call_id)
        if (idx !== -1) pendingToolCallIds.splice(idx, 1)
      }

      selected.push(msg)
      tokens += msgTokens
      truncatedTokens += msgTruncatedTokens
    }

    selected.push(
      ...this.collectRemainingToolMessages(messages, selected.length, pendingToolCallIds),
    )

    const remaining = messages.slice(selected.length)

    return {
      selected,
      remaining,
      tokens,
      truncatedTokens,
      rounds,
    }
  }

  /**
   * 从末尾按轮数截断
   * 轮次计算规则：user+ai 算一轮（反向遍历时，遇到 HumanMessage 且已收集到 AIMessage 才算一轮）
   */
  private static truncateRoundsFromEnd(
    messages: BaseMessage[],
    targetRounds: number,
    toolMaxLines: number,
  ): TruncateResult {
    const selected: BaseMessage[] = []
    let tokens = 0
    let truncatedTokens = 0
    let rounds = 0
    const seenMessages = new Set<string>()
    const pendingToolCallIds: string[] = []
    /** 标记是否已收集到 AIMessage（反向遍历先遇到 AI） */
    let hasCollectedAIMessage = false

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]

      // 跳过已处理的消息（先去重）
      if (msg.id && seenMessages.has(msg.id)) continue
      if (msg.id) seenMessages.add(msg.id)

      const msgTokens = countSingleMessageTokens(msg)
      const msgTruncatedTokens = countTruncatedMessageTokens(msg, toolMaxLines)

      if (ToolMessage.isInstance(msg)) {
        pendingToolCallIds.push(msg.tool_call_id)
      } else if (AIMessage.isInstance(msg)) {
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            if (tc.id) {
              const idx = pendingToolCallIds.indexOf(tc.id)
              if (idx !== -1) pendingToolCallIds.splice(idx, 1)
            }
          }
        }
        // 标记已收集到 AI 消息，等待配对的 HumanMessage
        hasCollectedAIMessage = true
      } else if (HumanMessage.isInstance(msg)) {
        // HumanMessage：如果已收集到 AI 消息，则完成一轮
        if (hasCollectedAIMessage) {
          rounds++
          hasCollectedAIMessage = false
          if (rounds > targetRounds) break
        }
      }

      selected.unshift(msg)
      tokens += msgTokens
      truncatedTokens += msgTruncatedTokens
    }

    // 移除开头不成对的 Tool 消息
    while (selected.length > 0) {
      const first = selected[0]
      if (ToolMessage.isInstance(first)) {
        selected.shift()
        continue
      }
      break
    }

    const remaining = messages.slice(0, messages.length - selected.length)

    return {
      selected,
      remaining,
      tokens,
      truncatedTokens,
      rounds,
    }
  }

  /**
   * 格式化消息为 LLM 可读的 JSON 字符串
   * @param messages 消息数组
   * @param options 格式化选项
   */
  static formatForLLM(messages: BaseMessage[], options?: FormatOptions): string {
    const maxLines = options?.toolMaxLines ?? 300
    const keepThink = options?.keepThink ?? true

    const formattedMessages = messages.map((msg, msgIdx) => {
      if (ToolMessage.isInstance(msg)) {
        const contentStr =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        let truncated = truncateToolContent(contentStr, maxLines)
        if (!keepThink) {
          truncated = removeThinkTags(truncated)
        }
        return {
          role: 'tool',
          toolName: msg.name || 'unknown',
          // 组合一个可读的唯一ID，用于工具调用的匹配
          toolId: `${msgIdx}_${msg.name}`,
          content: truncated,
        }
      }

      const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      const isHuman = msg.constructor.name === 'HumanMessage'
      let content = contentStr
      if (!keepThink) {
        content = removeThinkTags(contentStr)
      }

      return {
        id: msg.id,
        role: isHuman ? 'user' : 'ai',
        content,
      }
    })

    return JSON.stringify(formattedMessages, null, 2)
  }
}
