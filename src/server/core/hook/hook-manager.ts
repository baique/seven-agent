import { logger } from '../../utils/logger'
import {
  HookType,
  type HookHandler,
  type BeforeRequestParams,
  type AfterRequestParams,
  type BeforeUserMessageParams,
  type AfterUserMessageParams,
  type BeforeLLMParams,
  type AfterLLMParams,
  type BeforeToolCallParams,
  type AfterToolCallParams,
  type BeforeSummaryParams,
  type AfterSummaryParams,
} from './types'

/** Hook类型字符串字面量类型 */
export type HookTypeString = `${HookType}`

/**
 * Hook订阅信息
 */
interface HookSubscription<T> {
  /** 订阅ID */
  id: string
  /** 处理函数 */
  handler: HookHandler<T>
  /** 是否只执行一次 */
  once: boolean
}

/**
 * Hook管理器 - 提供发布订阅模式的Hook系统
 *
 * 职责：
 * 1. 管理各类Hook的订阅和取消订阅
 * 2. 按顺序触发Hook（通用Hook先执行，具体Hook后执行）
 * 3. 支持同步和异步Hook处理函数
 * 4. 支持一次性Hook（once）
 */
export class HookManager {
  /** Hook订阅映射表 */
  private hooks: Map<HookType, HookSubscription<unknown>[]> = new Map()
  /** 工具特定Hook订阅映射表（工具名称 -> HookType -> 订阅列表） */
  private toolHooks: Map<string, Map<HookType, HookSubscription<unknown>[]>> = new Map()
  /** 订阅ID计数器 */
  private subscriptionIdCounter = 0

  constructor() {
    // 初始化所有Hook类型的空数组
    Object.values(HookType).forEach((type) => {
      this.hooks.set(type, [])
    })
  }

  /**
   * 生成唯一订阅ID
   */
  private generateId(): string {
    return `hook_${++this.subscriptionIdCounter}_${Date.now()}`
  }

  /**
   * 订阅Hook
   * @param type Hook类型
   * @param handler 处理函数
   * @returns 订阅ID，用于取消订阅
   */
  on<T>(type: HookType, handler: HookHandler<T>): string {
    const id = this.generateId()
    const subscriptions = this.hooks.get(type) || []
    subscriptions.push({
      id,
      handler: handler as HookHandler<unknown>,
      once: false,
    })
    this.hooks.set(type, subscriptions)
    return id
  }

  /**
   * 订阅一次性Hook
   * @param type Hook类型
   * @param handler 处理函数
   * @returns 订阅ID，用于取消订阅
   */
  once<T>(type: HookType, handler: HookHandler<T>): string {
    const id = this.generateId()
    const subscriptions = this.hooks.get(type) || []
    subscriptions.push({
      id,
      handler: handler as HookHandler<unknown>,
      once: true,
    })
    this.hooks.set(type, subscriptions)
    return id
  }

  /**
   * 取消订阅
   * @param type Hook类型
   * @param id 订阅ID
   */
  off(type: HookType, id: string): void {
    const subscriptions = this.hooks.get(type)
    if (!subscriptions) return

    const index = subscriptions.findIndex((sub) => sub.id === id)
    if (index !== -1) {
      subscriptions.splice(index, 1)
    }
  }

  /**
   * 订阅工具特定Hook
   * @param toolName 工具名称
   * @param type Hook类型（BEFORE_TOOL_CALL 或 AFTER_TOOL_CALL）
   * @param handler 处理函数
   * @returns 订阅ID
   */
  onToolHook<T extends BeforeToolCallParams | AfterToolCallParams>(
    toolName: string,
    type: HookType.BEFORE_TOOL_CALL | HookType.AFTER_TOOL_CALL,
    handler: HookHandler<T>,
  ): string {
    const id = this.generateId()

    if (!this.toolHooks.has(toolName)) {
      this.toolHooks.set(toolName, new Map())
    }

    const toolHookMap = this.toolHooks.get(toolName)!
    if (!toolHookMap.has(type)) {
      toolHookMap.set(type, [])
    }

    const subscriptions = toolHookMap.get(type)!
    subscriptions.push({
      id,
      handler: handler as HookHandler<unknown>,
      once: false,
    })

    return id
  }

  /**
   * 取消工具特定Hook订阅
   * @param toolName 工具名称
   * @param type Hook类型
   * @param id 订阅ID
   */
  offToolHook(toolName: string, type: HookType, id: string): void {
    const toolHookMap = this.toolHooks.get(toolName)
    if (!toolHookMap) return

    const subscriptions = toolHookMap.get(type)
    if (!subscriptions) return

    const index = subscriptions.findIndex((sub) => sub.id === id)
    if (index !== -1) {
      subscriptions.splice(index, 1)
    }
  }

  /**
   * 触发Hook
   * @param type Hook类型
   * @param params 参数
   */
  async emit<T>(type: HookType | HookTypeString, params: T): Promise<void> {
    const subscriptions = this.hooks.get(type as HookType)
    if (!subscriptions || subscriptions.length === 0) return

    // 收集需要移除的一次性订阅
    const toRemove: string[] = []

    for (const sub of subscriptions) {
      try {
        await sub.handler(params)
        if (sub.once) {
          toRemove.push(sub.id)
        }
      } catch (error) {
        logger.error(
          { error, hookType: type, subscriptionId: sub.id },
          '[HookManager] Hook执行失败',
        )
      }
    }

    // 移除一次性订阅
    if (toRemove.length > 0) {
      const remaining = subscriptions.filter((sub) => !toRemove.includes(sub.id))
      this.hooks.set(type as HookType, remaining)
    }
  }

