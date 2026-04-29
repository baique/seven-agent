/**
 * 对话取消状态管理器
 * 用于管理对话的强制取消功能
 */

import { getReviewManager } from '../review'

/** 流式消息数据 */
export interface StreamingMessageData {
  /** 消息ID */
  id: string
  /** 消息类型 */
  type: 'human' | 'ai' | 'tool'
  /** 消息内容 */
  content: string
  /** 工具调用 */
  toolCalls?: any[]
  /** 消息状态 */
  status?: 'streaming' | 'loading' | 'complete'
  /** 时间戳 */
  timestamp: number
}

/** 取消状态接口 */
interface CancelState {
  /** 是否已取消 */
  cancelled: boolean
  /** 取消原因 */
  reason?: string
  /** AbortController 用于中断请求 */
  abortController: AbortController
  /** 当前流式消息列表 */
  streamingMessages: StreamingMessageData[]
  /** WebSocket连接（可选） */
  socket?: import('ws').WebSocket
}

/** 对话取消管理器类 */
class ChatCancelManager {
  /** 当前活跃的对话取消状态 */
  private activeCancellations: Map<string, CancelState> = new Map()

  /**
   * 注册一个新的对话
   * @param requestId 请求ID
   * @param socket WebSocket连接（可选）
   * @returns AbortController 用于传递给请求
   */
  registerChat(requestId: string, socket?: import('ws').WebSocket): AbortController {
    const abortController = new AbortController()
    this.activeCancellations.set(requestId, {
      cancelled: false,
      abortController,
      streamingMessages: [],
      socket,
    })
    return abortController
  }

  /**
   * 获取指定对话的 WebSocket
   * @param requestId 请求ID
   * @returns WebSocket 或 undefined
   */
  getSocket(requestId: string): import('ws').WebSocket | undefined {
    return this.activeCancellations.get(requestId)?.socket
  }

  /**
   * 获取指定对话的 AbortController
   * @param requestId 请求ID
   * @returns AbortController 或 undefined
   */
  getAbortController(requestId: string): AbortController | undefined {
    return this.activeCancellations.get(requestId)?.abortController
  }

  /**
   * 取消对话
   * @param requestId 请求ID
   * @param reason 取消原因
   * @returns 是否成功取消
   */
  cancelChat(requestId: string, reason?: string): boolean {
    const state = this.activeCancellations.get(requestId)
    if (state) {
      state.cancelled = true
      state.reason = reason
      // 触发 abort 中断正在进行的请求
      state.abortController.abort(reason || '用户取消')

      // 获取审查中的任务也要结束掉
      const reviewManager = getReviewManager()
      // 结束审查任务
      reviewManager.handleResponse({
        requestId,
        approved: false,
        simulated: false,
        reason: '用户取消',
      })
      return true
    }
    return false
  }

  /**
   * 检查对话是否已取消
   * @param requestId 请求ID
   */
  isCancelled(requestId: string): boolean {
    const state = this.activeCancellations.get(requestId)
    return state?.cancelled ?? false
  }

  /**
   * 获取取消原因
   * @param requestId 请求ID
   */
  getCancelReason(requestId: string): string | undefined {
    const state = this.activeCancellations.get(requestId)
    return state?.reason
  }

  /**
   * 清除对话状态
   * @param requestId 请求ID
   */
  clearChat(requestId: string): void {
    this.activeCancellations.delete(requestId)
  }

  /**
   * 获取当前活跃的对话数量
   */
  getActiveCount(): number {
    return this.activeCancellations.size
  }

  /**
   * 获取当前活跃的对话请求ID列表
   */
  getActiveRequestIds(): string[] {
    return Array.from(this.activeCancellations.keys())
  }

  /**
   * 更新指定对话的流式消息
   * @param requestId 请求ID
   * @param message 消息数据
   */
  updateStreamingMessage(requestId: string, message: StreamingMessageData): void {
    const state = this.activeCancellations.get(requestId)
    if (!state) return

    const existingIndex = state.streamingMessages.findIndex((m) => m.id === message.id)
    if (existingIndex >= 0) {
      // 更新已有消息
      state.streamingMessages[existingIndex] = {
        ...state.streamingMessages[existingIndex],
        ...message,
      }
    } else {
      // 添加新消息
      state.streamingMessages.push(message)
    }
  }

  /**
   * 获取指定对话的流式消息列表
   * @param requestId 请求ID
   * @returns 消息列表
   */
  getStreamingMessages(requestId: string): StreamingMessageData[] {
    const state = this.activeCancellations.get(requestId)
    return state?.streamingMessages ?? []
  }

  /**
   * 获取所有活跃对话的流式消息
   * @returns 请求ID到消息列表的映射
   */
  getAllStreamingMessages(): Record<string, StreamingMessageData[]> {
    const result: Record<string, StreamingMessageData[]> = {}
    for (const [requestId, state] of this.activeCancellations.entries()) {
      result[requestId] = state.streamingMessages
    }
    return result
  }
}

/** 全局对话取消管理器实例 */
export const chatCancelManager = new ChatCancelManager()

/**
 * 获取对话取消管理器实例
 */
export function getChatCancelManager(): ChatCancelManager {
  return chatCancelManager
}
