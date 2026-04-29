import type { WebSocket } from 'ws'
import { logger } from '../../utils/logger'
import { getHybridServer } from '../../socket/hybrid-server'
import { SocketResponseType } from '../../socket/types'

/**
 * 消息队列项状态
 */
type QueueMessageStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'consumed'

/**
 * 消息队列项
 */
interface QueueMessage {
  /** 消息唯一ID */
  id: string
  /** 消息内容 */
  content: string
  /** 状态 */
  status: QueueMessageStatus
  /** 来源socket，为空则广播 */
  socket?: WebSocket
  /** Promise resolve */
  resolve: () => void
  /** Promise reject */
  reject: (error: Error) => void
  /** 入队时间 */
  timestamp: number
}

/**
 * 消息处理器回调函数类型
 */
type MessageHandler = (
  message: string,
  messageId: string,
  socket: WebSocket | undefined,
  broadcast: (data: unknown) => void,
) => Promise<void>

/**
 * 消息队列处理器
 * 顺序处理所有队列中的消息，支持addMessage操作
 */
export class MessageProcessor {
  /** 消息队列 */
  private queue: QueueMessage[] = []
  /** 是否正在处理 */
  private isProcessing: boolean = false
  /** 消息处理回调 */
  private handler: MessageHandler | null = null
  /** 等待特定消息完成的Map */
  private awaitingMessages: Map<string, { resolve: () => void; reject: (error: Error) => void }> =
    new Map()

  /**
   * 设置消息处理回调
   * @param handler 处理函数
   */
  setHandler(handler: MessageHandler): void {
    this.handler = handler
  }