  /**
   * 触发工具Hook（通用Hook先执行，具体工具Hook后执行）
   * @param type Hook类型
   * @param params 参数（包含toolName）
   */
  async emitToolHook<T extends BeforeToolCallParams | AfterToolCallParams>(
    type:
      | HookType.BEFORE_TOOL_CALL
      | HookType.AFTER_TOOL_CALL
      | `${HookType.BEFORE_TOOL_CALL}`
      | `${HookType.AFTER_TOOL_CALL}`,
    params: T,
  ): Promise<void> {
    // 1. 先执行通用Hook
    await this.emit(type, params)

    // 2. 再执行工具特定Hook
    const { toolName } = params
    const toolHookMap = this.toolHooks.get(toolName)
    if (!toolHookMap) return

    const hookType = type as HookType.BEFORE_TOOL_CALL | HookType.AFTER_TOOL_CALL
    const subscriptions = toolHookMap.get(hookType)
    if (!subscriptions || subscriptions.length === 0) return

    const toRemove: string[] = []

    for (const sub of subscriptions) {
      try {
        await sub.handler(params)
        if (sub.once) {
          toRemove.push(sub.id)
        }
      } catch (error) {
        logger.error(
          { error, hookType: type, toolName, subscriptionId: sub.id },
          '[HookManager] 工具特定Hook执行失败',
        )
      }
    }

    // 移除一次性订阅
    if (toRemove.length > 0) {
      const remaining = subscriptions.filter((sub) => !toRemove.includes(sub.id))
      toolHookMap.set(hookType, remaining)
    }
  }

  /**
   * 清除所有Hook订阅
   */
  clearAll(): void {
    this.hooks.clear()
    this.toolHooks.clear()
    Object.values(HookType).forEach((type) => {
      this.hooks.set(type, [])
    })
    logger.info('[HookManager] 已清除所有Hook订阅')
  }

  /**
   * 清除指定类型的所有Hook订阅
   * @param type Hook类型
   */
  clear(type: HookType): void {
    this.hooks.set(type, [])
    logger.info(`[HookManager] 已清除 ${type} 类型的所有Hook订阅`)
  }

  /**
   * 获取指定类型的订阅数量
   * @param type Hook类型
   * @returns 订阅数量
   */
  getSubscriptionCount(type: HookType): number {
    const subscriptions = this.hooks.get(type)
    return subscriptions?.length || 0
  }

  /**
   * 获取工具特定Hook的订阅数量
   * @param toolName 工具名称
   * @param type Hook类型
   * @returns 订阅数量
   */
  getToolHookSubscriptionCount(toolName: string, type: HookType): number {
    const toolHookMap = this.toolHooks.get(toolName)
    if (!toolHookMap) return 0
    const subscriptions = toolHookMap.get(type)
    return subscriptions?.length || 0
  }
}

/** HookManager全局单例 */
export const hookManager = new HookManager()

/**
 * 便捷的Hook订阅函数
 */
export const hooks = {
  /**
   * 订阅请求开始前Hook
   */
  beforeRequest: (handler: HookHandler<BeforeRequestParams>) =>
    hookManager.on(HookType.BEFORE_REQUEST, handler),

  /**
   * 订阅请求结束后Hook
   */
  afterRequest: (handler: HookHandler<AfterRequestParams>) =>
    hookManager.on(HookType.AFTER_REQUEST, handler),

  /**
   * 订阅用户消息处理前Hook
   */
  beforeUserMessage: (handler: HookHandler<BeforeUserMessageParams>) =>
    hookManager.on(HookType.BEFORE_USER_MESSAGE, handler),

  /**
   * 订阅用户消息处理后Hook
   */
  afterUserMessage: (handler: HookHandler<AfterUserMessageParams>) =>
    hookManager.on(HookType.AFTER_USER_MESSAGE, handler),

  /**
   * 订阅LLM调用前Hook
   */
  beforeLLM: (handler: HookHandler<BeforeLLMParams>) =>
    hookManager.on(HookType.BEFORE_LLM, handler),

  /**
   * 订阅LLM调用后Hook
   */
  afterLLM: (handler: HookHandler<AfterLLMParams>) => hookManager.on(HookType.AFTER_LLM, handler),

  /**
   * 订阅工具调用前Hook（通用）
   */
  beforeToolCall: (handler: HookHandler<BeforeToolCallParams>) =>
    hookManager.on(HookType.BEFORE_TOOL_CALL, handler),

  /**
   * 订阅工具调用后Hook（通用）
   */
  afterToolCall: (handler: HookHandler<AfterToolCallParams>) =>
    hookManager.on(HookType.AFTER_TOOL_CALL, handler),

  /**
   * 订阅特定工具调用前Hook
   */
  beforeSpecificToolCall: (toolName: string, handler: HookHandler<BeforeToolCallParams>) =>
    hookManager.onToolHook(toolName, HookType.BEFORE_TOOL_CALL, handler),

  /**
   * 订阅特定工具调用后Hook
   */
  afterSpecificToolCall: (toolName: string, handler: HookHandler<AfterToolCallParams>) =>
    hookManager.onToolHook(toolName, HookType.AFTER_TOOL_CALL, handler),

  /**
   * 订阅摘要发生前Hook
   */
  beforeSummary: (handler: HookHandler<BeforeSummaryParams>) =>
    hookManager.on(HookType.BEFORE_SUMMARY, handler),

  /**
   * 订阅摘要发生后Hook
   */
  afterSummary: (handler: HookHandler<AfterSummaryParams>) =>
    hookManager.on(HookType.AFTER_SUMMARY, handler),
}
