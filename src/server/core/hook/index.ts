/**
 * Hook管理模块 - 提供发布订阅模式的Hook系统
 *
 * 使用方式：
 * ```typescript
 * import { hooks, hookManager, HookType } from './hook'
 *
 * // 订阅Hook
 * const id = hooks.beforeRequest(({ socket, message, requestId }) => {
 *   console.log(`请求开始: ${requestId}`)
 * })
 *
 * // 取消订阅
 * hookManager.off(HookType.BEFORE_REQUEST, id)
 *
 * // 订阅特定工具的Hook
 * hooks.beforeSpecificToolCall('read_file', ({ toolName, toolArgs }) => {
 *   console.log(`即将调用 ${toolName}`, toolArgs)
 * })
 * ```
 *
 * 系统Hook：
 * 需要在server启动时调用 registerSystemHooks() 注册
 */

import BeforeLLMConsumeBuffer from './before-llm-consume-buffer'
import AfterLLMStatsLogger from './after-llm-stats-logger'
import AutoInsertTimeGap from './auto-insert-time-gap'
import BeforeRequestRetentionPolicy from './before-request-retention-policy'
import AfterToolCallPersonalityUpdate from './after-tool-call-personality-update'
import AfterToolCallTerminal from './after-tool-call-terminal'
import AfterToolCallTask from './after-tool-call-task'
import AfterSummary from './after-summary'
import type { MessagesState } from '../state/llm-state'

export { hookManager, hooks, HookManager } from './hook-manager'
export { HookType } from './types'
export type { HookTypeString } from './hook-manager'
export type {
  SessionInfo,
  BeforeRequestParams,
  AfterRequestParams,
  BeforeUserMessageParams,
  AfterUserMessageParams,
  BeforeLLMParams,
  AfterLLMParams,
  BeforeToolCallParams,
  AfterToolCallParams,
  BeforeSummaryParams,
  AfterSummaryParams,
  HookHandler,
} from './types'

import { hooks } from './hook-manager'

/**
 * 注册系统级Hook
 * 在server启动时调用，用于注册内置的系统Hook
 */
export function registerSystemHooks(): void {
  hooks.beforeRequest(() => {
    BeforeRequestRetentionPolicy()
  })

  hooks.beforeLLM(({ state }) => {
    AutoInsertTimeGap(state as typeof MessagesState.State)
    BeforeLLMConsumeBuffer(state as typeof MessagesState.State)
  })

  hooks.afterLLM((params) => {
    AfterLLMStatsLogger(params)
  })

  hooks.afterToolCall((params) => {
    AfterToolCallPersonalityUpdate(params)
    AfterToolCallTerminal(params)
    AfterToolCallTask(params)
  })

  hooks.afterSummary((params) => {
    AfterSummary(params)
  })
}
