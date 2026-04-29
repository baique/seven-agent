import { rm } from 'node:fs/promises'
import path from 'node:path'
import { paths, configManager } from '../config/env'
import { logger } from '../utils'
import { scheduler } from '.'

let cleanupJobId: string | null = null

/**
 * 清理旧文件
 */
export async function cleanupOldFiles(): Promise<void> {
  try {
    const days = configManager.get('CLEANUP_OLD_FILES_DAYS')
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    logger.info(`[Cleanup] 开始清理超过 ${days} 天的旧文件`)

    let cleanedCount = 0
    let cleanedSize = 0

    await cleanupDirectory(paths.CACHE_DIR, cutoffDate, 'cache', (_filePath, stats) => {
      cleanedCount++
      cleanedSize += stats.size
    })

    const tempDir = path.join(paths.CACHE_DIR, 'temp')
    await cleanupDirectory(tempDir, cutoffDate, 'temp', (_filePath, stats) => {
      cleanedCount++
      cleanedSize += stats.size
    })

    logger.info(`[Cleanup] 清理完成: 删除 ${cleanedCount} 个文件, 释放 ${formatBytes(cleanedSize)}`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[Cleanup] 清理失败: ${errorMsg}`)
  }
}

/**
 * 清理7天前的笔记审计文件
 */
export async function cleanupOldNotes(): Promise<void> {
  try {
    const days = 7
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const notesDir = path.join(paths.WORKSPACE_ROOT, 'context', 'remember', 'notes')

    logger.info(`[Cleanup] 开始清理超过 ${days} 天的笔记审计文件`)

    let cleanedCount = 0
    let cleanedSize = 0

    await cleanupDirectory(notesDir, cutoffDate, 'notes', (_filePath, stats) => {
      cleanedCount++
      cleanedSize += stats.size
    })

    logger.info(
      `[Cleanup] 笔记审计文件清理完成: 删除 ${cleanedCount} 个文件, 释放 ${formatBytes(cleanedSize)}`,
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[Cleanup] 笔记审计文件清理失败: ${errorMsg}`)
  }
}

async function cleanupDirectory(
  dirPath: string,
  cutoffDate: Date,
  dirType: string,
  onCleanup: (filePath: string, stats: import('node:fs').Stats) => void,
): Promise<void> {
  try {
    const { readdir, stat } = await import('node:fs/promises')

    const files = await readdir(dirPath)

    for (const file of files) {
      const filePath = path.join(dirPath, file)
      try {
        const stats = await stat(filePath)

        if (stats.isDirectory()) {
          await cleanupDirectory(filePath, cutoffDate, dirType, onCleanup)
        } else if (stats.isFile()) {
          if (stats.mtime < cutoffDate) {
            await rm(filePath, { force: true })
            onCleanup(filePath, stats)
            logger.debug(`[Cleanup] 删除文件: ${filePath}`)
          }
        }
      } catch (error) {
        logger.warn(`[Cleanup] 处理文件失败 ${filePath}: ${error}`)
      }
    }
  } catch (error) {
    // 目录不存在时忽略错误
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[Cleanup] 读取目录失败 ${dirPath}: ${error}`)
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * 启动清理定时任务
 * @param cronExpression cron 表达式，默认每小时执行一次
 */
export function startCleanupScheduler(cronExpression: string = '0 * * * *'): void {
  if (cleanupJobId) {
    logger.warn('[Cleanup] 定时任务已存在，跳过启动')
    return
  }

  cleanupJobId = scheduler.addJob({
    name: 'cleanup-old-files',
    cronExpression,
    handler: async () => {
      // 清理旧文件
      await cleanupOldFiles()
      // 清理7天前的笔记审计文件
      await cleanupOldNotes()
    },
    enabled: true,
  })

  logger.info(`[Cleanup] 定时任务已启动，cron: ${cronExpression}`)
}

/**
 * 停止清理定时任务
 */
export function stopCleanupScheduler(): void {
  if (cleanupJobId) {
    scheduler.removeJob(cleanupJobId)
    cleanupJobId = null
    logger.info('[Cleanup] 定时任务已停止')
  }
}
