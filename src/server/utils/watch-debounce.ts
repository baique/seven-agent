import { watch, type FSWatcher } from 'node:fs'
import { logger } from './logger'

export interface WatchDebounceOptions {
  /** 防抖延迟（毫秒），默认 500ms */
  debounceMs?: number
  /** 是否递归监听目录 */
  recursive?: boolean
  /** 文件过滤器，返回 true 表示应该处理此文件 */
  filter?: (filename: string) => boolean
  /** 是否立即执行一次（启动时），默认 false */
  immediate?: boolean
  /** 错误处理器 */
  onError?: (error: Error) => void
}

export interface WatchDebounceInstance {
  /** 停止监听 */
  stop: () => void
  /** 手动触发重新加载（清除防抖，立即执行回调） */
  trigger: () => void
}

/**
 * 创建带防抖的文件监听实例
 * @param targetPath 要监听的文件或目录路径
 * @param callback 文件变化时的回调（带防抖）
 * @param options 配置选项
 * @returns 监听实例
 */
export function watchWithDebounce(
  targetPath: string,
  callback: () => void | Promise<void>,
  options: WatchDebounceOptions = {},
): WatchDebounceInstance {
  const { debounceMs = 500, recursive = false, filter, immediate = false, onError } = options

  let watcher: FSWatcher | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let isWatching = false

  function scheduleCallback() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null
      try {
        await callback()
      } catch (error) {
        if (onError) {
          onError(error instanceof Error ? error : new Error(String(error)))
        } else {
          logger.error({ error }, '[WatchDebounce] 回调执行失败')
        }
      }
    }, debounceMs)
  }

  function startWatching() {
    if (isWatching) return

    try {
      watcher = watch(targetPath, { recursive }, (_eventType, filename) => {
        if (filename && filter && !filter(filename)) {
          return
        }
        logger.debug(`[WatchDebounce] 检测到变化: ${filename}`)
        scheduleCallback()
      })

      watcher.on('error', (error) => {
        if (onError) {
          onError(error instanceof Error ? error : new Error(String(error)))
        } else {
          logger.error({ error }, '[WatchDebounce] 监听出错')
        }
      })

      isWatching = true
      logger.debug(`[WatchDebounce] 开始监听: ${targetPath}`)

      if (immediate) {
        scheduleCallback()
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (onError) {
        onError(err)
      } else {
        logger.error({ error: err }, `[WatchDebounce] 启动监听失败: ${targetPath}`)
      }
    }
  }

  function stop() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (watcher) {
      watcher.close()
      watcher = null
    }
    isWatching = false
    logger.debug(`[WatchDebounce] 已停止监听: ${targetPath}`)
  }

  function trigger() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    scheduleCallback()
  }

  startWatching()

  return { stop, trigger }
}

export type DebouncedCallback<T extends unknown[] = unknown[]> = (
  ...args: T
) => void | Promise<void>

export interface SimpleDebounceOptions {
  /** 防抖延迟（毫秒），默认 500ms */
  debounceMs?: number
  /** 是否在首次调用时立即执行，默认 false */
  immediate?: boolean
}

/**
 * 创建防抖函数
 * @param callback 回调函数
 * @param options 配置选项
 * @returns 防抖函数（带 cancel 方法）
 */
export function debounce<T extends unknown[]>(
  callback: DebouncedCallback<T>,
  options: SimpleDebounceOptions = {},
): DebouncedCallback<T> & { cancel: () => void } {
  const { debounceMs = 500, immediate = false } = options
  let timer: NodeJS.Timeout | null = null
  let lastArgs: T | null = null

  function fn(...args: T) {
    lastArgs = args

    if (timer) {
      clearTimeout(timer)
    }

    if (immediate && !timer) {
      try {
        callback(...args)
      } catch {}
    }

    timer = setTimeout(() => {
      timer = null
      if (!immediate && lastArgs) {
        try {
          callback(...lastArgs)
        } catch {}
      }
      lastArgs = null
    }, debounceMs)
  }

  fn.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    lastArgs = null
  }

  return fn
}
