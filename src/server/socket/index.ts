import { WebSocketServer, WebSocket } from 'ws'
import { SocketHandler, createSocketHandler } from './handler'
import type { SocketRequest, SocketResponse } from './types'
import { ResponseBuilder } from './types'
import { logger } from '../utils/logger'

export interface SocketServerOptions {
  port: number
  host?: string
  delimiter?: string
  maxConnections?: number
}

export interface SocketServerEvents {
  onConnection?: (socket: WebSocket) => void
  onDisconnect?: (socket: WebSocket) => void
  onError?: (error: Error, socket?: WebSocket) => void
  onMessage?: (data: SocketRequest, socket: WebSocket) => void
}

export class SocketServer {
  private server: WebSocketServer | null = null
  private handler: SocketHandler
  private options: Required<SocketServerOptions>
  private events: SocketServerEvents = {}
  private connections: Set<WebSocket> = new Set()

  constructor(options: SocketServerOptions) {
    this.options = {
      host: '0.0.0.0',
      delimiter: '\n',
      maxConnections: 100,
      ...options,
    }
    this.handler = createSocketHandler()
  }

  on<K extends keyof SocketServerEvents>(
    event: K,
    callback: NonNullable<SocketServerEvents[K]>,
  ): void {
    this.events[event] = callback as never
  }

  off<K extends keyof SocketServerEvents>(event: K): void {
    delete this.events[event]
  }

  getHandler(): SocketHandler {
    return this.handler
  }

  getServer(): WebSocketServer | null {
    return this.server
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = new WebSocketServer({
        port: this.options.port,
        host: this.options.host,
      })

      this.server.on('error', (error: Error) => {
        logger.error({ error }, 'Socket server error')
        this.events.onError?.(error)
      })

      this.server.on('listening', () => {
        logger.info({ port: this.options.port, host: this.options.host }, 'Socket server started')
        resolve()
      })

      this.server.on('close', () => {
        logger.info('Socket server closed')
      })

      this.server.on('connection', (socket: WebSocket) => {
        this.handleConnection(socket)
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }

      for (const socket of this.connections) {
        socket.close()
      }
      this.connections.clear()

      this.server.close(() => {
        this.server = null
        logger.info('Socket server stopped')
        resolve()
      })
    })
  }

  private handleConnection(socket: WebSocket): void {
    if (this.connections.size >= this.options.maxConnections) {
      const response = ResponseBuilder.error('Max connections reached', 503)
      socket.send(JSON.stringify(response) + this.options.delimiter)
      socket.close()
      return
    }

    this.connections.add(socket)
    this.events.onConnection?.(socket)

    let buffer = ''

    socket.on('message', async (data: Buffer) => {
      buffer += data.toString()

      const messages = buffer.split(this.options.delimiter)
      buffer = messages.pop() || ''

      for (const message of messages) {
        if (message.trim()) {
          await this.processMessage(message.trim(), socket)
        }
      }
    })

    socket.on('close', () => {
      this.connections.delete(socket)
      this.events.onDisconnect?.(socket)
    })

    socket.on('error', (error: Error) => {
      logger.error({ error }, 'Socket connection error')
      this.events.onError?.(error, socket)
    })
  }

  private async processMessage(message: string, socket: WebSocket): Promise<void> {
    let request: SocketRequest

    try {
      request = JSON.parse(message) as SocketRequest
    } catch {
      const response = ResponseBuilder.error('Invalid JSON format', 400)
      this.sendResponse(socket, response)
      return
    }

    if (!request.command) {
      const response = ResponseBuilder.error('Missing command field', 400, request.requestId)
      this.sendResponse(socket, response)
      return
    }

    this.events.onMessage?.(request, socket)

    try {
      const response = await this.handler.handle(request, socket)
      if (response) {
        this.sendResponse(socket, response)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const response = ResponseBuilder.error(errorMessage, 500, request.requestId)
      this.sendResponse(socket, response)
    }
  }

  private sendResponse<T>(socket: WebSocket, response: SocketResponse<T>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response) + this.options.delimiter)
    }
  }

  broadcast<T>(response: SocketResponse<T>): void {
    const message = JSON.stringify(response) + this.options.delimiter
    for (const socket of this.connections) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message)
      }
    }
  }

  getActiveConnections(): number {
    return this.connections.size
  }

  isRunning(): boolean {
    return this.server !== null
  }
}

export function createSocketServer(options: SocketServerOptions): SocketServer {
  return new SocketServer(options)
}

export { SocketHandler, createSocketHandler } from './handler'
export { HybridServer, createHybridServer, getHybridServer, isPortInUse } from './hybrid-server'
export type { HybridServerOptions, HybridServerEvents } from './hybrid-server'
export * from './types'
