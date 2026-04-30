import { applyRetentionPolicy } from '../../utils/tool-response-parser'
import { BUFFER_WINDOW_CONTEXT } from '../state/context/impl/buffer-window'
import { logger } from '../../utils/logger'

/**
 * 在请求开始时应用工具保留策略
 * 清理 BUFFER_WINDOW_CONTEXT 中消息的 rawBody，减少上下文体积
 *
 * @returns 是否进行了清理
 */
export default function BeforeRequestRetentionPolicy(): boolean {
  const messages = BUFFER_WINDOW_CONTEXT.getMessages()
  const cleaned = applyRetentionPolicy(messages)

  if (cleaned) {
    logger.info('[BeforeRequestRetentionPolicy] 已应用工具保留策略清理 rawBody')
  }

  return cleaned
}
