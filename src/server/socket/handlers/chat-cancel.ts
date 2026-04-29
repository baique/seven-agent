/**
 * 对话取消处理器
 */

import type { SocketRequest, SocketResponse } from '../types'
import { ResponseBuilder } from '../types'
import { getChatCancelManager } from '../../core/state/chat-cancel'
import { logger } from '../../utils'

/** 取消对话请求数据 */
export interface ChatCancelRequest {
  /** 请求ID */
  requestId: string
  /** 取消原因 */
  reason?: string
}

/**
 * 创建对话取消处理器
 */
export function createChatCancelHandler() {
  return (data: ChatCancelRequest, request: SocketRequest<ChatCancelRequest>): SocketResponse => {
    const { requestId: targetRequestId, reason } = data
    const currentRequestId = request.requestId

    if (!targetRequestId) {
      return ResponseBuilder.error('requestId is required', 400, currentRequestId)
    }

    const manager = getChatCancelManager()
    const success = manager.cancelChat(targetRequestId, reason)

    if (success) {
      logger.info({ targetRequestId, reason }, '[ChatCancel] 对话取消请求已记录')
      return ResponseBuilder.success(
        { requestId: targetRequestId, cancelled: true },
        '对话取消请求已记录',
        currentRequestId,
      )
    } else {
      logger.warn({ targetRequestId }, '[ChatCancel] 未找到对应的活跃对话')
      return ResponseBuilder.error('未找到对应的活跃对话', 404, currentRequestId)
    }
  }
}
