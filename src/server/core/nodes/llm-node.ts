import type { GraphNode } from '@langchain/langgraph'
import { logger } from '../../utils/logger'
import type { MessagesState } from '../state/llm-state'

import { BrainSpeak } from './agent/brain'
import { getChatCancelManager } from '../state/chat-cancel'
import { CTX } from '../state/context'
import { hookManager } from '../hook'

export const LLMNode: GraphNode<typeof MessagesState.State> = async (state) => {
  // 获取取消控制器（由 chat.ts 注册）
  const cancelManager = getChatCancelManager()
  const requestId = state.requestId
  const abortController = requestId ? cancelManager.getAbortController(requestId) : undefined
  const socket = requestId ? cancelManager.getSocket(requestId) : undefined

  logger.info('[LLM] 开始处理消息……')

  // 获取最新消息（用于Hook参数）
  const latestMessage = state.messages.at(-1)

  try {
    // 触发LLM调用前Hook（系统hook会在此处消费buffer消息）
    await hookManager.emit('beforeLLM' as const, {
      socket,
      latestMessage: latestMessage || undefined,
      state,
      requestId: requestId || '',
    })

    // LLM节点开始处理，构建上下文消息
    const context = await CTX.createMessageContext(state.messages)

    logger.debug('[LLM] 思考……')

    // 调用 BrainSpeak
    const { message: think, usage } = await BrainSpeak(context, abortController?.signal)

    // 设置 LLM 返回的 usage
    CTX.setRawUsage(usage)
    logger.debug({ response: think, usage }, '[LLM] 思考结果:')

    // 检查是否被取消
    const isCancelled = requestId ? cancelManager.isCancelled(requestId) : false

    // 触发LLM调用后Hook（无论是否取消都要触发）
    await hookManager.emit('afterLLM' as const, {
      socket,
      latestMessage: latestMessage || undefined,
      state,
      llmResponse: think,
      requestId: requestId || '',
      cancelled: isCancelled,
    })

    if (isCancelled) {
      logger.info('[LLM] 请求已被取消，不返回结果')
      return { messages: [], cancelled: true }
    }

    return {
      messages: [think],
      llmCalls: 1,
      hasToolCalls: false,
    }
  } catch (err) {
    // 检查是否是取消错误
    if (err instanceof Error && err.name === 'AbortError') {
      logger.info('[LLM] 请求被取消')

      // 取消时也要触发 afterLLM hook
      await hookManager.emit('afterLLM' as const, {
        socket,
        latestMessage: latestMessage || undefined,
        state,
        llmResponse: state.messages.at(-1) || null,
        requestId: requestId || '',
        cancelled: true,
      })

      return { messages: [], cancelled: true }
    }
    throw err
  } finally {
    logger.info('[LLM] 处理消息完成')
  }
}
