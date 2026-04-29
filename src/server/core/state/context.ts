// 上下文

import { AIMessage, BaseMessage } from '@langchain/core/messages'
import { ContextBuilder } from './context/context-builder'
import { SYSTEM } from './context/impl/system'
import { TASK_CONTEXT } from './context/impl/task'
import { SESSION_NODE_CONTEXT } from './context/impl/session-node'
import { BUFFER_WINDOW_CONTEXT } from './context/impl/buffer-window'
import { STATE_CONTEXT } from './context/impl/character-state'
import { SKILL_CONTEXT } from './context/impl/skill-context'
import { MessageTokenCounter } from '../../utils/message-token-counter'

/**
 * Context 上下文状态统计信息
 * key 为 ContextBuilder 子类的类名，value 为该层生成的 token 数量
 */
export type ContextStateStats = Record<string, number>

/**
 * Context 统计详情
 */
export interface ContextStats {
  /** 上下文各层 token 统计 */
  state: ContextStateStats
  /** LLM 返回的原始 usage（包含 elapsedMs） */
  usage?: Record<string, unknown>
}

/**
 * 兼容历史消息中的 create_task 工具调用参数
 * DeepSeek API 要求 tool schema 必须为 type: "object"，但历史消息可能是数组格式
 * 此函数将旧格式转换为新格式
 * @param messages 消息列表
 * @returns 处理后的消息列表
 */
function compatHistoryToolCalls(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((msg) => {
    // 只处理 AI 消息且有 tool_calls 的情况
    if (!AIMessage.isInstance(msg) || !msg.tool_calls || msg.tool_calls.length === 0) {
      return msg
    }

    const updatedToolCalls = msg.tool_calls.map((tc) => {
      // 只处理 create_task 工具
      if (tc.name !== 'create_task' || !tc.args) {
        return tc
      }

      const args = tc.args as Record<string, unknown>

      // 如果已经是新格式（有 name 或 tasks 字段），不需要转换
      if (args.name !== undefined || args.tasks !== undefined) {
        return tc
      }

      // 旧格式：直接是任务对象（有 name 和 description 但没有 tasks）
      if (args.name !== undefined && args.description !== undefined) {
        // 已经是对象格式，但需要包装成标准格式
        return {
          ...tc,
          args: {
            name: args.name,
            description: args.description,
            parentId: args.parentId,
            deadline: args.deadline,
            order: args.order,
          },
        }
      }

      // 旧格式：数组（历史消息中存储的数组格式）
      // 这种情况下 args 的 key 可能是 "0", "1" 这样的数字字符串
      const keys = Object.keys(args)
      if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
        const tasks = keys
          .sort((a, b) => parseInt(a) - parseInt(b))
          .map((k) => args[k])
          .filter((item) => item && typeof item === 'object' && 'name' in item)

        if (tasks.length > 0) {
          return {
            ...tc,
            args: { tasks },
          }
        }
      }

      return tc
    })

    // 如果有修改，创建新的 AIMessage
    if (JSON.stringify(updatedToolCalls) !== JSON.stringify(msg.tool_calls)) {
      return new AIMessage({
        content: msg.content,
        tool_calls: updatedToolCalls,
        additional_kwargs: msg.additional_kwargs,
        id: msg.id,
      })
    }

    return msg
  })
}

export class Context {
  private _contextCache: Record<string, BaseMessage[]> = {}
  private _rawUsage?: Record<string, unknown>
  private contextBuilder: ContextBuilder[]

  constructor() {
    // 延迟初始化 contextBuilder，避免循环依赖问题
    this.contextBuilder = [
      SYSTEM.SYSTEM_CONTEXT,
      SKILL_CONTEXT,
      SYSTEM.DAY_SUMMARY_CONTEXT,
      SYSTEM.LONG_MEMORY_CONTEXT,
      STATE_CONTEXT,
      TASK_CONTEXT,
      SESSION_NODE_CONTEXT,
      BUFFER_WINDOW_CONTEXT,
    ]
  }

  public async init() {
    await this.contextBuilder.forEach((builder) => builder.init())
  }

  public async persistContext(): Promise<void> {
    await this.contextBuilder.forEach((builder) => builder.persist())
  }

  /**
   * 构建完整消息上下文
   * @param messages  消息列表
   * @returns  完整消息上下文
   */
  public async createMessageContext(messages: BaseMessage[]): Promise<BaseMessage[]> {
    const fullMessages: BaseMessage[] = []

    for (const inst of this.contextBuilder) {
      const typeName = inst.constructor.name
      const beginLength = fullMessages.length

      if ('cache' in inst && typeof inst.cache === 'function' && inst.cache()) {
        const cachedMessages = this._contextCache[typeName]
        if (cachedMessages && cachedMessages.length > 0) {
          fullMessages.push(...cachedMessages)
        } else {
          await inst.mountToContext(fullMessages)
        }
      } else {
        await inst.mountToContext(fullMessages)
      }
      this._contextCache[typeName] = fullMessages.slice(beginLength)
    }

    fullMessages.push(...messages)

    // 兼容历史消息中的工具调用参数格式
    const result = compatHistoryToolCalls(fullMessages)

    return result
  }

  /**
   * 设置 LLM 返回的原始 usage
   * @param usage  LLM 返回的 usage_metadata（包含 elapsedMs）
   */
  public setRawUsage(usage?: Record<string, unknown>): void {
    this._rawUsage = usage
  }

  /**
   * 获取 LLM 返回的原始 usage
   * @returns LLM 返回的 usage_metadata 或 undefined
   */
  public getRawUsage(): Record<string, unknown> | undefined {
    return this._rawUsage
  }

  /**
   * 获取上下文统计信息
   * @returns  统计信息，包含 state（各层 token 统计）和 usage（LLM 返回的 usage）
   */
  public getContextDetails(): ContextStats {
    const contentState: ContextStateStats = {}
    for (const key in this._contextCache) {
      const messages = this._contextCache[key]
      if (messages) {
        contentState[key] = MessageTokenCounter.countMessages(messages)
      } else {
        contentState[key] = 0
      }
    }
    return {
      state: contentState,
      usage: this._rawUsage,
    }
  }

  /**
   * 清空缓存
   */
  public refresh() {
    // 清空缓存
    this._contextCache = {}
  }
}

// 延迟初始化 CTX，避免循环依赖问题
export const CTX = new Context()
