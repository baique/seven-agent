export const SocketResponseType = {
  // 请求
  REQUEST_START: 'request:start',
  REQUEST_COMPLETE: 'request:complete',
  // 消息发送
  MESSAGE_STREAM: 'message:stream',
  MESSAGE_COMMAND: 'message:command',
  MESSAGE_COMPLETE: 'message:complete',
  MESSAGE_ERROR: 'message:error',
  MESSAGE_CANCELLED: 'message:cancelled',

  // 指令
  COMMAND_POPUP: 'command:popup',

  // 指令
  TIMELINE_COMPLETE: 'timeline:complete',

  // 摘要
  SUMMARY_START: 'summary:start',
  SUMMARY_COMPLETE: 'summary:complete',

  // Token统计
  TOKEN_USAGE: 'token:usage',

  // Socket连接完成
  SOCKET_READY: 'socket:ready',

  // Buffer消息相关
  BUFFER_MESSAGE_ADDED: 'buffer:message:added',
  BUFFER_MESSAGE_CONSUMED: 'buffer:message:consumed',
  BUFFER_MESSAGE_CANCELLED: 'buffer:message:cancelled',

  // 人格状态更新
  PERSONALITY_UPDATED: 'personality:updated',

  // 任务更新
  TASK_UPDATED: 'task:updated',

  // 终端事件
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_STATUS_CHANGED: 'terminal:status_changed',
  TERMINAL_SESSION_CREATED: 'terminal:session_created',
  TERMINAL_SESSION_CLOSED: 'terminal:session_closed',
} as const

export interface SocketResponse<T = unknown> {
  code: number
  message: string
  type: string
  data: T | null
  timestamp: number
  requestId?: string
}

export interface SocketRequest<T = unknown> {
  command: string
  data: T
  requestId?: string
}

export class ResponseBuilder {
  private static create<T>(
    code: number,
    message: string,
    type: string,
    data: T | null = null,
    requestId?: string,
  ): SocketResponse<T> {
    return {
      code,
      message,
      type,
      data,
      timestamp: Date.now(),
      requestId,
    }
  }

  static success<T>(data: T, message = '操作成功', requestId?: string): SocketResponse<T> {
    return this.create(200, message, 'success', data, requestId)
  }

  static error(message: string, code = 500, requestId?: string): SocketResponse<null> {
    return this.create(code, message, 'error', null, requestId)
  }

  static progress<T>(
    data: T,
    progress: number,
    message = '处理中',
    requestId?: string,
  ): SocketResponse<{ data: T; progress: number }> {
    return this.create(206, message, 'progress', { data, progress }, requestId)
  }

  static cancelled<T = null>(
    message = '已取消',
    requestId?: string,
    data: T | null = null,
  ): SocketResponse<T> {
    return this.create(499, message, 'cancelled', data, requestId)
  }
}

export function createSuccessResponse<T>(
  data: T,
  message?: string,
  requestId?: string,
): SocketResponse<T> {
  return ResponseBuilder.success(data, message, requestId)
}

export function createErrorResponse(
  message: string,
  code?: number,
  requestId?: string,
): SocketResponse<null> {
  return ResponseBuilder.error(message, code, requestId)
}

export function createProgressResponse<T>(
  data: T,
  progress: number,
  message?: string,
  requestId?: string,
): SocketResponse<{ data: T; progress: number }> {
  return ResponseBuilder.progress(data, progress, message, requestId)
}
