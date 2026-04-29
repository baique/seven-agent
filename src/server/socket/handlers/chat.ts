import type { SocketRequest } from '../types'
import { ResponseBuilder, SocketResponseType } from '../types'
import { createAgent } from '../../core/graph'
import { HumanMessage } from '@langchain/core/messages'
import { LLMResponseParser } from '../parser'
import { logger } from '../../utils'
import { CharacterStateManager } from '../../core/state/context/impl/character-state'
import { getChatCancelManager } from '../../core/state/chat-cancel'
import { messageProcessor } from '../../core/graph/message-processor'
import type { WebSocket } from 'ws'
import { hookManager } from '../../core/hook'

export interface ChatRequest {
  message: string
}

let graph: Awaited<ReturnType<typeof createAgent>> | null = null

async function getGraph() {
  if (!graph) {
    graph = await createAgent()
  }
  return graph
}

/**
 * 初始化消息处理器
 */
function initMessageProcessor(sm: CharacterStateManager): void {
  messageProcessor.setHandler(async (message, messageId, socket, broadcast) => {
    const graph = await getGraph()
    const ws = socket || createBroadcastProxy(broadcast)
    const parser = new LLMResponseParser(sm, messageId, ws)
    const cancelManager = getChatCancelManager()
    const abortController = cancelManager.getAbortController(messageId!)

    try {
      const stream = await graph.stream(
        { messages: [new HumanMessage(message)], requestId: messageId },
        {
          configurable: { thread_id: 'main' },
          streamMode: ['updates', 'messages'],
          recursionLimit: 5000,
          signal: abortController?.signal,
        },
      )

      for await (const chunk of stream) {
        // 检查连接状态
        if (ws.readyState !== 1) {
          logger.warn(`[Chat] WebSocket 连接已断开，终止流式传输 <${messageId}>`)
          parser.abortAllStreaming('connection_lost')
          break
        }

        // 检查是否被取消
        if (abortController?.signal.aborted) {
          logger.info(`[Chat] 请求被取消，终止流式传输 <${messageId}>`)
          parser.abortAllStreaming('cancelled')
          break
        }

        await parser.parseChunk(chunk)
      }
    } catch (error) {
      // 判断是否为可忽略的流关闭错误
      const isStreamClosedError = (err: unknown): boolean => {
        if (!(err instanceof Error)) return false
        const msg = err.message || ''
        return (
          msg.includes('Controller is already closed') ||
          msg.includes('StreamMessagesHandler') ||
          msg.includes('handleLLMNewToken') ||
          msg.includes('ReadableStream') ||
          err.name === 'InvalidStateError'
        )
      }

      // 区分不同类型的错误
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info(`[Chat] 请求被中止 <${messageId}>`)
          parser.abortAllStreaming('cancelled')
          return
        } else if (isStreamClosedError(error)) {
          // LangChain 内部流关闭后的回调错误，可忽略
          logger.debug(`[Chat] 流已关闭，忽略回调错误 <${messageId}>`)
          parser.abortAllStreaming('cancelled')
          return
        } else if (error.message?.includes('rate limit')) {
          logger.error(error, `[Chat] 触发限流 <${messageId}>`)
          parser.abortAllStreaming('rate_limited')
        } else if (error.message?.includes('timeout')) {
          logger.error(error, `[Chat] 请求超时 <${messageId}>`)
          parser.abortAllStreaming('timeout')
        } else {
          logger.error(error, `[Chat] 流式处理错误 <${messageId}>`)
          parser.abortAllStreaming('error')
        }
      } else {
        logger.error(error, `[Chat] 未知错误 <${messageId}>`)
        parser.abortAllStreaming('error')
      }
      throw error
    }
  })
}

/**
 * 创建广播代理对象，模拟WebSocket接口
 */
function createBroadcastProxy(broadcast: (data: unknown) => void): WebSocket {
  return {
    send: (data: unknown) => broadcast(data),
    readyState: 1,
  } as WebSocket
}

export function createChatHandler(sm: CharacterStateManager) {
  const cancelManager = getChatCancelManager()

  initMessageProcessor(sm)

  return async (data: ChatRequest, request: SocketRequest<ChatRequest>, socket?: WebSocket) => {
    const { message } = data
    const requestId = request.requestId!

    if (!message || typeof message !== 'string') {
      return ResponseBuilder.error('Message is required', 400, requestId)
    }

    logger.info(`收到消息: <${requestId}>${message.substring(0, 50)}`)

    // 触发请求开始前Hook
    await hookManager.emit('beforeRequest' as const, {
      socket,
      message,
      requestId,
    })

    let success = false
    let errorMessage: string | undefined

    try {
      messageProcessor.sendOrBroadcast(socket, {
        code: 200,
        type: SocketResponseType.REQUEST_START,
        data: { requestId },
        timestamp: Date.now(),
        requestId,
      })

      cancelManager.registerChat(requestId, socket)

      await messageProcessor.addMessage(message, socket, requestId)

      logger.info(`消息处理完成 <${requestId}>`)
      success = true

      return ResponseBuilder.success<boolean>(true, 'Completed', requestId)
    } catch (error) {
      logger.error(error, `消息处理失败 <${requestId}> ${message.substring(0, 50)}`)
      errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return ResponseBuilder.error(`Chat failed: ${errorMessage}`, 500, requestId)
    } finally {
      messageProcessor.sendOrBroadcast(socket, {
        code: 200,
        type: SocketResponseType.REQUEST_COMPLETE,
        data: { requestId },
        timestamp: Date.now(),
        requestId,
      })

      cancelManager.clearChat(requestId)

      // 触发请求结束后Hook
      await hookManager.emit('afterRequest' as const, {
        socket,
        message,
        requestId,
        success,
        cancelled: cancelManager.isCancelled(requestId),
        cancelReason: cancelManager.getCancelReason(requestId),
        error: errorMessage,
      })
    }
  }
}
