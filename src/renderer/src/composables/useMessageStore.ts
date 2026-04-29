import { ref, onUnmounted, nextTick } from 'vue'
import { eventBus, Events } from '../eventBus'
import { defineStore } from 'pinia'
import { MessageProcessor } from './MessageProcessor'
import type { Message, RawMessage } from '../types/message'

export type { Message, RawMessage } from '../types/message'

/** Buffer消息类型 */
export interface BufferMessage {
  id: string
  content: string
  timestamp: number
}

export const useMessageStore = defineStore('message', () => {
  /** 历史消息列表 */
  const historyMessages = ref<Message[]>([])
  /** 当前会话消息列表 */
  const messages = ref<Message[]>([])
  /** 加载状态 */
  const loading = ref(false)
  /** 取消状态 */
  const cancelled = ref(false)
  /** 摘要状态消息 */
  const summaryMessage = ref<Message | null>(null)
  /** Buffer消息（最多一条） */
  const bufferMessage = ref<BufferMessage | null>(null)

  /**
   * 滚动到底部函数
   * 返回 boolean 表示是否执行了滚动（由组件根据 isAtBottom 判断）
   */
  let scrollToBottomFn: (() => boolean) | null = null

  /** 实时消息处理器实例 */
  const processor = new MessageProcessor()

  /** 待处理消息队列 */
  let pendingMessages: RawMessage[] = []
  let updateScheduled = false

  const unsubscribers: (() => void)[] = []

  // 注册事件监听
  unsubscribers.push(
    eventBus.on(Events.MESSAGE_STREAM, ({ data }: { requestId: string; data: RawMessage }) => {
      console.log('收到消息', data)
      // 如果是用户消息且有对应的buffer消息，移除buffer
      if (data.type === 'human' && bufferMessage.value && bufferMessage.value.id === data.id) {
        bufferMessage.value = null
      }
      queueMessageUpdate(data)
    }),
  )

  const loadingIdStack: string[] = []
  unsubscribers.push(
    eventBus.on(Events.REQUEST_START, (data: { requestId: string }) => {
      loadingIdStack.push(data.requestId)
      loading.value = true
    }),
  )

  unsubscribers.push(
    eventBus.on(Events.REQUEST_COMPLETE, (data: { requestId: string }) => {
      const index = loadingIdStack.findIndex((id) => id === data.requestId)
      if (index !== -1) {
        loadingIdStack.splice(index, 1)
      }

      if (loadingIdStack.length === 0) {
        loading.value = false
        cancelled.value = false
        processor.clearStreamBuffer()
      }
      scrollToBottomFn?.()
    }),
  )

  unsubscribers.push(
    eventBus.on(Events.MESSAGE_COMPLETE, () => {
      scrollToBottomFn?.()
    }),
  )

  unsubscribers.push(
    eventBus.on(Events.MESSAGE_ERROR, (_msg: string) => {
      loading.value = false
      cancelled.value = false
    }),
  )

  unsubscribers.push(
    eventBus.on(Events.MESSAGE_CANCELLED, () => {
      cancelled.value = true
    }),
  )

  unsubscribers.push(
    eventBus.on(Events.SUMMARY_START, (data: { beforeTokens: number }) => {
      summaryMessage.value = {
        id: 'summary-status',
        type: 'system',
        content: `正在压缩上下文... (${data.beforeTokens} tokens)`,
        status: 'loading',
      }
      scrollToBottomFn?.()
    }),
  )

  unsubscribers.push(
    eventBus.on(
      Events.SUMMARY_COMPLETE,
      (data: { beforeTokens: number; afterTokens: number; savedTokens: number }) => {
        if (summaryMessage.value) {
          summaryMessage.value.content = `上下文压缩完成，节省 ${data.savedTokens} tokens`
          summaryMessage.value.status = 'success'
          setTimeout(() => {
            summaryMessage.value = null
          }, 5000)
        }
      },
    ),
  )

  // Buffer消息相关事件
  unsubscribers.push(
    eventBus.on(
      Events.BUFFER_MESSAGE_ADDED,
      (data: { id: string; content: string; timestamp: number }) => {
        bufferMessage.value = {
          id: data.id,
          content: data.content,
          timestamp: data.timestamp,
        }
      },
    ),
  )

  unsubscribers.push(
    eventBus.on(Events.BUFFER_MESSAGE_CANCELLED, (data: { id: string }) => {
      // Buffer消息被取消
      if (bufferMessage.value && bufferMessage.value.id === data.id) {
        bufferMessage.value = null
      }
    }),
  )

  /**
   * 将消息加入待处理队列
   */
  function queueMessageUpdate(data: RawMessage) {
    pendingMessages.push(data)
    if (updateScheduled) return
    updateScheduled = true
    nextTick(() => {
      processPendingUpdates()
      updateScheduled = false
    })
  }

  /**
   * 处理待处理消息队列
   */
  function processPendingUpdates() {
    let hasStreamingMessage = false

    // 预处理：先遍历所有消息，提取AI消息中的toolCalls建立args映射
    // 这样即使Tool消息在AI消息之前处理，也能获取到args
    for (const data of pendingMessages) {
      if (data.type === 'ai' && data.toolCalls && data.toolCalls.length > 0) {
        for (const tc of data.toolCalls) {
          const id = tc.id || tc.tool_call_id || ''
          if (id && tc.args) {
            // 预先注册toolCall到processor，确保后续Tool消息能找到args
            processor.preRegisterToolCall(id, tc.name || 'unknown', tc.args)
          }
        }
      }
    }

    for (const data of pendingMessages) {
      const result = processor.processMessage(data)
      if (result.message) {
        if (result.isUpdate && result.updateId) {
          // 更新已有消息 - 使用替换方式触发响应式更新
          const idx = messages.value.findIndex((m) => m.id === result.updateId)
          if (idx !== -1) {
            messages.value[idx] = { ...result.message }
          }
          // 标记是否为流式消息更新
          if (result.message.status === 'streaming') {
            hasStreamingMessage = true
          }
        } else {
          // 添加新消息
          messages.value.push(result.message)
        }
      }
    }
    // 流式消息时使用更频繁的滚动更新
    if (hasStreamingMessage) {
      // 使用 requestAnimationFrame 确保流畅的滚动跟随
      requestAnimationFrame(() => {
        scrollToBottomFn?.()
      })
    } else {
      scrollToBottomFn?.()
    }
    pendingMessages = []
  }

  /**
   * 加载历史消息（首次加载）
   * @param history 历史消息数组
   */
  function loadHistory(history: RawMessage[]) {
    console.log('[useMessageStore] loadHistory 调用, history:', history?.length)
    if (history?.length > 0) {
      // 使用独立的处理器处理历史消息
      const historyProcessor = new MessageProcessor()
      const processed = historyProcessor.processMessages(history)
      console.log('[useMessageStore] processed:', processed.length, processed)
      historyMessages.value = processed
      console.log('[useMessageStore] historyMessages.value 已更新:', historyMessages.value.length)
      // 使用多次 nextTick 确保虚拟列表完全渲染后再滚动
      nextTick(() => {
        nextTick(() => {
          scrollToBottomFn?.()
        })
      })
    }
  }

  /**
   * 追加历史消息到头部（分页加载）
   * @param history 历史消息数组
   */
  function prependHistory(history: RawMessage[]) {
    if (history?.length > 0) {
      // 使用独立的处理器处理历史消息
      const historyProcessor = new MessageProcessor()
      const processed = historyProcessor.processMessages(history)
      historyMessages.value = [...processed, ...historyMessages.value]
    }
  }

  /**
   * 添加消息
   */
  function addMessage(msg: Message) {
    messages.value.push(msg)
  }

  /**
   * 清空消息
   */
  function clearMessages() {
    messages.value = []
    historyMessages.value = []
    bufferMessage.value = null
    processor.reset()
  }

  /**
   * 取消buffer消息
   * @param messageId 消息ID
   */
  function cancelBufferMessage(messageId: string) {
    // 通过eventBus触发，由useSocket处理实际的socket发送
    eventBus.emit(Events.MESSAGE_COMMAND, {
      command: 'cancel_buffer',
      data: { messageId },
    })
  }

  /**
   * 设置滚动到底部函数
   * @param fn 返回 boolean 表示是否执行了滚动，组件根据 isAtBottom 判断是否滚动
   */
  function setScrollToBottom(fn: () => boolean) {
    scrollToBottomFn = fn
  }

  /**
   * 设置加载状态
   */
  function setLoading(value: boolean) {
    loading.value = value
  }

  /**
   * 滚动到底部
   */
  function scrollToBottom() {
    scrollToBottomFn?.()
  }

  onUnmounted(() => {
    unsubscribers.forEach((unsub) => unsub())
  })

  return {
    historyMessages,
    messages,
    loading,
    cancelled,
    summaryMessage,
    bufferMessage,
    addMessage,
    loadHistory,
    prependHistory,
    clearMessages,
    cancelBufferMessage,
    setScrollToBottom,
    setLoading,
    scrollToBottom,
  }
})
