type EventCallback<T = unknown> = (data: T) => void

class EventBus {
  private listeners = new Map<string, Set<EventCallback>>()

  on<T = unknown>(event: string, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback as EventCallback)

    return () => this.off(event, callback)
  }

  emit<T = unknown>(event: string, data?: T): void {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      callbacks.forEach((cb) => cb(data))
    }
  }

  off<T = unknown>(event: string, callback: EventCallback<T>): void {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      callbacks.delete(callback as EventCallback)
    }
  }

  clear(event?: string): void {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
  }
}

export const eventBus = new EventBus()

export const Events = {
  AUDIO_START: 'audio:start',
  AUDIO_END: 'audio:end',
  AUDIO_CANCEL: 'audio:cancel',
  FACE_START: 'face:start',
  FACE_END: 'face:end',
  ACT_START: 'act:start',
  ACT_END: 'act:end',
  EMOTION_START: 'emotion:start',
  EMOTION_END: 'emotion:end',

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
  TIMELINE_COMPLETE: 'timeline:complete',

  // Socket 广播事件（服务端主动推送）
  // 任务相关
  TASK_UPDATED: 'task:updated',
  // 人格状态相关
  PERSONALITY_UPDATED: 'personality:updated',
  // 终端相关
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_SESSION_CREATED: 'terminal:session_created',
  TERMINAL_SESSION_CLOSED: 'terminal:session_closed',
  TERMINAL_STATUS_CHANGED: 'terminal:status_changed',
  WINDOW_STATE_CHANGE: 'window_state_changed',

  // Socket 消息通道（内部使用）
  SOCKET_MESSAGE: 'socket:message',

  // 摘要相关
  SUMMARY_START: 'summary:start',
  SUMMARY_COMPLETE: 'summary:complete',

  // Token统计
  TOKEN_USAGE: 'token:usage',

  // Socket连接完成
  SOCKET_READY: 'socket:ready',

  // 人物模型加载完成
  MODEL_READY: 'model:ready',

  // Buffer消息相关
  BUFFER_MESSAGE_ADDED: 'buffer:message:added',
  BUFFER_MESSAGE_CONSUMED: 'buffer:message:consumed',
  BUFFER_MESSAGE_CANCELLED: 'buffer:message:cancelled',
} as const
