export interface SocketResponse<T = unknown> {
  code: number
  message: string
  type: string
  command?: string
  data: T | null
  timestamp: number
  requestId?: string
}

export interface SocketRequest<T = unknown> {
  command: string
  data: T
  requestId?: string
}

export interface SocketClientOptions {
  host: string
  port: number
  delimiter?: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
}

export interface SocketClientEvents {
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Error) => void
  onMessage?: (response: SocketResponse) => void
}
