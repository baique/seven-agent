import { logger } from '../../utils/logger'
import { SocketResponseType, getHybridServer } from '../../socket'
import type { AfterSummaryParams } from './types'

/**
 * 在摘要完成后，发送摘要完成事件
 *
 * 注意：摘要是在后台定时触发的，不是由特定请求触发的，
 * 因此通过 hybridServer 广播给所有连接的客户端。
 *
 * @param params afterSummary hook 参数
 */
export default function AfterSummary(params: AfterSummaryParams): void {
  const { beforeTokens, afterTokens, savedTokens } = params

  const server = getHybridServer()
  if (!server) {
    return
  }

  try {
    server.broadcast({
      code: 200,
      message: '',
      type: SocketResponseType.SUMMARY_COMPLETE,
      data: {
        beforeTokens,
        afterTokens,
        savedTokens,
      },
      timestamp: Date.now(),
    })
    logger.debug(`[Hook] ${SocketResponseType.SUMMARY_COMPLETE} 已发送`)
  } catch (error) {
    logger.error({ error }, `[Hook] 发送 ${SocketResponseType.SUMMARY_COMPLETE} 失败`)
  }
}
