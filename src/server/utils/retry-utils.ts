/**
 * 重试工具类
 * 支持异步函数的重试操作
 */

/**
 * 重试选项
 */
export interface RetryOptions {
  /** 重试次数，默认3次 */
  maxRetries?: number
  /** 重试间隔（毫秒），默认1000ms */
  delayMs?: number
  /** 重试时的回调函数 */
  onRetry?: (attempt: number, error: Error) => void
  /** 是否在重试前等待 */
  waitBeforeRetry?: boolean
  /** 单次执行超时时间（毫秒），默认无超时 */
  timeoutMs?: number
}

/**
 * 创建带超时的 Promise
 * @param fn 要执行的函数
 * @param timeoutMs 超时时间（毫秒）
 * @returns 包装后的 Promise
 */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fn()
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    fn()
      .then((result) => {
        clearTimeout(timeoutId)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

/**
 * 重试执行函数
 * @param fn 要执行的函数（支持异步）
 * @param options 重试选项
 * @returns 函数执行结果
 */
export async function retry<T>(fn: () => Promise<T> | T, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, delayMs = 0, onRetry, waitBeforeRetry = true, timeoutMs } = options

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 如果设置了超时，使用 withTimeout 包装
      if (timeoutMs && timeoutMs > 0) {
        return await withTimeout(async () => fn(), timeoutMs)
      }
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (attempt < maxRetries) {
        // 执行重试回调
        if (onRetry) {
          onRetry(attempt, lastError)
        }

        // 等待一段时间后重试
        if (waitBeforeRetry) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }
  }

  // 所有重试都失败，抛出最后一个错误
  if (lastError) {
    throw lastError
  } else {
    throw new Error('Retry failed with no error')
  }
}

/**
 * 无限重试执行函数，直到成功为止
 * @param fn 要执行的函数（支持异步）
 * @param options 重试选项（maxRetries 设置无效，始终无限重试）
 * @returns 函数执行结果
 */
export async function retryForever<T>(
  fn: () => Promise<T> | T,
  options: Omit<RetryOptions, 'maxRetries'> = {},
): Promise<T> {
  const { delayMs = 5000, onRetry, waitBeforeRetry = true, timeoutMs } = options

  let attempt = 0

  while (true) {
    attempt++
    try {
      // 如果设置了超时，使用 withTimeout 包装
      if (timeoutMs && timeoutMs > 0) {
        return await withTimeout(async () => fn(), timeoutMs)
      }
      return await fn()
    } catch (error) {
      const lastError = error as Error

      // 执行重试回调
      if (onRetry) {
        onRetry(attempt, lastError)
      }

      // 等待一段时间后重试
      if (waitBeforeRetry) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
}

/**
 * 带指数退避的重试执行函数
 * @param fn 要执行的函数（支持异步）
 * @param options 重试选项
 * @returns 函数执行结果
 */
export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, delayMs = 1000, onRetry, waitBeforeRetry = true } = options

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (attempt < maxRetries) {
        // 执行重试回调
        if (onRetry) {
          onRetry(attempt, lastError)
        }

        // 指数退避延迟
        const backoffDelay = delayMs * Math.pow(2, attempt - 1)

        // 等待一段时间后重试
        if (waitBeforeRetry) {
          await new Promise((resolve) => setTimeout(resolve, backoffDelay))
        }
      }
    }
  }

  // 所有重试都失败，抛出最后一个错误
  if (lastError) {
    throw lastError
  } else {
    throw new Error('Retry failed with no error')
  }
}