  /**
   * 添加消息到队列
   * @param content 消息内容
   * @param socket 来源socket，为空则广播
   * @param requestId 请求ID，用于取消功能
   * @returns Promise，消息处理完成时resolve，如果已有buffer则reject
   */
  addMessage(content: string, socket?: WebSocket, requestId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = requestId || this.generateMessageId()

      // 检查是否已有pending消息（buffer消息只能有一条）
      if (this.hasPendingMessage()) {
        logger.warn(`[MessageProcessor] 拒绝消息 <${id}>，已有pending消息`)
        reject(new Error('已有待发送消息，请先取消或等待消费'))
        return
      }

      const queueItem: QueueMessage = {
        id,
        content,
        status: 'pending',
        socket,
        resolve,
        reject,
        timestamp: Date.now(),
      }

      // 先检查是否有正在处理的消息（在入队前检查）
      const isFirstMessage = this.queue.length === 0 && !this.isProcessing

      this.queue.push(queueItem)
      logger.info(
        `[MessageProcessor] 消息入队 <${id}> 队列长度: ${this.queue.length}, 是否首条: ${isFirstMessage}`,
      )

      // 如果不是第一条消息（即当前有正在处理的消息），则通知前台有新的buffer消息
      if (!isFirstMessage) {
        this.sendOrBroadcast(socket, {
          code: 200,
          type: SocketResponseType.BUFFER_MESSAGE_ADDED,
          data: { id, content, timestamp: queueItem.timestamp },
          timestamp: Date.now(),
          requestId: id,
        })
      }

      this.processQueue()
    })
  }

  /**
   * 等待特定消息处理完成
   * @param messageId 消息ID
   * @returns Promise，指定消息处理完成时resolve
   */
  awaitMessage(messageId: string): Promise<void> {
    const queueItem = this.queue.find((item) => item.id === messageId)
    if (queueItem && queueItem.status === 'completed') {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      this.awaitingMessages.set(messageId, { resolve, reject })
    })
  }

  /**
   * 获取队列长度
   */
  getQueueLength(): number {
    return this.queue.length
  }

  /**
   * 获取队列中待处理的消息数量
   */
  getPendingCount(): number {
    return this.queue.filter((item) => item.status === 'pending').length
  }

  /**
   * 检查是否已有buffer消息（pending状态的消息）
   * @returns 是否有pending消息
   */
  hasPendingMessage(): boolean {
    return this.queue.some((item) => item.status === 'pending')
  }

  /**
   * 获取下一条待处理的pending消息（不移除）
   * @returns 待处理的消息，如果没有则返回null
   */
  peekPendingMessage(): { id: string; content: string; socket?: WebSocket } | null {
    const pendingItem = this.queue.find((item) => item.status === 'pending')
    if (!pendingItem) {
      return null
    }
    return {
      id: pendingItem.id,
      content: pendingItem.content,
      socket: pendingItem.socket,
    }
  }

  /**
   * 消费一条pending消息
   * 将消息状态改为consumed，并发送MESSAGE_STREAM事件通知前台
   * @returns 被消费的消息，如果没有则返回null
   */
  consumePendingMessage(): { id: string; content: string; socket?: WebSocket } | null {
    // 找到第一个pending状态的消息
    const pendingItem = this.queue.find((item) => item.status === 'pending')
    if (!pendingItem) {
      logger.debug('[MessageProcessor] 没有pending消息可消费')
      return null
    }

    // 保存数据
    const { id, content, socket } = pendingItem

    // 从队列中移除（先移除再resolve，避免状态不一致）
    const index = this.queue.indexOf(pendingItem)
    if (index > -1) {
      this.queue.splice(index, 1)
    }

    // 设置状态并resolve
    pendingItem.status = 'consumed'
    try {
      pendingItem.resolve() // 通知原等待者消息已被消费
    } catch (e) {
      // ignore resolve error
    }

    logger.info(`[MessageProcessor] 消息被消费 <${id}>, 剩余队列长度: ${this.queue.length}`)

    // 发送MESSAGE_STREAM事件通知前台（统一使用同一个事件）
    this.sendOrBroadcast(socket, {
      code: 200,
      type: SocketResponseType.MESSAGE_STREAM,
      data: {
        id,
        type: 'human',
        content,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
      requestId: id,
    })

    return { id, content, socket }
  }

  /**
   * 取消一条pending消息
   * @param messageId 消息ID
   * @returns 是否取消成功
   */
  cancelPendingMessage(messageId: string): boolean {
    // 查找pending状态的消息
    const index = this.queue.findIndex((item) => item.id === messageId && item.status === 'pending')
    if (index === -1) {
      logger.warn(`[MessageProcessor] 取消失败，未找到pending消息 <${messageId}>`)
      return false
    }

    const item = this.queue[index]

    // 保存socket引用，因为splice后会丢失
    const itemSocket = item.socket

    // 从队列中移除（先移除再reject，避免reject触发其他逻辑时队列状态不一致）
    this.queue.splice(index, 1)

    // 设置状态并reject
    item.status = 'failed'
    try {
      item.reject(new Error('Message cancelled by user'))
    } catch (e) {
      // ignore reject error
    }

    logger.info(`[MessageProcessor] 消息被取消 <${messageId}>, 剩余队列长度: ${this.queue.length}`)

    // 通知前台buffer消息被取消
    this.sendOrBroadcast(itemSocket, {
      code: 200,
      type: SocketResponseType.BUFFER_MESSAGE_CANCELLED,
      data: { id: messageId },
      timestamp: Date.now(),
      requestId: messageId,
    })

    return true
  }

  /**
   * 处理消息队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return
    }

    this.isProcessing = true

    while (this.queue.length > 0) {
      const item = this.queue[0]
      // 跳过已消费的消息（被LLM节点消费的消息）
      if (item.status === 'consumed') {
        this.queue.shift()
        continue
      }
      if (item.status !== 'pending') {
        break
      }

      item.status = 'processing'

      // 发送用户消息到前台（真正开始处理时）
      this.sendOrBroadcast(item.socket, {
        code: 200,
        type: SocketResponseType.MESSAGE_STREAM,
        data: {
          id: item.id,
          type: 'human',
          content: item.content,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
        requestId: item.id,
      })

      try {
        await this.processMessage(item)
        item.status = 'completed'
        item.resolve()

        const awaiting = this.awaitingMessages.get(item.id)
        if (awaiting) {
          awaiting.resolve()
          this.awaitingMessages.delete(item.id)
        }

        logger.info(`[MessageProcessor] 消息处理完成 <${item.id}>`)
      } catch (error) {
        item.status = 'failed'
        const err = error instanceof Error ? error : new Error(String(error))
        item.reject(err)

        const awaiting = this.awaitingMessages.get(item.id)
        if (awaiting) {
          awaiting.reject(err)
          this.awaitingMessages.delete(item.id)
        }

        logger.error({ error }, `[MessageProcessor] 消息处理失败 <${item.id}>`)
      }

      this.queue.shift()
    }

    this.isProcessing = false
  }

  /**
   * 处理单条消息
   */
  private async processMessage(item: QueueMessage): Promise<void> {
    if (!this.handler) {
      throw new Error('Message handler not set')
    }

    const broadcast = (data: unknown) => this.broadcast(data)

    await this.handler(item.content, item.id, item.socket, broadcast)
  }

  /**
   * 广播消息给所有有效socket
   */
  private broadcast(data: unknown): void {
    const server = getHybridServer()
    if (!server) {
      logger.warn('[MessageProcessor] HybridServer未初始化，无法广播')
      return
    }

    const connections = server.getConnections()
    const message = typeof data === 'string' ? data : JSON.stringify(data) + '\n'

    let sentCount = 0
    for (const socket of connections) {
      if (socket.readyState === 1) {
        socket.send(message)
        sentCount++
      }
    }

    logger.debug(`[MessageProcessor] 广播消息给 ${sentCount} 个连接`)
  }

  /**
   * 发送消息到socket或广播
   * @param socket 目标socket，为空则广播
   * @param data 消息数据
   */
  sendOrBroadcast(socket: WebSocket | undefined, data: unknown): void {
    if (socket && socket.readyState === 1) {
      const message = typeof data === 'string' ? data : JSON.stringify(data) + '\n'
      socket.send(message)
    } else {
      this.broadcast(data)
    }
  }

  /**
   * 生成消息ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
  }

  /**
   * 注入系统通知到消息队列
   * 如果队列中有pending消息，则追加到该消息末尾
   * 如果没有pending消息，则新建一条消息
   * @param content 系统通知内容
   */
  async injectSystemNote(content: string): Promise<void> {
    const pendingItem = this.queue.find((item) => item.status === 'pending')

    if (pendingItem) {
      // 追加到现有pending消息末尾
      pendingItem.content += `\n\n[system_note]\n${content}`
      logger.info(`[MessageProcessor] 系统通知已注入到消息 <${pendingItem.id}>`)
    } else {
      // 新建一条消息
      const id = this.generateMessageId()
      const queueItem: QueueMessage = {
        id,
        content: `[system_note]\n${content}`,
        status: 'pending',
        timestamp: Date.now(),
        resolve: () => {},
        reject: () => {},
      }

      this.queue.push(queueItem)
      logger.info(`[MessageProcessor] 系统通知新建消息 <${id}>`)

      this.processQueue()
    }
  }
}

/** 全局消息处理器实例 */
export const messageProcessor = new MessageProcessor()
