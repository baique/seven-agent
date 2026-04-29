import type {
  SocketClientOptions,
  SocketClientEvents,
  SocketRequest,
  SocketResponse,
} from './types'
import { MessageHandler, createMessageHandler } from './handler'

export class SocketClient {
  private socket: WebSocket | null = null
  private options: Required<SocketClientOptions>
  private events: SocketClientEvents = {}
  private handler: MessageHandler
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private isManualClose = false

  constructor(options: SocketClientOptions) {
    this.options = {
      delimiter: '\n',
      reconnectInterval: 3000,
      maxReconnectAttempts: 5,
      ...options,
    }
    this.handler = createMessageHandler()
  }

  on<K extends keyof SocketClientEvents>(
    event: K,
    callback: NonNullable<SocketClientEvents[K]>,
  ): void {
    this.events[event] = callback as never
  }

  off<K extends keyof SocketClientEvents>(event: K): void {
    delete this.events[event]
  }

  getHandler(): MessageHandler {
    return this.handler
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        resolve()
        return
      }

      this.isManualClose = false
      const wsUrl = `ws://${this.options.host}:${this.options.port}`

      try {
        this.socket = new WebSocket(wsUrl)

        this.socket.onopen = () => {
          console.log('Socket connected')
          this.reconnectAttempts = 0
          this.events.onConnect?.()
          resolve()
        }

        this.socket.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data)
        }

        this.socket.onclose = () => {
          console.log('Socket disconnected')
          this.events.onDisconnect?.()
          this.attemptReconnect()
        }

        this.socket.onerror = (error: Event) => {
          const err = new Error('WebSocket error occurred')
          console.error('Socket error:', error)
          this.events.onError?.(err)
          reject(err)
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  disconnect(): void {
    this.isManualClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }

  send<T = unknown>(request: SocketRequest<T>): void {
    if (!this.isConnected()) {
      console.error('Socket is not connected')
      return
    }
    const message = JSON.stringify(request) + this.options.delimiter
    this.socket?.send(message)
  }

  sendAsync<T = unknown, R = unknown>(request: SocketRequest<T>): Promise<SocketResponse<R>> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('Socket is not connected'))
        return
      }

      const requestId = request.requestId || this.generateRequestId()
      const requestWithId = { ...request, requestId }

      const timeout = setTimeout(() => {
        this.handler.unregister(`req:${requestId}`)
        reject(new Error(`Request timeout: ${request.command}`))
      }, 30000)

      this.handler.register(`req:${requestId}`, (response: SocketResponse<R>) => {
        clearTimeout(timeout)
        resolve(response)
      })

      const message = JSON.stringify(requestWithId) + this.options.delimiter
      this.socket?.send(message)
    })
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private handleMessage(data: string): void {
    const messages = data.split(this.options.delimiter)

    for (const message of messages) {
      if (!message.trim()) continue

      try {
        const response: SocketResponse = JSON.parse(message.trim())
        this.events.onMessage?.(response)
        this.handler.handle(response)
      } catch (error) {
        console.error('Failed to parse message:', message, error)
      }
    }
  }

  private attemptReconnect(): void {
    if (this.isManualClose) return
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached')
      return
    }

    this.reconnectAttempts++
    console.log(`Reconnecting... Attempt ${this.reconnectAttempts}`)

    this.reconnectTimer = window.setTimeout(() => {
      this.connect().catch(() => {
        // 重连失败，继续尝试
      })
    }, this.options.reconnectInterval)
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}

export function createSocketClient(options: SocketClientOptions): SocketClient {
  return new SocketClient(options)
}

export { MessageHandler, createMessageHandler } from './handler'
export * from './types'
