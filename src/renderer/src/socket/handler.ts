import type { SocketResponse } from './types'

export type ResponseHandler<T = unknown> = (response: SocketResponse<T>) => void

export interface HandlerRegistry {
  [command: string]: ResponseHandler
}

export class MessageHandler {
  private handlerRegistry: HandlerRegistry = {}

  register<T = unknown>(command: string, handler: ResponseHandler<T>): void {
    if (this.handlerRegistry[command]) {
      console.warn(`Handler for command "${command}" is already registered and will be overwritten`)
    }
    this.handlerRegistry[command] = handler as ResponseHandler
  }

  unregister(command: string): boolean {
    if (this.handlerRegistry[command]) {
      delete this.handlerRegistry[command]
      return true
    }
    return false
  }

  hasHandler(command: string): boolean {
    return command in this.handlerRegistry
  }

  handle<T = unknown>(response: SocketResponse<T>): void {
    const messageType = response.type || response.command
    const handler = this.handlerRegistry[messageType as string]

    if (handler) {
      try {
        handler(response)
      } catch (error) {
        console.error(`Error executing handler for type "${messageType}":`, error)
      }
    }

    if (response.requestId) {
      const requestHandler = this.handlerRegistry[`req:${response.requestId}`]
      if (requestHandler) {
        try {
          requestHandler(response)
        } catch (error) {
          console.error(`Error executing handler for request "${response.requestId}":`, error)
        }
        delete this.handlerRegistry[`req:${response.requestId}`]
      }
    }
  }

  getRegisteredHandlers(): string[] {
    return Object.keys(this.handlerRegistry)
  }

  clear(): void {
    this.handlerRegistry = {}
  }
}

export function createMessageHandler(): MessageHandler {
  return new MessageHandler()
}
