/**
 * Buffer消息取消处理器
 */

import type { SocketRequest, SocketResponse } from '../types'
import { ResponseBuilder } from '../types'
import { messageProcessor } from '../../core/graph/message-processor'
import { logger } from '../../utils'

/** 取消Buffer消息请求数据 */
export interface BufferCancelRequest {
  /** 消息ID */
  messageId: string
}

/**
 * 创建Buffer消息取消处理器
 */
export function createBufferCancelHandler() {
  return (
    data: BufferCancelRequest,
    request: SocketRequest<BufferCancelRequest>,
  ): SocketResponse => {
    const { messageId } = data
    const currentRequestId = request.requestId

    if (!messageId) {
      return ResponseBuilder.error('messageId is required', 400, currentRequestId)
    }

    const success = messageProcessor.cancelPendingMessage(messageId)

    if (success) {
      logger.info({ messageId }, '[BufferCancel] Buffer消息已取消')
      return ResponseBuilder.success(
        { messageId, cancelled: true },
        'Buffer消息已取消',
        currentRequestId,
      )
    } else {
      logger.warn({ messageId }, '[BufferCancel] 未找到对应的pending消息')
      return ResponseBuilder.error('未找到对应的pending消息', 404, currentRequestId)
    }
  }
}
