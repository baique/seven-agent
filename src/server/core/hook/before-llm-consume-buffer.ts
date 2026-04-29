import { messageProcessor } from '../graph/message-processor'
import { HumanMessage } from '@langchain/core/messages'
import type { MessagesState } from '../state/llm-state'
import { logger } from '../../utils/logger'

/**
 * 在LLM调用前消费buffer消息
 * 当 llmCalls > 0 时（工具响应后重新进入LLM），从消息队列中消费pending的buffer消息
 * 并将其添加到state.messages中
 *
 * @param state LangGraph状态
 * @returns 消费结果，如果消费了buffer消息则返回消息ID和内容，否则返回null
 */
export default function BeforeLLMConsumeBuffer(
  state: typeof MessagesState.State,
): { id: string; content: string } | null {
  if (state.llmCalls <= 0) {
    return null
  }

  const bufferedMessage = messageProcessor.consumePendingMessage()
  if (!bufferedMessage) {
    return null
  }

  logger.info(
    `[BeforeLLMConsumeBuffer] 消费buffer消息 <${bufferedMessage.id}>: ${bufferedMessage.content.substring(0, 50)}`,
  )

  state.messages.push(new HumanMessage(bufferedMessage.content))

  return { id: bufferedMessage.id, content: bufferedMessage.content }
}
