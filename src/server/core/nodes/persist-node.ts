import { RemoveMessage } from '@langchain/core/messages'
import type { GraphNode } from '@langchain/langgraph'
import { GLOBAL_MEMORY, type MemoryMessage } from '../../memory'
import { logger } from '../../utils/logger'
import type { MessagesState } from '../state/llm-state'
import { convertBaseMessageToMemoryMessage } from '../../utils'
import { BUFFER_WINDOW_CONTEXT } from '../state/context/impl/buffer-window'

// const processedMessageIds = new Set<string>()

export const PersistNode: GraphNode<typeof MessagesState> = async (state) => {
  const messages = state.messages
  if (!messages || messages.length === 0) {
    return { persisted: true }
  }

  const memoryMessages: MemoryMessage[] = []

  for (const msg of messages) {
    const memoryMsg = convertBaseMessageToMemoryMessage(msg)
    if (memoryMsg) {
      memoryMessages.push(memoryMsg)
    }
  }

  if (memoryMessages.length > 0) {
    try {
      await GLOBAL_MEMORY.appendMessages(memoryMessages)
      logger.info(`[PersistNode] 消息已保存 ${memoryMessages.length} 条`)
    } catch (error) {
      logger.error(error, '[PersistNode] 保存消息失败')
    }
  }

  if (messages.length > 0) {
    // 追加消息到缓冲区窗口和计数器
    BUFFER_WINDOW_CONTEXT.append(messages)
  }

  return {
    // 从状态机置换出去
    messages: messages.filter((msg) => msg.id).map((msg) => new RemoveMessage({ id: msg.id! })),
  }
}
