import { logger } from '../../utils'
import { getHybridServer } from '../../socket'
import type { WebSocket } from 'ws'
import { parseMCPToolName } from '../tools/mcp'

export type ToolMode = 'auto' | 'manual'

export interface ToolCallRequest {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ReviewRequest {
  requestId: string
  toolCall: ToolCallRequest
  riskDescription: string
  timeout: number
  resolve: (result: { approved: boolean; simulated: boolean; reason?: string }) => void
  reject: (error: Error) => void
}

export interface ReviewResponse {
  requestId: string
  approved: boolean
  simulated?: boolean
  reason?: string
}

export interface ToolReviewData {
  requestId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskDescription: string
  timeout: number
}

/**
 * 工具审查管理器
 * 通过Socket发送审查请求给UI层，由UI层创建审查窗口
 */
export class ReviewManager {
  private mode: ToolMode = 'manual'
  private pendingReviews: Map<string, ReviewRequest> = new Map()
  private reviewDataMap: Map<string, ToolReviewData> = new Map()
  private readonly defaultTimeout = 3600000  // 1小时

  constructor() {
    // 不再注册IPC处理器，改为通过Socket通信
  }

  /**
   * 获取UI层的Socket连接
   * 目前简单实现：返回第一个连接（假设只有一个UI连接）
   * 后续可以通过连接标识来区分
   */
  private getUIConnection(): WebSocket | null {
    const server = getHybridServer()
    if (!server) {
      return null
    }
    const connections = server.getConnections()
    for (const socket of connections) {
      if (socket.readyState === 1) {
        // WebSocket.OPEN
        return socket
      }
    }
    return null
  }

  /**
   * 发送审查请求给UI层
   */
  private sendReviewRequestToUI(reviewData: ToolReviewData): boolean {
    const socket = this.getUIConnection()
    if (!socket) {
      logger.warn('[ReviewManager] 没有可用的UI连接')
      return false
    }

    const message =
      JSON.stringify({
        code: 200,
        type: 'command:review',
        data: reviewData,
        timestamp: Date.now(),
      }) + '\n'

    socket.send(message)
    logger.info({ requestId: reviewData.requestId }, '[ReviewManager] 已发送审查请求给UI层')
    return true
  }

  getMode(): ToolMode {
    return this.mode
  }

  setMode(mode: ToolMode): void {
    this.mode = mode
    logger.info({ mode }, '[ReviewManager] 模式已切换')
  }

  createReview(
    toolCall: ToolCallRequest,
  ): Promise<{ approved: boolean; simulated: boolean; reason?: string }> {
    return new Promise((resolve, reject) => {
      const requestId = `review-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
      const riskDescription = this.getRiskDescription(toolCall.name, toolCall.args)

      const reviewRequest: ReviewRequest = {
        requestId,
        toolCall,
        riskDescription,
        timeout: this.defaultTimeout,
        resolve,
        reject,
      }

      this.pendingReviews.set(requestId, reviewRequest)

      const reviewData: ToolReviewData = {
        requestId,
        toolName: toolCall.name,
        toolArgs: toolCall.args,
        riskDescription,
        timeout: this.defaultTimeout,
      }
      this.reviewDataMap.set(requestId, reviewData)

      // 通过Socket发送给UI层创建审查窗口
      const sent = this.sendReviewRequestToUI(reviewData)
      if (!sent) {
        this.pendingReviews.delete(requestId)
        this.reviewDataMap.delete(requestId)
        reject(new Error('无法连接到UI层'))
        return
      }

      logger.info({ requestId, toolName: toolCall.name }, '[ReviewManager] 创建审查请求')

      // 设置超时处理
      setTimeout(() => {
        if (this.pendingReviews.has(requestId)) {
          this.handleResponse({ requestId, approved: false, simulated: false, reason: '审查超时' })
        }
      }, this.defaultTimeout)
    })
  }

  /**
   * 处理来自UI层的审查响应
   * 通过Socket命令 'review:response' 调用
   */
  handleResponse(response: ReviewResponse): void {
    const reviewRequest = this.pendingReviews.get(response.requestId)

    if (!reviewRequest) {
      logger.warn({ requestId: response.requestId }, '[ReviewManager] 未找到对应的审查请求')
      return
    }

    this.pendingReviews.delete(response.requestId)
    this.reviewDataMap.delete(response.requestId)

    reviewRequest.resolve({
      approved: response.approved,
      simulated: response.simulated ?? false,
      reason: response.reason,
    })

    logger.info(
      { requestId: response.requestId, approved: response.approved, simulated: response.simulated },
      '[ReviewManager] 用户响应已处理',
    )
  }

  /**
   * 获取审查数据（供UI层查询）
   */
  getReviewData(requestId: string): ToolReviewData | null {
    return this.reviewDataMap.get(requestId) || null
  }

  private getRiskDescription(toolName: string, args: Record<string, unknown>): string {
    // MCP 工具特殊处理
    const parsed = parseMCPToolName(toolName)
    if (parsed) {
      return `[MCP] 即将通过 ${parsed.serverName} 服务器执行: ${parsed.toolName}`
    }

    const toolPath = args.file_path || args.command || ''
    return `即将执行 ${toolName}${toolPath ? `: ${toolPath}` : ''}`
  }

  clear(): void {
    for (const [, reviewRequest] of this.pendingReviews) {
      reviewRequest.resolve({ approved: false, simulated: false, reason: '系统清理' })
    }
    this.pendingReviews.clear()
    this.reviewDataMap.clear()
    logger.info('[ReviewManager] 已清理所有审查请求')
  }
}

let instance: ReviewManager | null = null

export function getReviewManager(): ReviewManager {
  if (!instance) {
    instance = new ReviewManager()
  }
  return instance
}
