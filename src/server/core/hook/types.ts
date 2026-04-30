import type { WebSocket } from 'ws'
import type { BaseMessage } from '@langchain/core/messages'
import type { MessageTokenCounter } from '../../utils/message-token-counter'
import type { SessionNotes } from '../summary/types'
import type { MessagesState } from '../state/llm-state'

/**
 * 会话信息接口
 */
export interface SessionInfo {
  summary: string
  lastMessageId: string
}

/**
 * 请求开始前Hook参数
 */
export interface BeforeRequestParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 用户消息 */
  message: string
  /** 请求ID */
  requestId: string
}

/**
 * 请求结束后Hook参数
 */
export interface AfterRequestParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 用户消息 */
  message: string
  /** 请求ID */
  requestId: string
  /** 是否成功 */
  success: boolean
  /** 是否被取消 */
  cancelled: boolean
  /** 取消原因（如果被取消） */
  cancelReason?: string
  /** 错误信息（如果有） */
  error?: string
}

/**
 * 用户消息处理前Hook参数
 */
export interface BeforeUserMessageParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 用户消息 */
  message: string
  /** 状态 */
  state: typeof MessagesState.State
  /** 请求ID */
  requestId: string
}

/**
 * 用户消息处理后Hook参数
 */
export interface AfterUserMessageParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 用户消息 */
  message: string
  /** 状态 */
  state: typeof MessagesState.State
  /** 本轮AI响应 */
  llmResponse: BaseMessage
  /** 请求ID */
  requestId: string
}

/**
 * LLM调用前Hook参数
 */
export interface BeforeLLMParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 最新消息 */
  latestMessage: BaseMessage
  /** 状态 */
  state: typeof MessagesState.State
  /** 请求ID */
  requestId: string
}

/**
 * LLM调用后Hook参数
 */
export interface AfterLLMParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 最新消息 */
  latestMessage: BaseMessage
  /** 状态 */
  state: typeof MessagesState.State
  /** LLM响应（取消时可能为null） */
  llmResponse: BaseMessage | null
  /** 请求ID */
  requestId: string
  /** 是否被取消 */
  cancelled: boolean
}

/**
 * 工具调用前Hook参数
 */
export interface BeforeToolCallParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 用户消息 */
  message: BaseMessage
  /** 状态 */
  state: typeof MessagesState.State
  /** 工具名称 */
  toolName: string
  /** 工具参数 */
  toolArgs: Record<string, unknown>
  /** 请求ID */
  requestId: string
}

/**
 * 工具调用后Hook参数
 */
export interface AfterToolCallParams {
  /** WebSocket连接 */
  socket?: WebSocket
  /** 用户消息 */
  message: BaseMessage
  /** 状态 */
  state: typeof MessagesState.State
  /** 工具名称 */
  toolName: string
  /** 工具参数 */
  toolArgs: Record<string, unknown>
  /** 工具响应（成功时存在） */
  toolResponse?: BaseMessage
  /** 错误信息（失败时存在） */
  error?: string
  /** 请求ID */
  requestId: string
}

/**
 * 摘要发生前Hook参数
 */
export interface BeforeSummaryParams {
  /** 待摘要的消息计数器 */
  messageCounter: MessageTokenCounter
  /** 请求ID（可选，摘要可能跨多个请求） */
  requestId?: string
}

/**
 * 摘要发生后Hook参数
 */
export interface AfterSummaryParams {
  /** 待摘要的消息计数器 */
  messageCounter: MessageTokenCounter
  /** 会话信息 */
  sessionInfo: SessionInfo
  /** 摘要结果 */
  summaryResult: SessionNotes
  /** 请求ID（可选） */
  requestId?: string
  /** 摘要前的token数 */
  beforeTokens: number
  /** 摘要后的token数 */
  afterTokens: number
  /** 节省的token数 */
  savedTokens: number
}

/**
 * Hook处理函数类型
 */
export type HookHandler<T> = (params: T) => void | Promise<void>

/**
 * Hook类型枚举
 */
export enum HookType {
  /** 请求开始前 */
  BEFORE_REQUEST = 'beforeRequest',
  /** 请求结束后 */
  AFTER_REQUEST = 'afterRequest',
  /** 用户消息处理前 */
  BEFORE_USER_MESSAGE = 'beforeUserMessage',
  /** 用户消息处理后 */
  AFTER_USER_MESSAGE = 'afterUserMessage',
  /** LLM调用前 */
  BEFORE_LLM = 'beforeLLM',
  /** LLM调用后 */
  AFTER_LLM = 'afterLLM',
  /** 工具调用前（通用） */
  BEFORE_TOOL_CALL = 'beforeToolCall',
  /** 工具调用后（通用） */
  AFTER_TOOL_CALL = 'afterToolCall',
  /** 摘要发生前 */
  BEFORE_SUMMARY = 'beforeSummary',
  /** 摘要发生后 */
  AFTER_SUMMARY = 'afterSummary',
}
