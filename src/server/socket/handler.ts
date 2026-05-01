import type { SocketRequest, SocketResponse } from './types'
import { ResponseBuilder } from './types'
import type { WebSocket } from 'ws'

export type CommandHandler<T = unknown, R = unknown> = (
  data: T,
  request: SocketRequest<T>,
  socket?: WebSocket,
) => Promise<SocketResponse<R> | void> | SocketResponse<R> | void

export interface CommandRegistry {
  [command: string]: CommandHandler
}

export class SocketHandler {
  private commandRegistry: CommandRegistry = {}

  register<T = unknown, R = unknown>(command: string, handler: CommandHandler<T, R>): void {
    if (this.commandRegistry[command]) {
      console.warn(`Command "${command}" is already registered and will be overwritten`)
    }
    this.commandRegistry[command] = handler as CommandHandler
  }

  unregister(command: string): boolean {
    if (this.commandRegistry[command]) {
      delete this.commandRegistry[command]
      return true
    }
    return false
  }

  hasCommand(command: string): boolean {
    return command in this.commandRegistry
  }

  // 这些命令由特定的监听器处理，不需要注册 handler
  private passthroughCommands = new Set(['screenshot:result'])

  async handle<T = unknown>(
    request: SocketRequest<T>,
    socket?: WebSocket,
  ): Promise<SocketResponse | null> {
    const { command, data, requestId } = request

    const handler = this.commandRegistry[command]

    if (!handler) {
      // 对于 passthrough 命令，不返回错误，让其他监听器处理
      if (this.passthroughCommands.has(command)) {
        return null
      }
      return ResponseBuilder.error(`Unknown command: ${command}`, 404, requestId)
    }

    try {
      const result = await handler(data, request, socket)
      if (result === undefined || result === null) {
        return null
      }
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      return ResponseBuilder.error(`Command "${command}" failed: ${errorMessage}`, 500, requestId)
    }
  }

  getRegisteredCommands(): string[] {
    return Object.keys(this.commandRegistry)
  }

  clear(): void {
    this.commandRegistry = {}
  }
}

export function createSocketHandler(): SocketHandler {
  return new SocketHandler()
}
