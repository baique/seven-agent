import { BaseMessage, AIMessage } from '@langchain/core/messages'
import { CacheContextBuilder } from '../context-builder'
import { readJsonFromFile, writeJsonToFile } from '../../../../utils/json-file-utils'
import { paths } from '../../../../config/env'
import { join } from 'path'
import { logger } from '../../../../utils/logger'

/**
 * SessionNode状态
 */
interface SessionNodeState {
  /** 最新摘要内容 */
  summary: string
  /** 最后处理的消息ID */
  lastMessageId?: string
  /** 扩展属性 - 用于集中存储持久化项 */
  extensions: Record<string, any>
}

/**
 * SessionNode上下文构建器
 * 简化为只保留一个字符串，用于存储最新摘要
 */
export class SessionNodeContextBuilder implements CacheContextBuilder {
  /** 最新摘要内容 */
  public summary: string = ''
  /** 最后处理的消息ID */
  public lastMessageId?: string
  /** 扩展属性 - 用于集中存储持久化项 */
  public extensions: Record<string, any> = {}

  cache(): boolean {
    return false
  }

  /**
   * 更新会话笔记
   * @param notes 新的摘要内容
   * @param lastMessageId 最后处理的消息ID
   */
  async updateSessionNode(notes: string, lastMessageId: string): Promise<void> {
    this.lastMessageId = lastMessageId
    this.summary = notes
    await this.persist()
  }

  /**
   * 设置扩展属性
   * @param key 属性键名
   * @param value 属性值
   */
  async setExtension(key: string, value: any): Promise<void> {
    if (!key || typeof key !== 'string') {
      logger.warn(`[SessionNode] 设置扩展属性失败：key不能为空`)
      return
    }
    this.extensions[key] = value
    await this.persist()
    logger.debug(`[SessionNode] 扩展属性已设置: ${key}`)
  }

  /**
   * 获取扩展属性
   * @param key 属性键名
   * @returns 属性值，不存在时返回undefined
   */
  getExtension(key: string): any {
    if (!key || typeof key !== 'string') {
      return undefined
    }
    return this.extensions[key]
  }

  /**
   * 删除扩展属性
   * @param key 属性键名
   */
  async removeExtension(key: string): Promise<void> {
    if (!key || typeof key !== 'string') {
      return
    }
    if (key in this.extensions) {
      delete this.extensions[key]
      await this.persist()
      logger.debug(`[SessionNode] 扩展属性已删除: ${key}`)
    }
  }

  /**
   * 获取所有扩展属性
   * @returns 所有扩展属性的副本
   */
  getAllExtensions(): Record<string, any> {
    return { ...this.extensions }
  }

  async init(): Promise<void> {
    const state = await readJsonFromFile<SessionNodeState>(
      join(paths.WORKSPACE_ROOT, 'context', 'session.json'),
    )

    this.summary = state.summary || ''
    this.lastMessageId = state.lastMessageId
    this.extensions = state.extensions || {}

    logger.info(
      `[SessionNode] 初始化完成，摘要长度: ${this.summary.length}，扩展属性: ${Object.keys(this.extensions).length}个`,
    )
  }

  async persist(): Promise<void> {
    const state: SessionNodeState = {
      summary: this.summary,
      lastMessageId: this.lastMessageId,
      extensions: this.extensions,
    }
    await writeJsonToFile(join(paths.WORKSPACE_ROOT, 'context', 'session.json'), state)
  }

  /**
   * 构建会话记忆提示词
   * @returns 构建好的提示词字符串，如果没有内容则返回空字符串
   */
  buildSessionMemoryPrompt(): string {
    if (!this.summary || this.summary.trim().length === 0) {
      return ''
    }
    return `[会话记忆]\n${this.summary}`
  }

  async mountToContext(messages: BaseMessage[]): Promise<void> {
    const prompt = this.buildSessionMemoryPrompt()
    if (prompt) {
      messages.push(new AIMessage(prompt))
    }
  }
}

export const SESSION_NODE_CONTEXT = new SessionNodeContextBuilder()
