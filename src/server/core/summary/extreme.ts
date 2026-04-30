import { ToolMessage, AIMessage, BaseMessage } from '@langchain/core/messages'
import { BUFFER_WINDOW_CONTEXT } from '../state/context/impl/buffer-window'
import { logger } from '../../utils/logger'
import { configManager } from '../../config/env'
import { splitToolResponse, applyRetentionPolicy } from '../../utils/tool-response-parser'
import { MessageTokenCounter } from '../../utils/message-token-counter'
import { processSessionMessages, waitAllQueue } from '.'
import { CTX } from '../state/context'
import { SESSION_NODE_CONTEXT } from '../state/context/impl/session-node'
import { hookManager } from '../hook'

/**
 * 获取需要保护的消息索引（最后一个AIMessage的位置）
 * 返回最后一个AIMessage的索引，如果没有则返回-1
 * 清理时应只处理该索引之前的消息
 */
const getProtectedMessageIndex = (messages: BaseMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (AIMessage.isInstance(messages[i])) {
      return i
    }
  }
  return -1
}

/**
 * Level 1：应用工具保留策略清理rawBody
 * 只处理传入的消息列表（已排除本轮消息）
 * 直接修改原msg对象的content（与BufferMessage共享引用，修改即同步）
 * @param messagesToClean 需要清理的消息列表（已裁剪，不含本轮消息）
 * @returns 清理后减少的token数
 */
const cleanupLowValueToolResults = (messagesToClean: BaseMessage[]): number => {
  const tokensBefore = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())

  const cleaned = applyRetentionPolicy(messagesToClean)

  if (cleaned) {
    const tokensAfter = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
    const reduced = tokensBefore - tokensAfter
    logger.info(`[极限压缩-L1] 应用工具保留策略清理rawBody，减少token: ${reduced}`)
    return reduced
  }
  return 0
}

/**
 * Level 2：清理所有工具返回的rawBody
 * 只处理传入的消息列表（已排除本轮消息）
 * 保留json元数据，移除所有rawBody
 * 直接修改原msg对象的content（与BufferMessage共享引用，修改即同步）
 * @param messagesToClean 需要清理的消息列表（已裁剪，不含本轮消息）
 * @returns 清理后减少的token数
 */
const cleanupAllToolResults = (messagesToClean: BaseMessage[]): number => {
  const tokensBefore = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
  let modified = false

  for (const msg of messagesToClean) {
    if (!ToolMessage.isInstance(msg)) continue

    const content = typeof msg.content === 'string' ? msg.content : ''
    const { json, rawBody } = splitToolResponse(content)

    if (!rawBody) continue

    modified = true
    // 直接修改原对象（不新建ToolMessage，共享引用自动同步）
    msg.content = json
  }

  if (modified) {
    const tokensAfter = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
    const reduced = tokensBefore - tokensAfter
    logger.info(`[极限压缩-L2] 清理所有工具rawBody（保护本轮），减少token: ${reduced}`)
    return reduced
  }
  return 0
}

/**
 * 触发极限压缩完成hook
 */
const emitExtremeCompressionHook = (beforeTokens: number, afterTokens: number): void => {
  const savedTokens = beforeTokens - afterTokens
  const messageCounter = new MessageTokenCounter()
  const messages = BUFFER_WINDOW_CONTEXT.getMessages()
  for (const msg of messages) {
    messageCounter.addMessage(msg)
  }
  hookManager.emit('afterSummary' as const, {
    messageCounter,
    sessionInfo: {
      summary: SESSION_NODE_CONTEXT.summary,
      lastMessageId: SESSION_NODE_CONTEXT.lastMessageId || '',
    },
    summaryResult: {
      notes: SESSION_NODE_CONTEXT.summary,
      taskSkillBindings: [],
      rememberOperations: [],
      sceneBoundary: undefined,
    },
    beforeTokens,
    afterTokens,
    savedTokens,
  })
}

/**
 * 处理极限上下文压缩（三级渐进）
 * Level 1: 清理低价值工具rawBody
 * Level 2: 清理所有工具rawBody
 * Level 3: 截断消息历史，保留sessionNotes + 尾部窗口
 * 每级之间检查是否已满足阈值，避免过度清理
 * @param force 是否强制执行，跳过阈值检查
 * @returns 是否执行了压缩
 */
export const handleExtremeContext = async (force?: boolean): Promise<boolean> => {
  const totalTokens = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
  const extremeThreshold = configManager.get('EXTREME_THRESHOLD')

  if (!force && totalTokens <= extremeThreshold) return false

  if (force) {
    logger.warn(`[极限压缩] 强制执行，当前token: ${totalTokens}`)
  } else {
    logger.warn(`[极限压缩] token ${totalTokens} 超过阈值 ${extremeThreshold}`)
  }

  // 等待所有待处理摘要完成
  await waitAllQueue()

  // 目标：压缩到阈值的30%
  const targetTokens = Math.floor(extremeThreshold * 0.3)

  // 获取所有消息并计算保护位置（最后一个AIMessage之前的消息可以清理）
  const allMessages = BUFFER_WINDOW_CONTEXT.getMessages()
  const protectedIndex = getProtectedMessageIndex(allMessages)
  const messagesToClean = protectedIndex >= 0 ? allMessages.slice(0, protectedIndex) : allMessages

  // Level 1: 清理低价值工具rawBody
  cleanupLowValueToolResults(messagesToClean)
  let currentTokens = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
  logger.info(`[极限压缩] L1后token: ${currentTokens}`)
  if (currentTokens <= targetTokens) {
    emitExtremeCompressionHook(totalTokens, currentTokens)
    return true
  }

  // Level 2: 清理所有工具rawBody
  cleanupAllToolResults(messagesToClean)
  currentTokens = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
  logger.info(`[极限压缩] L2后token: ${currentTokens}`)
  if (currentTokens <= targetTokens) {
    emitExtremeCompressionHook(totalTokens, currentTokens)
    return true
  }

  // Level 3: 截断消息历史
  const messages = BUFFER_WINDOW_CONTEXT.getMessages()
  const { selected: trimmedMessages, remaining: removedMessages } = MessageTokenCounter.truncate(
    messages,
    targetTokens,
    'end',
  )

  // 对被截断的未摘要消息进行紧急摘要
  const lastProcessMsgIndex = removedMessages.findIndex(
    (msg) => msg.id === SESSION_NODE_CONTEXT.lastMessageId,
  )
  if (lastProcessMsgIndex < removedMessages.length) {
    const afterLastProcessMsgs = removedMessages.slice(lastProcessMsgIndex + 1)
    if (afterLastProcessMsgs.length > 0) {
      logger.info(`[极限压缩-L3] 紧急摘要 ${afterLastProcessMsgs.length} 条未摘要消息`)
      await processSessionMessages(afterLastProcessMsgs)
      await waitAllQueue()
    }
  }

  CTX.refresh()
  BUFFER_WINDOW_CONTEXT.update(trimmedMessages)
  BUFFER_WINDOW_CONTEXT.renewCounter()

  const finalTokens = MessageTokenCounter.countMessages(BUFFER_WINDOW_CONTEXT.getMessages())
  logger.info(`[极限压缩] L3后token: ${finalTokens}`)

  emitExtremeCompressionHook(totalTokens, finalTokens)

  return true
}
