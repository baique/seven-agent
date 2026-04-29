import type { SocketRequest } from '../types'
import { ResponseBuilder } from '../types'
import { getReviewManager, type ToolMode, type ReviewResponse } from '../../core/review'
import { logger } from '../../utils'

/**
 * 模式切换请求
 */
export interface ToolModeChangeRequest {
  mode: ToolMode
}

/**
 * 审查响应请求
 */
export interface ToolReviewResponseRequest {
  requestId: string
  action: 'approve' | 'reject' | 'simulate'
  reason?: string
}

/**
 * 创建模式切换处理器
 */
export function createToolModeChangeHandler() {
  const reviewManager = getReviewManager()

  return (data: ToolModeChangeRequest, request: SocketRequest<ToolModeChangeRequest>) => {
    const { mode } = data

    if (mode !== 'auto' && mode !== 'manual') {
      return ResponseBuilder.error(
        'Invalid mode, must be "auto" or "manual"',
        400,
        request.requestId,
      )
    }

    reviewManager.setMode(mode)
    logger.info({ mode }, '[ToolReview] 模式已切换')

    return ResponseBuilder.success({ mode }, '模式切换成功', request.requestId)
  }
}

/**
 * 创建审查响应处理器
 */
export function createToolReviewResponseHandler() {
  const reviewManager = getReviewManager()

  return (data: ToolReviewResponseRequest, request: SocketRequest<ToolReviewResponseRequest>) => {
    const { requestId, action, reason } = data

    if (!requestId) {
      return ResponseBuilder.error('requestId is required', 400, request.requestId)
    }

    if (!action || !['approve', 'reject', 'simulate'].includes(action)) {
      return ResponseBuilder.error(
        'Invalid action, must be "approve", "reject" or "simulate"',
        400,
        request.requestId,
      )
    }

    const response: ReviewResponse = {
      requestId,
      approved: action === 'approve' || action === 'simulate',
      simulated: action === 'simulate',
      reason,
    }

    reviewManager.handleResponse(response)

    return ResponseBuilder.success({ handled: true }, '响应已处理', request.requestId)
  }
}
