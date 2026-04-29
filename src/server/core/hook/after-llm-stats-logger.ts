import { logger } from '../../utils/logger'
import { CTX } from '../state/context'
import type { AfterLLMParams } from './types'
import type { ContextStats } from '../state/context'
import { SocketResponseType } from '../../socket'

function formatTokenStats(contextStats: ContextStats, llmUsage?: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push('========== Token 统计情况 ==========')

  if (llmUsage) {
    lines.push('[LLM 真实统计]')
    lines.push(JSON.stringify(llmUsage, null, 2))
    lines.push('')
  }

  lines.push('[Context 各层统计]')
  lines.push(JSON.stringify(contextStats.state, null, 2))
  lines.push('====================================')

  return lines.join('\n')
}

/**
 * 在 afterLLM 时输出统计信息
 * 仅在 dev 环境下输出 Token 使用统计
 *
 * @param params afterLLM hook 参数
 */
export default function AfterLLMStatsLogger(params: AfterLLMParams): void {
  const { socket, requestId } = params

  const usage = CTX.getRawUsage()

  if (usage && socket) {
    socket.send(
      JSON.stringify({
        code: 200,
        message: '',
        type: SocketResponseType.TOKEN_USAGE,
        data: usage,
        timestamp: Date.now(),
        requestId,
      }) + '\n',
    )
  }

  const isDev = process.env.NODE_ENV !== 'production'
  if (!isDev) {
    return
  }

  const contextStats = CTX.getContextDetails()

  logger.info(`\n${formatTokenStats(contextStats, usage)}`)
}
