import { ref } from 'vue'
import type { RawMessage, HistoryLoadParams, HistoryLoadResult } from '../types/message'

/** 历史加载函数类型 */
export type HistoryLoaderFn = (params: HistoryLoadParams) => Promise<HistoryLoadResult>

/**
 * 历史消息加载器
 * 支持分页加载、缓存、加载状态管理
 */
export function useHistoryLoader() {
  /** 是否已加载初始历史 */
  const historyLoaded = ref(false)
  /** 是否正在加载 */
  const historyLoading = ref(false)
  /** 加载错误信息 */
  const historyError = ref<string | null>(null)
  /** 是否还有更多历史 */
  const hasMore = ref(true)
  /** 缓存的历史消息 */
  const cachedHistory = ref<RawMessage[]>([])
  /** 下一页游标 */
  let nextCursor: string | undefined

  /**
   * 加载历史消息
   * @param loaderFn 加载函数
   * @param params 加载参数
   * @returns 加载的消息数组
   */
  async function loadHistory(
    loaderFn: (params: HistoryLoadParams) => Promise<{ history: RawMessage[]; hasMore?: boolean }>,
    params: HistoryLoadParams = {},
  ): Promise<RawMessage[]> {
    console.log(
      '[useHistoryLoader] loadHistory 开始, params:',
      params,
      'historyLoaded:',
      historyLoaded.value,
      'historyLoading:',
      historyLoading.value,
    )

    // 防止重复加载
    if (historyLoading.value) {
      console.log('[useHistoryLoader] 正在加载中，跳过')
      return []
    }

    // 首次加载检查
    if (!params.beforeId && historyLoaded.value) {
      console.log('[useHistoryLoader] 已加载过，跳过')
      return []
    }

    historyLoading.value = true
    historyError.value = null

    try {
      console.log('[useHistoryLoader] 调用 loaderFn...')
      const result = await loaderFn({
        limit: params.limit || 50,
        beforeId: params.beforeId || nextCursor,
      })
      console.log('[useHistoryLoader] loaderFn 返回:', result)

      const messages = result.history || []
      hasMore.value = result.hasMore !== false && messages.length >= (params.limit || 50)

      if (params.beforeId) {
        // 分页加载：追加到缓存头部
        cachedHistory.value = [...messages, ...cachedHistory.value]
      } else {
        // 首次加载
        cachedHistory.value = messages
        historyLoaded.value = true
      }

      // 更新游标
      if (messages.length > 0) {
        nextCursor = messages[0].id
      }

      console.log('[useHistoryLoader] 返回 messages:', messages.length)
      return messages
    } catch (e) {
      historyError.value = e instanceof Error ? e.message : 'Failed to load history'
      console.error('[useHistoryLoader] 加载失败:', e)
      return []
    } finally {
      historyLoading.value = false
    }
  }

  /**
   * 加载更多历史（向上翻页）
   * @param loaderFn 加载函数
   * @param limit 加载数量
   */
  async function loadMore(
    loaderFn: (params: HistoryLoadParams) => Promise<{ history: RawMessage[]; hasMore?: boolean }>,
    limit: number = 50,
  ): Promise<RawMessage[]> {
    if (!hasMore.value || historyLoading.value) {
      return []
    }
    return loadHistory(loaderFn, { limit, beforeId: nextCursor })
  }

  /**
   * 重置加载状态
   */
  function reset(): void {
    historyLoaded.value = false
    historyLoading.value = false
    historyError.value = null
    hasMore.value = true
    cachedHistory.value = []
    nextCursor = undefined
  }

  /**
   * 清空缓存
   */
  function clearCache(): void {
    cachedHistory.value = []
    nextCursor = undefined
    hasMore.value = true
  }

  return {
    historyLoaded,
    historyLoading,
    historyError,
    hasMore,
    cachedHistory,
    loadHistory,
    loadMore,
    reset,
    clearCache,
  }
}
