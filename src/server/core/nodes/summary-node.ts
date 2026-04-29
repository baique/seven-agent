import type { GraphNode } from '@langchain/langgraph'
import { logger } from '../../utils/logger'
import type { MessagesState } from '../state/llm-state'
import { checkAndRunSessionNotes } from '../summary'
import { handleExtremeContext } from '../summary/extreme'

/**
 * 摘要节点
 * 在 LLM 节点之前执行，检查是否需要触发会话笔记（V3）
 */
export const SummaryNode: GraphNode<typeof MessagesState.State> = async (_state) => {
  try {
    const extremeExecuted = await handleExtremeContext()
    if (extremeExecuted) {
      return {
        requestId: _state.requestId,
      }
    }
  } catch (error) {
    logger.error({ error }, `[SummaryNode] 极限上下文处理失败: ${(error as Error).message}`)
  }

  try {
    await checkAndRunSessionNotes()
  } catch (error) {
    logger.error({ error }, `[SummaryNode] 会话笔记执行失败: ${(error as Error).message}`)
  }

  return {
    requestId: _state.requestId,
  }
}
