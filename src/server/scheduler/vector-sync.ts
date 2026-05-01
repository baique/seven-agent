import { scheduler } from '.'
import { vectorMemoryService } from '../memory'
import { logger } from '../utils/logger'

let syncJobId: string | null = null

export async function runVectorSync(): Promise<void> {
  try {
    if (!vectorMemoryService.isInitialized()) {
      logger.debug('[VectorSync] 向量记忆服务未初始化，跳过同步')
      return
    }

    await vectorMemoryService.catchUpSync()
  } catch (err) {
    logger.error({ err }, '[VectorSync] 向量兜底同步执行失败')
  }
}

export function startVectorSyncScheduler(cronExpression: string = '*/5 * * * *'): void {
  if (syncJobId) {
    logger.warn('[VectorSync] 定时任务已存在，跳过启动')
    return
  }

  syncJobId = scheduler.addJob({
    name: 'vector-sync',
    cronExpression,
    handler: runVectorSync,
    enabled: true,
  })

  logger.info(`[VectorSync] 定时任务已启动，cron: ${cronExpression}`)
}

export function stopVectorSyncScheduler(): void {
  if (syncJobId) {
    scheduler.removeJob(syncJobId)
    syncJobId = null
    logger.info('[VectorSync] 定时任务已停止')
  }
}
