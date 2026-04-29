import { GraphNode } from '@langchain/langgraph'
import { logger } from '../../utils'
import { toolRegister } from '../tools/tool-register'
import { getReviewManager, requiresReview, REVIEW_MESSAGES } from '../review'

import { AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages'
import { MessagesState } from '../state/llm-state'
import { hookManager } from '../hook'
import { getChatCancelManager } from '../state/chat-cancel'

export const TaskToolNode: GraphNode<typeof MessagesState> = async (state) => {
  const lastMessage = state.messages.at(-1)

  logger.debug(
    {
      lastMessageType: lastMessage?.constructor?.name,
      lastMessageContent: lastMessage?.content,
      tool_calls: AIMessage.isInstance(lastMessage) ? lastMessage.tool_calls : undefined,
    },
    '[ToolNode] 收到消息',
  )

  if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
    logger.warn('[ToolNode] 最后一条消息不是 AI 消息，无法处理工具调用')
    return { messages: [] }
  }

  const toolCalls = lastMessage.tool_calls ?? []
  if (toolCalls.length === 0) {
    logger.warn('[ToolNode] AI 消息中没有 tool_calls')
    return { messages: [] }
  }

  logger.info(`[ToolNode] 准备执行 ${toolCalls.length} 个工具调用`)

  const reviewManager = getReviewManager()
  const cancelManager = getChatCancelManager()
  const socket = state.requestId ? cancelManager.getSocket(state.requestId) : undefined
  const results: ToolMessage[] = []

  // 获取最后一条用户消息用于Hook
  const lastUserMessage = state.messages
    .slice()
    .reverse()
    .find((m) => HumanMessage.isInstance(m))
  const userMessageContent =
    typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : ''

  for (const toolCall of toolCalls) {
    if (state.cancelled) {
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? '',
          content: `用户取消了本次请求`,
          status: 'error',
        }),
      )
      continue
    }

    // 获取工具 - 使用统一注册中心（自动处理核心工具和MCP工具）
    const tool = await toolRegister.getTool(toolCall.name, { autoLoadMCP: true })

    if (!tool) {
      // 检查是否是 MCP 工具格式
      const isMCP = toolRegister.isMCPTool(toolCall.name)
      let errorMessage: string

      if (isMCP) {
        // 是 MCP 工具但无法装载（服务器不存在或工具不存在）
        errorMessage = `MCP 工具 ${toolCall.name} 无法使用。请检查：1) 服务器配置是否正确 2) 工具名称是否正确`
        logger.info(`[ToolNode] MCP 工具无法装载: ${toolCall.name}`)
      } else {
        // 普通工具不存在
        errorMessage = `工具 ${toolCall.name} 不存在。请使用 ext_list 查看可用扩展工具。`
      }

      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? '',
          content: errorMessage,
          status: 'error',
        }),
      )
      continue
    }

    const mode = reviewManager.getMode()

    if (mode === 'manual' && requiresReview(toolCall.name)) {
      logger.debug({ toolName: toolCall.name }, '[TaskAgent] 工具需要审查')

      const result = await reviewManager.createReview({
        id: toolCall.id ?? '',
        name: toolCall.name,
        args: toolCall.args as Record<string, unknown>,
      })

      if (!result.approved) {
        logger.info({ toolName: toolCall.name }, '[TaskAgent] 工具执行被拒绝')
        const rejectMessage = result.reason || REVIEW_MESSAGES.REJECTED
        results.push(
          new ToolMessage({
            tool_call_id: toolCall.id ?? '',
            content: rejectMessage,
            status: 'error',
          }),
        )
        continue
      }

      if (result.simulated) {
        logger.info({ toolName: toolCall.name }, '[TaskAgent] 工具执行模拟成功')
        const simulateMessage = result.reason || REVIEW_MESSAGES.SIMULATED
        results.push(
          new ToolMessage({
            tool_call_id: toolCall.id ?? '',
            content: simulateMessage,
            status: 'success',
          }),
        )
        continue
      }
    }

    try {
      logger.debug(`[TaskAgent] 执行工具: ${tool.name}`)

      // 触发工具调用前Hook（通用Hook先执行，然后执行工具特定Hook）
      await hookManager.emitToolHook('beforeToolCall' as const, {
        socket,
        message: userMessageContent,
        state,
        llmResponse: lastMessage,
        toolName: toolCall.name,
        toolArgs: toolCall.args as Record<string, unknown>,
        requestId: state.requestId || '',
      })

      const observation = await tool.invoke(toolCall)

      // 触发工具调用后Hook（通用Hook先执行，然后执行工具特定Hook）
      await hookManager.emitToolHook('afterToolCall' as const, {
        socket,
        message: userMessageContent,
        state,
        llmResponse: lastMessage,
        toolName: toolCall.name,
        toolArgs: toolCall.args as Record<string, unknown>,
        toolResponse: observation,
        requestId: state.requestId || '',
      })

      results.push(observation)
    } catch (e: any) {
      logger.error({ error: e.message, toolName: toolCall.name }, '[TaskAgent] 工具执行失败')
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? '',
          content: `执行失败: ${e.message || e}`,
          status: 'error',
        }),
      )
    }
  }

  let hasToolCalls = true
  if (results.length === 1) {
    const result = results[0]
    const toolCall = toolCalls.find((t) => t.id === result.tool_call_id)
    if (toolCall?.name === 'open_window' && typeof result.content === 'string') {
      try {
        const data = JSON.parse(result.content)
        hasToolCalls = data.success && data.data?.continueProcessing !== false
      } catch {
        hasToolCalls = true
      }
    }
  }

  return { messages: results, hasToolCalls }
}
