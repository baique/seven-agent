import { logger } from '../../utils/logger'
import { SocketResponseType } from '../../socket'
import { taskManager } from '../tools/task/task-manager'
import type { AfterToolCallParams } from './types'

/**
 * 在 task 相关工具调用后，推送任务列表更新到目标 socket
 *
 * @param params afterToolCall hook 参数
 */
export default function AfterToolCallTask(params: AfterToolCallParams): void {
  if (!params.socket) {
    return
  }

  const { toolName } = params

  // 处理任务工具 - 推送任务列表更新
  if (
    toolName === 'create_tasks' ||
    toolName === 'update_task' ||
    toolName === 'delete_task'
  ) {
    // 异步获取任务列表并推送
    taskManager
      .queryTasks(true)
      .then((result) => {
        if (result.success && result.tasks) {
          try {
            params.socket!.send(
              JSON.stringify({
                code: 200,
                message: '',
                type: SocketResponseType.TASK_UPDATED,
                data: { tasks: result.tasks },
                timestamp: Date.now(),
              }) + '\n',
            )
            logger.debug(`[Hook] ${SocketResponseType.TASK_UPDATED} 已推送到目标socket`)
          } catch (error) {
            logger.error({ error }, `[Hook] 推送 ${SocketResponseType.TASK_UPDATED} 失败`)
          }
        }
      })
      .catch((error) => {
        logger.error({ error }, '[Hook] 获取任务列表失败')
      })
  }
}
