import { logger } from '../../utils/logger'
import { SocketResponseType } from '../../socket'
import { terminalManagerSingleton } from '../../terminal/TerminalManager'
import type { AfterToolCallParams } from './types'

/**
 * 在 terminal 工具调用后，推送终端状态更新到目标 socket
 *
 * 注意：terminal:output 和 terminal:status_changed 是实时流事件，
 * 由 TerminalSession 直接产生。此 hook 只处理工具调用相关的终端事件。
 *
 * @param params afterToolCall hook 参数
 */
export default function AfterToolCallTerminal(params: AfterToolCallParams): void {
  if (!params.socket) {
    return
  }

  const { toolName } = params

  if (toolName !== 'terminal') {
    return
  }

  const args = params.toolArgs as { action: string; sessionId?: string }

  // 根据 action 类型推送相应的终端事件
  switch (args.action) {
    case 'exec': {
      // exec 操作可能创建新会话，推送会话创建事件
      const sessionId = args.sessionId
      if (sessionId) {
        const session = terminalManagerSingleton.getSession(sessionId)
        if (session) {
          try {
            params.socket.send(
              JSON.stringify({
                code: 200,
                message: '',
                type: SocketResponseType.TERMINAL_SESSION_CREATED,
                data: { sessionId },
                timestamp: Date.now(),
              }) + '\n',
            )
            logger.debug(`[Hook] ${SocketResponseType.TERMINAL_SESSION_CREATED} 已推送到目标socket`)
          } catch (error) {
            logger.error({ error }, `[Hook] 推送 ${SocketResponseType.TERMINAL_SESSION_CREATED} 失败`)
          }
        }
      }
      break
    }
    case 'interrupt':
      logger.debug(`[Hook] terminal interrupt 操作完成，sessionId: ${args.sessionId}`)
      break
    case 'printScreen':
    case 'printDiffScreen':
      // 屏幕打印操作，结果在 toolResponse 中返回，不需要额外推送
      break
    default:
      break
  }
}
