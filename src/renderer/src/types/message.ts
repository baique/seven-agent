/**
 * 消息类型定义
 * 统一前端消息格式，消除重复定义
 */

/** 工具调用信息 */
export interface ToolCall {
  /** 工具调用ID */
  id: string
  /** 工具名称 */
  name: string
  /** 工具参数 */
  args?: Record<string, unknown>
  /** 工具执行结果 */
  result?: unknown
  /** 工具执行状态 */
  status?: 'loading' | 'success' | 'error' | 'streaming'
}

/** 消息类型枚举 */
export type MessageType = 'human' | 'ai' | 'system' | 'tool'

/** 消息状态 */
export type MessageStatus = 'loading' | 'streaming' | 'success' | 'error'

/**
 * 后端返回的原始消息格式
 * 通过 Socket/HTTP 接收的消息结构
 */
export interface RawMessage {
  /** 消息ID */
  id: string
  /** 消息类型 */
  type: MessageType
  /** 消息内容 */
  content: string
  /** 工具调用列表（AI消息） */
  toolCalls?: Array<{
    name: string
    id?: string
    tool_call_id?: string
    args?: Record<string, unknown>
  }>
  /** 工具调用ID（工具消息） */
  toolCallId?: string
  /** 工具名称（工具消息） */
  name?: string
  /** 时间戳 */
  timestamp?: number
  /** 是否为子代理消息 */
  isSubagent?: boolean
  /** 工具执行状态（工具消息） */
  status?: MessageStatus
}

/**
 * 前端渲染用消息格式
 * 由 RawMessage 转换而来
 */
export interface Message {
  /** 消息ID */
  id: string
  /** 消息类型 */
  type: MessageType
  /** 消息内容 */
  content: string
  /** 工具调用列表（AI消息） */
  toolCalls?: ToolCall[]
  /** 工具调用ID（工具消息，用于关联） */
  toolCallId?: string
  /** 消息状态 */
  status?: MessageStatus
  /** 是否为子代理消息 */
  isSubagent?: boolean
  /** 时间戳 */
  timestamp?: number
}

/**
 * 历史消息加载参数
 */
export interface HistoryLoadParams {
  /** 加载数量限制 */
  limit?: number
  /** 加载此ID之前的消息（用于分页） */
  beforeId?: string
}

/**
 * 历史消息加载结果
 */
export interface HistoryLoadResult {
  /** 消息列表 */
  messages: RawMessage[]
  /** 是否还有更多消息 */
  hasMore: boolean
  /** 下一页的游标ID */
  nextCursor?: string
}
