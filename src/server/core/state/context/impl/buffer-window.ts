import { BaseMessage, ToolMessage } from '@langchain/core/messages'
import { MemoryMessage, GLOBAL_MEMORY } from '../../../../memory'
import { convertToMessages, logger } from '../../../../utils'
import { paths } from '../../../../config/env'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ContextBuilder } from '../context-builder'
import { MessageTokenCounter } from '../../../../utils/message-token-counter'
import { applyRetentionPolicy } from '../../../../utils/tool-response-parser'

const BUFFER_STATE_FILE = 'buffer_state.json'
const DEFAULT_BUFFER_SIZE = 700

interface BufferState {
  messageCount: number
  /** counter中第一条消息的ID，用于重启后恢复counter状态 */
  firstMessageId?: string
}

const getBufferStateFilePath = (): string => {
  return join(paths.WORKSPACE_ROOT, 'context', BUFFER_STATE_FILE)
}

export class BufferWindowContextBuilder implements ContextBuilder {
  private messages: BaseMessage[] = []
  private counter: MessageTokenCounter = new MessageTokenCounter()

  cache(): boolean {
    return false
  }

  async init(): Promise<void> {
    await this.loadFromFile()
  }

  async persist(): Promise<void> {
    this.saveToFile()
  }

  private getBufferState(): BufferState {
    return {
      messageCount: this.messages.length,
      firstMessageId: this.counter.getFirstMessageId(),
    }
  }

  private saveToFile(): void {
    const state = this.getBufferState()
    const filePath = getBufferStateFilePath()
    try {
      writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
      logger.info(`[BufferWindow] 保存状态: messageCount=${state.messageCount}`)
    } catch (error) {
      logger.error({ error }, '[BufferWindow] 保存状态失败')
    }
  }

  private async loadFromFile(): Promise<void> {
    const filePath = getBufferStateFilePath()
    try {
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8')
        const state: BufferState = JSON.parse(content)
        const bufferSize = state.messageCount > 0 ? state.messageCount : DEFAULT_BUFFER_SIZE
        await this.loadMessagesFromMemory(bufferSize)

        // 加载消息后、构建counter之前，应用工具保留策略清理规则
        applyRetentionPolicy(this.messages)

        // 根据firstMessageId找到counter的起始位置
        if (state.firstMessageId) {
          const startIndex = this.messages.findIndex((msg) => msg.id === state.firstMessageId)
          if (startIndex !== -1) {
            this.counter.setMessages(this.messages.slice(startIndex))
          } else {
            // 找不到firstMessageId，使用全部消息
            this.counter.setMessages(this.messages)
          }
        } else {
          // 没有firstMessageId，使用全部消息
          this.counter.setMessages(this.messages)
        }
        const count = this.counter.getCount()
        logger.info(
          `[BufferWindow] 恢复状态: ${this.messages.length}条消息, tokens=${count.totalTokens}, rounds=${count.roundCount}`,
        )
        return
      }
    } catch (error) {
      logger.error({ error }, '[BufferWindow] 加载状态失败')
    }
    // 加载失败时使用默认配置
    await this.loadMessagesFromMemory(DEFAULT_BUFFER_SIZE)
    this.counter = new MessageTokenCounter()
    this.counter.addMessages(this.messages)
  }

  private async loadMessagesFromMemory(bufferSize: number): Promise<void> {
    const recentMessages: MemoryMessage[] =
      await GLOBAL_MEMORY.queryRecentMessagesByLimit(bufferSize)
    const allMessages = convertToMessages(recentMessages)

    while (allMessages.length > 0 && ToolMessage.isInstance(allMessages[0])) {
      allMessages.shift()
    }

    this.messages = allMessages
    // 注意：这里不创建 counter，由调用方负责设置 counter 状态
    logger.info(`[BufferWindow] 从内存加载 ${this.messages.length} 条消息`)
  }

  async mountToContext(messages: BaseMessage[]): Promise<void> {
    messages.push(...this.messages)
  }

  clear(): void {
    this.messages = []
    this.counter = new MessageTokenCounter()
  }

  update(newMessages: BaseMessage[]): void {
    this.messages = newMessages
    this.counter = new MessageTokenCounter()
    this.counter.addMessages(this.messages)
    this.saveToFile()
  }

  append(messages: BaseMessage[]): void {
    this.counter.addMessages(messages)
    this.messages.push(...messages)
    // 保存状态到磁盘，确保重启后能正确恢复轮次和token计数
    this.saveToFile()
  }

  getMessages(): BaseMessage[] {
    return this.messages
  }

  getCounter(): MessageTokenCounter {
    return this.counter
  }

  renewCounter(): MessageTokenCounter {
    const old = this.counter
    this.counter = new MessageTokenCounter()
    // 保存重置后的状态到磁盘，确保重启后不会恢复旧的轮次
    this.saveToFile()
    return old
  }
}

export const BUFFER_WINDOW_CONTEXT = new BufferWindowContextBuilder()
