import { AIMessage } from '@langchain/core/messages'
import type { MessagesState } from '../state/llm-state'
import { BUFFER_WINDOW_CONTEXT } from '../state/context/impl/buffer-window'
import { formatTimeDiff, getSecondsDiff, logger } from '../../utils'
import { env } from '../../config/env'

/**
 * 在首次LLM调用前检查时间间隔，自动插入时间提示消息
 *
 * 逻辑：
 * 1. 仅在 llmCalls === 0 时执行（首次调用）
 * 2. 从 BUFFER_WINDOW_CONTEXT 获取最后一条消息的时间戳
 * 3. 如果距离上次对话超过配置的间隔，插入时间间隔消息到 state.messages
 */
export default function AutoInsertTimeGap(state: typeof MessagesState.State): void {
  if (state.llmCalls !== 0) {
    return
  }

  const currentTime = Date.now()
  const bufferMessages = BUFFER_WINDOW_CONTEXT.getMessages()

  if (bufferMessages.length === 0) {
    return
  }

  const lastMessage = bufferMessages[bufferMessages.length - 1] as { timestamp?: number }
  const lastTimestamp = lastMessage?.timestamp || new Date().getTime()

  if (!lastTimestamp) {
    return
  }

  const seconds = getSecondsDiff(currentTime, lastTimestamp)

  if (seconds <= env.AUTO_INSERT_INTERVAL) {
    return
  }

  const timeDiff = currentTime - lastTimestamp
  const timeDiffStr = formatTimeDiff(timeDiff)
  const lastTimeStr = new Date(lastTimestamp).toLocaleString()

  logger.info(`[AutoInsertTimeGap] 距离上次记录时间间隔 ${timeDiffStr}，插入时间提示消息`)

  state.messages.push(
    new AIMessage(
      `[这是系统通知，在做出下一次回复前请考虑时差]用户上次和我对话是 ${lastTimeStr}，距今相差 ${timeDiffStr}`,
    ),
  )
}
