import { logger } from '../../utils/logger'
import { STATE_CONTEXT } from '../state/context/impl/character-state'
import { SocketResponseType } from '../../socket'
import type { AfterToolCallParams } from './types'

/**
 * 在 update_mood_values 工具调用后，推送人格状态更新到目标 socket
 *
 * @param params afterToolCall hook 参数
 */
export default function AfterToolCallPersonalityUpdate(params: AfterToolCallParams): void {
  if (params.toolName !== 'update_mood_values' || !params.socket) {
    return
  }

  const state = STATE_CONTEXT.getState()
  const data = {
    pad: state.pad,
    bigFive: state.bigFive,
    moodDescription: state.moodDescription,
    activity: state.activity,
  }

  try {
    params.socket.send(
      JSON.stringify({
        code: 200,
        message: '',
        type: SocketResponseType.PERSONALITY_UPDATED,
        data,
        timestamp: Date.now(),
      }) + '\n',
    )
    logger.debug(`[Hook] ${SocketResponseType.PERSONALITY_UPDATED} 已推送到目标socket`)
  } catch (error) {
    logger.error({ error }, `[Hook] 推送 ${SocketResponseType.PERSONALITY_UPDATED} 失败`)
  }
}
